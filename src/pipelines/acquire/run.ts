import type { ArrApi, EpisodeResource, ReleaseCandidate, SeasonResource } from '../../arr/types.js';
import { traceArrClient } from '../../arr/traced.js';
import type { AppContext } from '../../context.js';
import { AcquireRecords, type AcquireStatus } from '../../db/acquireRecords.js';
import { targetEventData } from '../../events/target.js';
import type { JobRow } from '../../jobs/queue.js';
import { resolvePayloadTitle, resolveTargetTitle } from '../targetTitle.js';
import { errorMessage } from '../../util/errors.js';
import { eligibleCandidates, pickRelease, resolveReleaseGroup } from './pick.js';
import { pinReleaseGroup } from './pin.js';
import { capCandidates, dedupByInfoHash, prefilter, type DroppedCandidate } from './prefilter.js';
import { classifySeason, type SeasonMode } from './seasonMode.js';
import { seasonSatisfaction } from './satisfied.js';

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
  pickedFullSeason?: boolean;
  /** The candidate a human can grab anyway over the model's veto: the top of the eligible
   * set the model was shown. Only ever set on `'none-viable'` for a season whose shape the
   * host claimed (complete/airing); elsewhere a veto is just a veto. */
  forceGrab?: { guid: string; indexerId: number; title: string; releaseGroup: string | null };
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
 * before a grab (unknown arr instance, an arr API error, the LLM/pick call itself throwing —
 * a bad response, an out-of-range candidate number — or a picked guid that vanished) throw,
 * which `startRunner` turns into a job failure via `queue.fail`.
 *
 * Once a season's (or a movie's) `grabRelease` has succeeded, nothing about recording *that*
 * grab is allowed to turn the job into a failure: the grab is the irreversible, valuable part,
 * and a job failure would retry the whole search-and-pick from scratch on an arr that's
 * already downloading the release. A pin failure past that point is caught and reported as a
 * `warn` event, and so is a failure recording the outcome itself (`acquire_records` insert,
 * the final event) — both are caught independently, so neither can turn an already-successful
 * grab into a retried job. This containment is per-season, not per-job, though: a season
 * search/pick failure *after* an earlier season in the same run already grabbed still fails
 * the whole job (nothing catches it) — by design, so the runner's own retry re-runs the job and
 * picks up the remaining seasons; the double-grab guard (`alreadyGrabbedSeasons` below) is what
 * keeps that retry from re-grabbing the season(s) that already succeeded.
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
 *
 * Every interactive search a run performs is cached per (job, target) in `ctx.searchCache`
 * and cleared once the job finishes without throwing, so the retry a mid-run failure earns
 * replays those candidates instead of sweeping every indexer a second time. The one failure
 * that clears it too is a thrown `grabRelease` (see `attempt`), where the cached guids are
 * exactly what just proved untrustworthy.
 */
export async function runAcquireJob(ctx: AppContext, job: JobRow): Promise<void> {
  const rawClient = ctx.clients.get(job.arr_instance);
  if (!rawClient) {
    throw new Error(`No arr client configured for instance "${job.arr_instance}"`);
  }
  // Wrapped once here so every downstream arr call (including the ones inside
  // resolveTargetTitle and pinReleaseGroup) traces without each site opting in.
  const client = traceArrClient(rawClient, ctx.trace, job.id);

  if (job.target_kind === 'movie') {
    const title = await resolveTargetTitle(client, job);
    await runMovieAcquire(ctx, job, client, title);
  } else {
    const series = await client.getSeries(job.target_id);
    const title = resolvePayloadTitle(job) ?? series.title;
    await runSeriesAcquire(ctx, job, client, title, series.seasons);
  }

  // Only reached on a clean finish: a throw leaves this job's cached candidates in place,
  // which is exactly who the cache is for (the retry the runner is about to schedule).
  ctx.searchCache.clearJob(job.id);
}

/** Searches the arr for `key`'s candidates, or replays what this job's previous run already
 * found. `key` names the target within the job (`'movie'`, or `` `s${seasonNumber}` ``), so
 * each season of a series keeps its own entry. A cache hit makes no arr call at all, so it
 * emits no `arr.request` trace entry either: a retried job's trace shows the pick with no
 * search in front of it, which is honest (no request was made) but worth knowing when
 * reading one. */
