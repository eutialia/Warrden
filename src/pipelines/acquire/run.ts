import type { ArrApi, ReleaseCandidate } from '../../arr/types.js';
import type { AppContext } from '../../context.js';
import { AcquireRecords, type AcquireStatus } from '../../db/acquireRecords.js';
import type { JobRow } from '../../jobs/queue.js';
import { pickRelease } from './pick.js';
import { pinReleaseGroup } from './pin.js';
import { capCandidates, prefilter, type DroppedCandidate } from './prefilter.js';

const DEFAULT_SOURCE = 'webhook';

/** One search-prefilter-pick-grab attempt's outcome, for either a movie or a single
 * series season. `kept`/`dropped` are always populated (even for `'grabbed'`) so the
 * caller can persist the full audit trail regardless of outcome. */
interface AttemptResult {
  status: AcquireStatus;
  pickedGuid?: string;
  releaseGroup?: string | null;
  reasoning?: string;
  pickedTitle?: string;
  kept: ReleaseCandidate[];
  dropped: DroppedCandidate[];
}

interface RecordOutcomeInput {
  status: AcquireStatus;
  pickedGuid?: string;
  releaseGroup?: string | null;
  reasoning?: string;
  candidates: object;
}

/**
 * Runs one acquire job end-to-end: search the arr for releases, prefilter deterministically,
 * ask the LLM to pick one (or declare none viable), grab the pick, and — for a Sonarr series
 * with a known release group — pin that group to the series so future episodes keep matching
 * it. "No candidates" and "none viable" are expected, normal outcomes, not failures: each is
 * recorded in `acquire_records` and raised as an `attention` event so it surfaces on the
 * dashboard, and the job still completes successfully. Only genuinely unexpected failures
 * before a grab (unknown arr instance, an arr API error, a picked guid that vanished) throw,
 * which `startRunner` turns into a job failure via `queue.fail`.
 *
 * Once a `grabRelease` has succeeded, nothing after it is allowed to turn the job into a
 * failure: the grab is the irreversible, valuable part of the job, and a job failure would
 * retry the whole search-and-pick from scratch on an arr that's already downloading the
 * release. A pin failure past that point is caught and reported as a `warn` event, and so
 * is a failure recording the outcome itself (`acquire_records` insert, the final event) —
 * both are caught independently, so neither can turn an already-successful grab into a
 * retried job.
 *
 * A movie searches (and grabs) once, exactly as before. A Sonarr series searches and grabs
 * **per monitored season** (`{seriesId, seasonNumber}` — Sonarr's own `ReleaseController`
 * falls back to its full RSS feed, `GetRss()`, and returns unrelated candidates when
 * `seasonNumber` is omitted from a series search), so each season gets its own pick against
 * only that season's candidates. Season 0 ("Specials" in Sonarr) is never auto-acquired. The
 * release group is pinned at most once per job run, from whichever season grabs first — later
 * seasons in the same run don't re-pin. Each season's outcome is recorded as its own
 * `acquire_records` row (tagged with its `seasonNumber` in `candidates_json`) as soon as that
 * season finishes, rather than batched until the whole job completes — a crash partway
 * through the season loop must not lose the record of seasons that already grabbed, both for
 * the audit trail and so a reclaimed re-run's double-grab guard (see `alreadyGrabbedSeasons`
 * below) can actually see them. The dashboard's "did this job grab anything" view aggregates
 * across a job's own rows via `AcquireRecords.outcomeForJob` rather than reading any single
 * row, since the latest row alone doesn't reflect "any season grabbed" when a later season's
 * own outcome was worse than an earlier one's.
 */
export async function runAcquireJob(ctx: AppContext, job: JobRow): Promise<void> {
  const client = ctx.clients.get(job.arr_instance);
  if (!client) {
    throw new Error(`No arr client configured for instance "${job.arr_instance}"`);
  }

  if (job.target_kind === 'movie') {
    const title = await resolveMovieTitle(client, job);
    await runMovieAcquire(ctx, job, client, title);
    return;
  }

  const series = await client.getSeries(job.target_id);
  const title = resolvePayloadTitle(job) ?? series.title;
  await runSeriesAcquire(ctx, job, client, title, series.seasons);
}

