import type { ArrApi, ReleaseCandidate } from '../../arr/types.js';
import type { AppContext } from '../../context.js';
import type { JobRow } from '../../jobs/queue.js';
import { pickRelease } from './pick.js';
import { pinReleaseGroup } from './pin.js';
import { prefilter, type DroppedCandidate } from './prefilter.js';

type AcquireStatus = 'no-candidates' | 'none-viable' | 'grabbed';

interface RecordOutcomeInput {
  status: AcquireStatus;
  pickedGuid?: string;
  releaseGroup?: string | null;
  reasoning?: string;
  kept: ReleaseCandidate[];
  dropped: DroppedCandidate[];
}

/**
 * Runs one acquire job end-to-end: search the arr for releases, prefilter deterministically,
 * ask the LLM to pick one (or declare none viable), grab the pick, and — for a Sonarr series
 * with a known release group — pin that group to the series so future episodes keep matching
 * it. "No candidates" and "none viable" are expected, normal outcomes, not failures: each is
 * recorded in `acquire_records` and raised as an `attention` event so it surfaces on the
 * dashboard, and the job still completes successfully. Only genuinely unexpected failures
 * (unknown arr instance, an arr API error, a picked guid that vanished) throw, which
 * `startRunner` turns into a job failure via `queue.fail`.
 *
 * Phase 1 searches a whole series at once (`{seriesId}`, no per-season search) and a whole
 * movie (`{movieId}`).
 */
export async function runAcquireJob(ctx: AppContext, job: JobRow): Promise<void> {
  const client = ctx.clients.get(job.arr_instance);
  if (!client) {
    throw new Error(`No arr client configured for instance "${job.arr_instance}"`);
  }

  const title = await resolveTitle(client, job);
  const raw = await client.searchReleases(
    job.target_kind === 'series' ? { seriesId: job.target_id } : { movieId: job.target_id },
  );
  const { kept, dropped } = prefilter(raw, ctx.config.picking);

  if (kept.length === 0) {
    recordOutcome(ctx, job, { status: 'no-candidates', kept, dropped });
    ctx.events.append({
      kind: 'acquire.no-candidates',
      level: 'attention',
      jobId: job.id,
      message: `No candidates survived prefilter for "${title}"`,
      data: { instance: job.arr_instance, targetKind: job.target_kind, targetId: job.target_id },
    });
    return;
  }

  const pick = await pickRelease({
    llm: ctx.llm,
    candidates: kept,
    tags: ctx.config.picking.tags,
    title,
    kind: job.target_kind,
  });

  if (pick.decision === 'none') {
    recordOutcome(ctx, job, { status: 'none-viable', reasoning: pick.reasoning, kept, dropped });
    ctx.events.append({
      kind: 'acquire.none-viable',
      level: 'attention',
      jobId: job.id,
      message: `No candidate judged viable for "${title}": ${pick.reasoning}`,
      data: { instance: job.arr_instance, targetKind: job.target_kind, targetId: job.target_id },
    });
    return;
  }

  // pickRelease already validated this guid against `kept` — re-finding it here is just
  // how we recover its indexerId, not a re-check of the LLM's answer.
  const picked = kept.find((c) => c.guid === pick.guid);
  if (!picked) {
    throw new Error(`Picked guid "${pick.guid}" is missing from the candidate list`);
  }

  await client.grabRelease(pick.guid, picked.indexerId);

  if (job.target_kind === 'series' && pick.releaseGroup) {
    await pinReleaseGroup(
      { client, db: ctx.db },
      { instanceName: job.arr_instance, seriesId: job.target_id, group: pick.releaseGroup },
    );
  }

  recordOutcome(ctx, job, {
    status: 'grabbed',
    pickedGuid: pick.guid,
    releaseGroup: pick.releaseGroup,
    reasoning: pick.reasoning,
    kept,
    dropped,
  });
  ctx.events.append({
    kind: 'acquire.grabbed',
    jobId: job.id,
    message: `Grabbed "${picked.title}" for "${title}"`,
    data: {
      instance: job.arr_instance,
      targetKind: job.target_kind,
      targetId: job.target_id,
      guid: pick.guid,
      releaseGroup: pick.releaseGroup,
    },
  });
}

/** Prefers the webhook-supplied title (`job.payload.title`); falls back to a fresh arr
 * lookup when a job was enqueued without one (e.g. a future reconciliation job). */
async function resolveTitle(client: ArrApi, job: JobRow): Promise<string> {
  const payloadTitle = job.payload.title;
  if (typeof payloadTitle === 'string' && payloadTitle.length > 0) {
    return payloadTitle;
  }
  if (job.target_kind === 'series') {
    return (await client.getSeries(job.target_id)).title;
  }
  const movies = await client.listMovies();
  return movies.find((m) => m.id === job.target_id)?.title ?? `movie #${job.target_id}`;
}

function recordOutcome(ctx: AppContext, job: JobRow, input: RecordOutcomeInput): void {
  ctx.db
    .prepare(
      `INSERT INTO acquire_records
         (arr_instance, target_kind, target_id, status, picked_guid, release_group, reasoning, candidates_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      job.arr_instance,
      job.target_kind,
      job.target_id,
      input.status,
      input.pickedGuid ?? null,
      input.releaseGroup ?? null,
      input.reasoning ?? null,
      JSON.stringify({ kept: input.kept, dropped: input.dropped }),
      Date.now(),
    );
}