async function cachedSearch(
  ctx: AppContext,
  job: JobRow,
  key: string,
  search: () => Promise<ReleaseCandidate[]>,
): Promise<ReleaseCandidate[]> {
  const cached = ctx.searchCache.get(job.id, key);
  if (cached) return cached;
  const raw = await search();
  ctx.searchCache.set(job.id, key, raw);
  return raw;
}

async function runMovieAcquire(ctx: AppContext, job: JobRow, client: ArrApi, title: string): Promise<void> {
  if (alreadyGrabbed(ctx, job)) {
    ctx.events.append({
      kind: 'acquire.skip-already-grabbed',
      jobId: job.id,
      message: `Skipped re-grab for "${title}" — a previous run of this job already grabbed a release`,
      data: targetEventData(job),
    });
    return;
  }

  const raw = await cachedSearch(ctx, job, 'movie', () => client.searchReleases({ movieId: job.target_id }));
  const result = await attempt(ctx, client, raw, { title, kind: 'movie', jobId: job.id, hint: resolveHint(job) });

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
      data: targetEventData(job, { guid: result.pickedGuid, releaseGroup: result.releaseGroup }),
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
  seasons: SeasonResource[],
): Promise<void> {
  // Season 0 is Sonarr's convention for "Specials" — never auto-acquired.
  const monitoredSeasons = seasons.filter((s) => s.monitored && s.seasonNumber > 0);
  if (monitoredSeasons.length === 0) {
    recordOutcome(ctx, job, { status: 'no-candidates', candidates: { kept: [], dropped: [] } });
    ctx.events.append({
      kind: 'acquire.no-candidates',
      level: 'attention',
      jobId: job.id,
      message: `Nothing to grab for "${title}" — no monitored seasons (specials alone don't count)`,
      data: targetEventData(job, { title }),
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
        data: targetEventData(job, { seasonNumber: season.seasonNumber }),
      });
      continue;
    }

    const mode = classifySeason(season.statistics);
    if (mode === 'unaired') {
      ctx.events.append({
        kind: 'acquire.skip-unaired',
        jobId: job.id,
        message: `Skipped "${title}" Season ${season.seasonNumber} — no episodes have aired yet`,
        data: targetEventData(job, { seasonNumber: season.seasonNumber }),
      });
      continue;
    }

    // Ahead of the search, not after it: a satisfied season returns hundreds of
    // candidates the arr will refuse one by one, and reading zero survivors as
    // "no releases exist" is exactly the false alarm this guards.
    if (seasonSatisfaction(season.statistics) === 'satisfied') {
      recordOutcome(ctx, job, {
        status: 'already-satisfied',
        candidates: { seasonNumber: season.seasonNumber, kept: [], dropped: [] },
      });
      ctx.events.append({
        kind: 'acquire.already-satisfied',
        jobId: job.id,
        message: `Nothing to grab for "${title}" Season ${season.seasonNumber}: every aired episode is already on disk`,
        data: targetEventData(job, { seasonNumber: season.seasonNumber }),
      });
      continue;
    }

    const raw = await cachedSearch(ctx, job, `s${season.seasonNumber}`, () =>
      client.searchReleases({ seriesId: job.target_id, seasonNumber: season.seasonNumber }),
    );
    let missingEpisodeNumbers: number[] | undefined;
    if (mode === 'airing') {
      const episodes = await client.listEpisodes(job.target_id);
      missingEpisodeNumbers = missingAiredEpisodeNumbers(episodes, season.seasonNumber);
    }
    const result = await attempt(ctx, client, raw, {
      title,
      kind: 'series',
      seasonNumber: season.seasonNumber,
      jobId: job.id,
      hint: resolveHint(job),
      mode,
      missingEpisodeNumbers,
    });
    const seasonLabel = `${title} Season ${season.seasonNumber}`;

    if (result.status !== 'grabbed') {
      recordOutcome(ctx, job, {
        status: result.status,
        reasoning: result.reasoning,
        candidates: { seasonNumber: season.seasonNumber, kept: result.kept, dropped: result.dropped },
      });
      appendNonGrabAttentionEvent(ctx, job, seasonLabel, result, season.seasonNumber);
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
          message: `Grabbed "${result.pickedTitle}" but failed to pin release group "${result.releaseGroup}": ${errorMessage(err)}`,
          data: targetEventData(job, { releaseGroup: result.releaseGroup }),
        });
      }
    }

    if (mode === 'complete' && result.pickedFullSeason !== true) {
      try {
        await client.searchSeason(job.target_id, season.seasonNumber);
      } catch (err) {
        ctx.events.append({
          kind: 'acquire.season-search-failed',
          level: 'warn',
          jobId: job.id,
          message: `Grabbed "${result.pickedTitle}" but failed to kick a season search for "${seasonLabel}": ${errorMessage(err)}`,
          data: targetEventData(job, { seasonNumber: season.seasonNumber }),
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
        data: targetEventData(job, { seasonNumber: season.seasonNumber, guid: result.pickedGuid, releaseGroup: result.releaseGroup }),
      });
    } catch (err) {
      appendRecordFailedEvent(ctx, job, seasonLabel, result.pickedTitle, err);
    }
  }
}