async function runMovieAcquire(ctx: AppContext, job: JobRow, client: ArrApi, title: string): Promise<void> {
  if (alreadyGrabbed(ctx, job)) {
    ctx.events.append({
      kind: 'acquire.skip-already-grabbed',
      jobId: job.id,
      message: `Skipped re-grab for "${title}" — a previous run of this job already grabbed a release`,
      data: { instance: job.arr_instance, targetKind: job.target_kind, targetId: job.target_id },
    });
    return;
  }

  const raw = await client.searchReleases({ movieId: job.target_id });
  const result = await attempt(ctx, client, raw, { title, kind: 'movie', jobId: job.id });

  if (result.status !== 'grabbed') {
    recordOutcome(ctx, job, {
      status: result.status,
      reasoning: result.reasoning,
      candidates: { kept: result.kept, dropped: result.dropped },
    });
    appendNonGrabAttentionEvent(ctx, job, title, result);
    return;
  }

  try {
    recordOutcome(ctx, job, {
      status: 'grabbed',
      pickedGuid: result.pickedGuid,
      releaseGroup: result.releaseGroup,
      reasoning: result.reasoning,
      candidates: { kept: result.kept, dropped: result.dropped },
    });
    ctx.events.append({
      kind: 'acquire.grabbed',
      jobId: job.id,
      message: `Grabbed "${result.pickedTitle}" for "${title}"`,
      data: {
        instance: job.arr_instance,
        targetKind: job.target_kind,
        targetId: job.target_id,
        guid: result.pickedGuid,
        releaseGroup: result.releaseGroup,
      },
    });
  } catch (err) {
    appendRecordFailedEvent(ctx, job, title, result.pickedTitle, err);
  }
}

async function runSeriesAcquire(
  ctx: AppContext,
  job: JobRow,
  client: ArrApi,
  title: string,
  seasons: { seasonNumber: number; monitored: boolean }[],
): Promise<void> {
  // Season 0 is Sonarr's convention for "Specials" — never auto-acquired.
  const monitoredSeasons = seasons.filter((s) => s.monitored && s.seasonNumber > 0);
  if (monitoredSeasons.length === 0) {
    recordOutcome(ctx, job, { status: 'no-candidates', candidates: { kept: [], dropped: [] } });
    ctx.events.append({
      kind: 'acquire.no-candidates',
      level: 'attention',
      jobId: job.id,
      message: `No monitored seasons for "${title}"`,
      data: { instance: job.arr_instance, targetKind: job.target_kind, targetId: job.target_id },
    });
    return;
  }

  const grabbedSeasons = alreadyGrabbedSeasons(ctx, job);
  let pinnedGroup: string | null = null;

  for (const season of monitoredSeasons) {
    if (grabbedSeasons.has(season.seasonNumber)) {
      ctx.events.append({
        kind: 'acquire.skip-already-grabbed',
        jobId: job.id,
        message: `Skipped re-grab for "${title}" Season ${season.seasonNumber} — a previous run of this job already grabbed a release for it`,
        data: { instance: job.arr_instance, targetKind: job.target_kind, targetId: job.target_id, seasonNumber: season.seasonNumber },
      });
      continue;
    }

    const raw = await client.searchReleases({ seriesId: job.target_id, seasonNumber: season.seasonNumber });
    const result = await attempt(ctx, client, raw, {
      title,
      kind: 'series',
      seasonNumber: season.seasonNumber,
      jobId: job.id,
    });
    const seasonLabel = `${title} Season ${season.seasonNumber}`;

    if (result.status !== 'grabbed') {
      recordOutcome(ctx, job, {
        status: result.status,
        reasoning: result.reasoning,
        candidates: { seasonNumber: season.seasonNumber, kept: result.kept, dropped: result.dropped },
      });
      appendNonGrabAttentionEvent(ctx, job, seasonLabel, result, { seasonNumber: season.seasonNumber });
      continue;
    }

    if (pinnedGroup === null && result.releaseGroup) {
      pinnedGroup = result.releaseGroup;
      try {
        await pinReleaseGroup(
          { client, db: ctx.db },
          { instanceName: job.arr_instance, seriesId: job.target_id, group: result.releaseGroup },
        );
      } catch (err) {
        ctx.events.append({
          kind: 'acquire.pin-failed',
          level: 'warn',
          jobId: job.id,
          message: `Grabbed "${result.pickedTitle}" but failed to pin release group "${result.releaseGroup}": ${
            err instanceof Error ? err.message : String(err)
          }`,
          data: { instance: job.arr_instance, targetKind: job.target_kind, targetId: job.target_id, releaseGroup: result.releaseGroup },
        });
      }
    }

    try {
      recordOutcome(ctx, job, {
        status: 'grabbed',
        pickedGuid: result.pickedGuid,
        releaseGroup: result.releaseGroup,
        reasoning: result.reasoning,
        candidates: { seasonNumber: season.seasonNumber, kept: result.kept, dropped: result.dropped },
      });
      ctx.events.append({
        kind: 'acquire.grabbed',
        jobId: job.id,
        message: `Grabbed "${result.pickedTitle}" for "${seasonLabel}"`,
        data: {
          instance: job.arr_instance,
          targetKind: job.target_kind,
          targetId: job.target_id,
          seasonNumber: season.seasonNumber,
          guid: result.pickedGuid,
          releaseGroup: result.releaseGroup,
        },
      });
    } catch (err) {
      appendRecordFailedEvent(ctx, job, seasonLabel, result.pickedTitle, err);
    }
  }
}

