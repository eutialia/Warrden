import type { ArrApi, ReleaseCandidate } from '../../arr/types.js';
import type { AppContext } from '../../context.js';
import { AcquireRecords, type AcquireStatus } from '../../db/acquireRecords.js';
import type { JobRow } from '../../jobs/queue.js';
import { pickRelease } from './pick.js';
import { pinReleaseGroup } from './pin.js';
import { prefilter, type DroppedCandidate } from './prefilter.js';

const DEFAULT_SOURCE = 'webhook';

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
 * before the grab (unknown arr instance, an arr API error, a picked guid that vanished)
 * throw, which `startRunner` turns into a job failure via `queue.fail`.
 *
 * Once `grabRelease` has succeeded, nothing after it is allowed to turn the job into a
 * failure: the grab is the irreversible, valuable part of the job, and a job failure would
 * retry the whole search-and-pick from scratch on an arr that's already downloading the
 * release. A pin failure past that point is caught and reported as a `warn` event, and so
 * is a failure recording the outcome itself (`acquire_records` insert, the final event) —
 * both are caught independently, so neither can turn an already-successful grab into a
 * retried job.
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
    try {
      await pinReleaseGroup(
        { client, db: ctx.db },
        { instanceName: job.arr_instance, seriesId: job.target_id, group: pick.releaseGroup },
      );
    } catch (err) {
      ctx.events.append({
        kind: 'acquire.pin-failed',
        level: 'warn',
        jobId: job.id,
        message: `Grabbed "${picked.title}" but failed to pin release group "${pick.releaseGroup}": ${
          err instanceof Error ? err.message : String(err)
        }`,
        data: { instance: job.arr_instance, targetKind: job.target_kind, targetId: job.target_id, releaseGroup: pick.releaseGroup },
      });
    }
  }

  try {
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
  } catch (err) {
    // Same rationale as the pin-failure catch above: the grab already happened, so a
    // failure to record it (e.g. a DB error) must not fail — and thus retry — the job.
    ctx.events.append({
      kind: 'acquire.record-failed',
      level: 'warn',
      jobId: job.id,
      message: `Grabbed "${picked.title}" for "${title}" but failed to record the outcome: ${
        err instanceof Error ? err.message : String(err)
      }`,
      data: { instance: job.arr_instance, targetKind: job.target_kind, targetId: job.target_id },
    });
  }
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

/** What enqueued this job — `job.payload.source` when the enqueuer set one (Task 12's
 * reconciliation pipeline will), otherwise `'webhook'`, the only source Phase 1 has. */
function resolveSource(job: JobRow): string {
  const source = job.payload.source;
  return typeof source === 'string' && source.length > 0 ? source : DEFAULT_SOURCE;
}

function recordOutcome(ctx: AppContext, job: JobRow, input: RecordOutcomeInput): void {
  new AcquireRecords(ctx.db).insert({
    arrInstance: job.arr_instance,
    targetKind: job.target_kind,
    targetId: job.target_id,
    source: resolveSource(job),
    status: input.status,
    pickedGuid: input.pickedGuid,
    releaseGroup: input.releaseGroup,
    reasoning: input.reasoning,
    candidates: { kept: input.kept, dropped: input.dropped },
  });
}