/** Search → prefilter → cap → pick → grab for one target (a movie, or a single series
 * season). Shared by both branches of `runAcquireJob` so the policy — deterministic
 * prefilter, then a capped candidate list, then the LLM pick, then the grab — only lives
 * in one place. Never writes to `acquire_records` itself (the caller decides how to
 * record/report each `status`) or throws for an expected outcome — it does append its own
 * `acquire.candidates-capped` event directly when the cap actually drops something. */
async function attempt(
  ctx: AppContext,
  client: ArrApi,
  raw: ReleaseCandidate[],
  input: {
    title: string;
    kind: 'series' | 'movie';
    seasonNumber?: number;
    jobId: number;
    hint?: string;
    mode?: SeasonMode | 'movie';
    missingEpisodeNumbers?: number[];
  },
): Promise<AttemptResult> {
  const { kept: prefiltered, dropped: prefilterDropped } = prefilter(raw, ctx.config.picking);
  const { kept: deduped, dropped: dedupDropped } = dedupByInfoHash(prefiltered);
  const { kept, dropped: capDropped } = capCandidates(deduped, {
    mode: input.mode,
    missingEpisodeNumbers: input.missingEpisodeNumbers,
  });
  const dropped = [...prefilterDropped, ...dedupDropped, ...capDropped];

  ctx.trace.event({
    jobId: input.jobId,
    kind: 'pipeline.prefilter',
    summary: `prefilter kept ${kept.length} of ${raw.length}`,
    payload: () => ({ kept, dropped }),
  });

  if (capDropped.length > 0) {
    const label = input.seasonNumber !== undefined ? `${input.title} Season ${input.seasonNumber}` : input.title;
    ctx.events.append({
      kind: 'acquire.candidates-capped',
      level: 'warn',
      jobId: input.jobId,
      message: `Capped candidates for "${label}" from ${deduped.length} to ${kept.length} (dropped ${capDropped.length} candidate(s))`,
      data: { title: input.title, seasonNumber: input.seasonNumber, droppedCount: capDropped.length },
    });
  }

  if (kept.length === 0) {
    return { status: 'no-candidates', kept, dropped };
  }

  const pick = await pickRelease({
    llm: ctx.llm,
    candidates: kept,
    prefer: ctx.config.picking.prefer,
    avoid: ctx.config.picking.avoid,
    title: input.title,
    kind: input.kind,
    seasonNumber: input.seasonNumber,
    hint: input.hint,
    mode: input.mode === 'movie' ? undefined : input.mode,
    jobId: input.jobId,
  });

  if (pick.decision === 'none') {
    // A veto on a season the host shaped is a judgement call, not a dead end: carry the
    // top eligible candidate so a human can overrule the model with one click.
    const shapedMode = input.mode === 'complete' || input.mode === 'airing' ? input.mode : undefined;
    const top = shapedMode ? eligibleCandidates(shapedMode, kept)[0] : undefined;
    return {
      status: 'none-viable',
      reasoning: pick.reasoning,
      kept,
      dropped,
      ...(top
        ? { forceGrab: { guid: top.guid, indexerId: top.indexerId, title: top.title, releaseGroup: resolveReleaseGroup(top) } }
        : {}),
    };
  }

  // pickRelease already validated this guid against `kept` — re-finding it here is just
  // how we recover its indexerId, not a re-check of the LLM's answer.
  const picked = kept.find((c) => c.guid === pick.guid);
  if (!picked) {
    throw new Error(`Picked guid "${pick.guid}" is missing from the candidate list`);
  }

  try {
    await client.grabRelease(pick.guid, picked.indexerId);
  } catch (err) {
    // The cache survives a thrown run so an LLM blip's retry replays the same candidates
    // instead of re-sweeping every indexer. A thrown GRAB is the one failure that argues the
    // other way: whatever the arr rejected (an expired release-cache guid, an indexer that
    // has since dropped the release) makes those exact guids the least trustworthy thing to
    // retry against for the next 30 minutes. Drop them and let the retry search fresh.
    ctx.searchCache.clearJob(input.jobId);
    throw err;
  }

  return {
    status: 'grabbed',
    pickedGuid: pick.guid,
    releaseGroup: pick.releaseGroup,
    reasoning: pick.reasoning,
    pickedTitle: picked.title,
    pickedFullSeason: picked.fullSeason === true,
    kept,
    dropped,
  };
}