/** Search → prefilter → cap → pick → grab for one target (a movie, or a single series
 * season). Shared by both branches of `runAcquireJob` so the policy — deterministic
 * prefilter, then a capped candidate list, then the LLM pick, then the grab — only lives
 * in one place. Never persists anything or throws for an expected outcome; the caller
 * decides how to record/report each `status`. */
async function attempt(
  ctx: AppContext,
  client: ArrApi,
  raw: ReleaseCandidate[],
  input: { title: string; kind: 'series' | 'movie'; seasonNumber?: number; jobId: number },
): Promise<AttemptResult> {
  const { kept: prefiltered, dropped: prefilterDropped } = prefilter(raw, ctx.config.picking);
  const { kept, dropped: capDropped } = capCandidates(prefiltered);
  const dropped = [...prefilterDropped, ...capDropped];

  if (capDropped.length > 0) {
    const label = input.seasonNumber !== undefined ? `${input.title} Season ${input.seasonNumber}` : input.title;
    ctx.events.append({
      kind: 'acquire.candidates-capped',
      level: 'warn',
      jobId: input.jobId,
      message: `Capped candidates for "${label}" from ${prefiltered.length} to ${kept.length} (dropped ${capDropped.length} lower-seeded candidate(s))`,
      data: { title: input.title, seasonNumber: input.seasonNumber, droppedCount: capDropped.length },
    });
  }

  if (kept.length === 0) {
    return { status: 'no-candidates', kept, dropped };
  }

  const pick = await pickRelease({
    llm: ctx.llm,
    candidates: kept,
    tags: ctx.config.picking.tags,
    title: input.title,
    kind: input.kind,
    seasonNumber: input.seasonNumber,
  });

  if (pick.decision === 'none') {
    return { status: 'none-viable', reasoning: pick.reasoning, kept, dropped };
  }

  // pickRelease already validated this guid against `kept` — re-finding it here is just
  // how we recover its indexerId, not a re-check of the LLM's answer.
  const picked = kept.find((c) => c.guid === pick.guid);
  if (!picked) {
    throw new Error(`Picked guid "${pick.guid}" is missing from the candidate list`);
  }

  await client.grabRelease(pick.guid, picked.indexerId);

  return {
    status: 'grabbed',
    pickedGuid: pick.guid,
    releaseGroup: pick.releaseGroup,
    reasoning: pick.reasoning,
    pickedTitle: picked.title,
    kept,
    dropped,
  };
}

function appendNonGrabAttentionEvent(
  ctx: AppContext,
  job: JobRow,
  label: string,
  result: AttemptResult,
  data?: Record<string, unknown>,
): void {
  if (result.status === 'no-candidates') {
    ctx.events.append({
      kind: 'acquire.no-candidates',
      level: 'attention',
      jobId: job.id,
      message: `No candidates survived prefilter for "${label}"`,
      data: { instance: job.arr_instance, targetKind: job.target_kind, targetId: job.target_id, ...data },
    });
    return;
  }
  ctx.events.append({
    kind: 'acquire.none-viable',
    level: 'attention',
    jobId: job.id,
    message: `No candidate judged viable for "${label}": ${result.reasoning}`,
    data: { instance: job.arr_instance, targetKind: job.target_kind, targetId: job.target_id, ...data },
  });
}

function appendRecordFailedEvent(ctx: AppContext, job: JobRow, label: string, pickedTitle: string | undefined, err: unknown): void {
  // Same rationale as the pin-failure catch above: the grab already happened, so a
  // failure to record it (e.g. a DB error) must not fail — and thus retry — the job.
  ctx.events.append({
    kind: 'acquire.record-failed',
    level: 'warn',
    jobId: job.id,
    message: `Grabbed "${pickedTitle}" for "${label}" but failed to record the outcome: ${
      err instanceof Error ? err.message : String(err)
    }`,
    data: { instance: job.arr_instance, targetKind: job.target_kind, targetId: job.target_id },
  });
}

/** Movie double-grab guard: `true` when the latest `acquire_records` row for this target is
 * already `'grabbed'` and was written after this job was enqueued — i.e. a previous run of
 * this very job (crashed, then reclaimed and retried) already grabbed a release, so grabbing
 * again would duplicate the download. A manual re-pick creates a brand-new job (a fresh
 * `created_at` after the existing record), so it always passes this check. */
function alreadyGrabbed(ctx: AppContext, job: JobRow): boolean {
  const latest = new AcquireRecords(ctx.db).listByTarget(job.arr_instance, job.target_kind, job.target_id)[0];
  // `>=` (not `>`): a record in the same millisecond as the job's creation is treated as
  // this job's own — erring toward skipping keeps the irreversible grab from duplicating.
  return latest?.status === 'grabbed' && latest.created_at >= job.created_at;
}

/** True when `x` is a series-season `acquire_records.candidates_json` payload — i.e. it
 * carries the `seasonNumber` tag `runSeriesAcquire` stamps on every per-season row (movie
 * rows, and the "no monitored seasons" row, never have one). */
function hasSeasonNumber(x: unknown): x is { seasonNumber: number } {
  return typeof x === 'object' && x !== null && typeof (x as Record<string, unknown>).seasonNumber === 'number';
}

/** Series double-grab guard, per season: every season number this job's own re-run already
 * grabbed (an `acquire_records` row for this target, tagged with that `seasonNumber` in
 * `candidates_json`, `status: 'grabbed'`, written after this job was enqueued). Seasons in
 * this set are skipped rather than re-grabbed; seasons not in it (including ones a crashed
 * run never got to) still run normally. */
function alreadyGrabbedSeasons(ctx: AppContext, job: JobRow): Set<number> {
  const records = new AcquireRecords(ctx.db).listByTarget(job.arr_instance, job.target_kind, job.target_id);
  const grabbed = new Set<number>();
  for (const r of records) {
    if (r.created_at < job.created_at) continue; // `>=` boundary, matching alreadyGrabbed()
    if (r.status !== 'grabbed') continue;
    if (hasSeasonNumber(r.candidates_json)) grabbed.add(r.candidates_json.seasonNumber);
  }
  return grabbed;
}

/** The webhook-supplied title (`job.payload.title`), if the enqueuer set a non-empty one. */
function resolvePayloadTitle(job: JobRow): string | undefined {
  const payloadTitle = job.payload.title;
  return typeof payloadTitle === 'string' && payloadTitle.length > 0 ? payloadTitle : undefined;
}

/** Prefers the webhook-supplied title; falls back to a fresh `listMovies()` lookup when a
 * job was enqueued without one (e.g. a future reconciliation job). Series titles never need
 * this fallback path — `runAcquireJob` already calls `getSeries` unconditionally to read
 * `seasons`, so `series.title` is always on hand as the fallback there. */
async function resolveMovieTitle(client: ArrApi, job: JobRow): Promise<string> {
  const payloadTitle = resolvePayloadTitle(job);
  if (payloadTitle) return payloadTitle;
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
    candidates: input.candidates,
  });
}