function missingAiredEpisodeNumbers(episodes: EpisodeResource[], seasonNumber: number, now = Date.now()): number[] {
  return episodes
    .filter((e) => {
      if (e.seasonNumber !== seasonNumber || e.hasFile) return false;
      if (!e.airDateUtc) return false;
      const aired = Date.parse(e.airDateUtc);
      return !Number.isNaN(aired) && aired <= now;
    })
    .map((e) => e.episodeNumber);
}

/** `seasonNumber`, when given, is folded into the event's `data` AND doubles as a
 * `dedupeKey` (`String(seasonNumber)`): each failed season is its own sub-target failure,
 * not a repeat of "this series has a failed season" — without it, several seasons failing
 * no-candidates/none-viable in the same run would collapse into one attention row naming
 * only the last season. The movie call site (no `seasonNumber`) keeps the plain
 * per-target behavior, which is correct there — a movie has only one target to fail. */
function appendNonGrabAttentionEvent(ctx: AppContext, job: JobRow, label: string, result: AttemptResult, seasonNumber?: number): void {
  const extra = seasonNumber !== undefined ? { seasonNumber, dedupeKey: String(seasonNumber) } : {};
  if (result.status === 'no-candidates') {
    ctx.events.append({
      kind: 'acquire.no-candidates',
      level: 'attention',
      jobId: job.id,
      message: `No usable releases found for "${label}" after filtering (seeders, size)`,
      data: targetEventData(job, { ...extra, title: label }),
    });
    return;
  }
  // `action: 'force-grab'` is what `POST /api/attention/:id/accept` dispatches on
  // (`ForceGrabSchema` in src/server/app.ts): the accept re-executes exactly this payload.
  const forceGrabData = result.forceGrab
    ? {
        action: 'force-grab',
        guid: result.forceGrab.guid,
        indexerId: result.forceGrab.indexerId,
        pickedTitle: result.forceGrab.title,
        releaseGroup: result.forceGrab.releaseGroup,
      }
    : {};
  ctx.events.append({
    kind: 'acquire.none-viable',
    level: 'attention',
    jobId: job.id,
    message: result.forceGrab
      ? `The model rejected every release for "${label}" (${result.reasoning}) - accept to grab "${result.forceGrab.title}" anyway`
      : `Couldn't pick a release for "${label}": ${result.reasoning}`,
    data: targetEventData(job, { ...extra, title: label, reasoning: result.reasoning, ...forceGrabData }),
  });
}

function appendRecordFailedEvent(ctx: AppContext, job: JobRow, label: string, pickedTitle: string | undefined, err: unknown): void {
  // Same rationale as the pin-failure catch above: the grab already happened, so a
  // failure to record it (e.g. a DB error) must not fail — and thus retry — the job.
  ctx.events.append({
    kind: 'acquire.record-failed',
    level: 'warn',
    jobId: job.id,
    message: `Grabbed "${pickedTitle}" for "${label}" but failed to record the outcome: ${errorMessage(err)}`,
    data: targetEventData(job),
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

/** What enqueued this job — `job.payload.source` when the enqueuer set one (`reconcile.ts`'s
 * reconciliation pipeline does), otherwise `'webhook'`, the default when nothing else set one. */
function resolveSource(job: JobRow): string {
  const source = job.payload.source;
  return typeof source === 'string' && source.length > 0 ? source : DEFAULT_SOURCE;
}

/** A human operator's guidance on a re-pick, set by `POST /api/attention/:id/repick`'s
 * `payload.hint` — forwarded into the pick prompt only when it's a genuinely non-empty
 * string, so a job with no hint at all (every ordinary job) still gets `undefined`
 * (byte-identical prompt) rather than an empty/garbage hint section. */
function resolveHint(job: JobRow): string | undefined {
  const hint = job.payload.hint;
  return typeof hint === 'string' && hint.length > 0 ? hint : undefined;
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
