import type { ArrApi, EpisodeResource, MovieResource, ReleaseCandidate, SeasonResource } from '../../arr/types.js';
import { traceArrClient } from '../../arr/traced.js';
import type { AppContext } from '../../context.js';
import { AcquireRecords, type AcquireStatus } from '../../db/acquireRecords.js';
import { AttentionItems } from '../../db/attention.js';
import { eventEnvelope } from '../../events/envelope.js';
import { targetEventData } from '../../events/target.js';
import type { JobRow } from '../../jobs/queue.js';
import { resolvePayloadTitle } from '../targetTitle.js';
import { errorMessage } from '../../util/errors.js';
import { eligibleCandidates, pickRelease, resolveReleaseGroup } from './pick.js';
import { pinReleaseGroup } from './pin.js';
import { capCandidates, dedupByInfoHash, prefilter, type DroppedCandidate } from './prefilter.js';
import { classifySeason, type SeasonMode } from './seasonMode.js';
import { anyDropSatisfied, seasonSatisfaction } from './satisfied.js';

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
  /** The picked release as normalized facts, for the `acquire.pick` event. */
  picked?: { title?: string; indexer?: string; quality?: string; type?: 'pack' | 'multi' | 'single' };
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
  /** What this record concludes about, for the `acquire.pick` event that goes with it. */
  label: string;
  seasonNumber?: number;
  /** The release, when one was picked. Absent on every non-grab outcome. */
  picked?: { title?: string; indexer?: string; quality?: string; type?: 'pack' | 'multi' | 'single' };
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
 * A movie searches (and grabs) at most once, and not at all when its file is already in place. A Sonarr series searches and grabs
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
  // pinReleaseGroup) traces without each site opting in.
  const client = traceArrClient(rawClient, ctx.trace, job.id);

  if (job.target_kind === 'movie') {
    // Resolved here rather than through resolveTargetTitle so the one listMovies() call
    // serves both the title and the hasFile check, matching what the series branch does
    // with getSeries.
    const movies = await client.listMovies();
    const movie = movies.find((m) => m.id === job.target_id);
    const title = resolvePayloadTitle(job) ?? movie?.title ?? `movie #${job.target_id}`;
    await runMovieAcquire(ctx, job, client, title, movie);
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

async function runMovieAcquire(
  ctx: AppContext,
  job: JobRow,
  client: ArrApi,
  title: string,
  movie: MovieResource | undefined,
): Promise<void> {
  if (alreadyGrabbed(ctx, job)) {
    ctx.events.append({
      kind: 'acquire.skip-already-grabbed',
      jobId: job.id,
      message: `Skipped re-grab for "${title}" — a previous run of this job already grabbed a release`,
      data: eventEnvelope({ scope: 'acquire', action: 'skip-already-grabbed', facts: { title } }, targetEventData(job)),
    });
    return;
  }

  // Radarr answers this directly, so unlike a series there is never an "unknown" case
  // here and the rejection-text fallback is not needed for movies at all. An absent movie
  // (deleted between enqueue and run) is not satisfied: let the search decide as before.
  if (movie?.hasFile === true) {
    recordAlreadySatisfied(ctx, job, {
      message: `Nothing to grab for "${title}": the file is already in place`,
      candidates: { kept: [], dropped: [] },
      label: title,
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
      label: title,
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
      label: title,
      picked: result.picked,
    });
    settleSeasonAttention(ctx, job);
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
    recordOutcome(ctx, job, { status: 'no-candidates', candidates: { kept: [], dropped: [] }, label: title });
    ctx.events.append({
      kind: 'acquire.no-candidates',
      level: 'attention',
      jobId: job.id,
      message: `Nothing to grab for "${title}" — no monitored seasons (specials alone don't count)`,
      data: eventEnvelope(
        { scope: 'acquire', action: 'no-candidates', facts: { title }, verdict: { tone: 'warning' } },
        targetEventData(job, { title }),
      ),
    });
    return;
  }

  const grabbedSeasons = alreadyGrabbedSeasons(ctx, job);
  let pinnedGroup: string | null = null;
  // True once any season stopped needing a human. See the target-level settle after the loop.
  let anySeasonSettled = false;

  for (const season of monitoredSeasons) {
    if (grabbedSeasons.has(season.seasonNumber)) {
      ctx.events.append({
        kind: 'acquire.skip-already-grabbed',
        jobId: job.id,
        message: `Skipped re-grab for "${title}" Season ${season.seasonNumber} — a previous run of this job already grabbed a release for it`,
        data: eventEnvelope(
          { scope: 'acquire', action: 'skip-already-grabbed', facts: { title, season: season.seasonNumber } },
          targetEventData(job),
        ),
      });
      continue;
    }

    const mode = classifySeason(season.statistics);
    const satisfaction = seasonSatisfaction(season.statistics);
    const seasonLabel = `${title} Season ${season.seasonNumber}`;

    if (mode === 'unaired') {
      ctx.events.append({
        kind: 'acquire.skip-unaired',
        jobId: job.id,
        message: `Skipped "${title}" Season ${season.seasonNumber} — no episodes have aired yet`,
        data: eventEnvelope(
          { scope: 'acquire', action: 'skip-unaired', facts: { title, season: season.seasonNumber } },
          targetEventData(job),
        ),
      });
      continue;
    }

    // Ahead of the search, not after it: a satisfied season returns hundreds of
    // candidates the arr will refuse one by one, and reading zero survivors as
    // "no releases exist" is exactly the false alarm this guards.
    if (satisfaction === 'satisfied') {
      recordAlreadySatisfied(ctx, job, {
        message: `Nothing to grab for "${seasonLabel}": every aired episode is already on disk`,
        candidates: { seasonNumber: season.seasonNumber, kept: [], dropped: [] },
        seasonNumber: season.seasonNumber,
        label: seasonLabel,
      });
      anySeasonSettled = true;
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

    if (result.status !== 'grabbed') {
      // Only when nothing better than the rejection text is on hand. A file count is the
      // better answer: on a part-filled season most candidates are refused as "existing
      // file meets cutoff" for the episodes we DO have, and believing that text would
      // report the season complete while an episode is still missing. A known-missing
      // aired episode (from episode-level `hasFile`) says the same thing structurally,
      // so it vetoes the fallback too.
      const satisfied =
        result.status === 'no-candidates' &&
        satisfaction === 'unknown' &&
        (missingEpisodeNumbers?.length ?? 0) === 0 &&
        anyDropSatisfied(result.dropped);

      if (satisfied) {
        recordAlreadySatisfied(ctx, job, {
          message: `Nothing to grab for "${seasonLabel}": the arr refused every release because it already holds this`,
          candidates: { seasonNumber: season.seasonNumber, kept: result.kept, dropped: result.dropped },
          seasonNumber: season.seasonNumber,
          label: seasonLabel,
        });
        anySeasonSettled = true;
      } else {
        recordOutcome(ctx, job, {
          status: result.status,
          reasoning: result.reasoning,
          candidates: { seasonNumber: season.seasonNumber, kept: result.kept, dropped: result.dropped },
          label: seasonLabel,
          seasonNumber: season.seasonNumber,
        });
        appendNonGrabAttentionEvent(ctx, job, seasonLabel, result, season.seasonNumber);
      }
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
          data: eventEnvelope(
            {
              scope: 'acquire',
              action: 'pin-failed',
              facts: { title, season: season.seasonNumber, release: { group: result.releaseGroup ?? undefined }, error: errorMessage(err) },
              verdict: { tone: 'warning' },
            },
            targetEventData(job),
          ),
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
          data: eventEnvelope(
            {
              scope: 'acquire',
              action: 'season-search-failed',
              facts: { title, season: season.seasonNumber, error: errorMessage(err) },
              verdict: { tone: 'warning' },
            },
            targetEventData(job),
          ),
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
        label: seasonLabel,
        seasonNumber: season.seasonNumber,
        picked: result.picked,
      });
      settleSeasonAttention(ctx, job, season.seasonNumber);
      anySeasonSettled = true;
    } catch (err) {
      appendRecordFailedEvent(ctx, job, seasonLabel, result.pickedTitle, err);
    }
  }

  // A season-scoped settle carries a dedupe key, so it can only ever match a row that was
  // stored with one, and the series-level item this function raises above ("no monitored
  // seasons") carries none. Without this it would stay open forever once the operator
  // monitors a season and the next run grabs it. The unkeyed settle matches exactly the
  // rows stored without a key, so every still-broken season's own keyed item survives it.
  if (anySeasonSettled) settleSeasonAttention(ctx, job);
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
  const label = input.seasonNumber !== undefined ? `${input.title} Season ${input.seasonNumber}` : input.title;

  // The search is its own step in the run's story, at the moment it actually returned.
  // Before this, the whole search-filter-pick sequence was reconstructed client-side from
  // one `acquire_records` row written at pick time, with every timestamp interpolated.
  ctx.events.append({
    kind: 'acquire.search',
    jobId: input.jobId,
    message: `Searched ${indexersOf(raw).length || 'no'} indexer(s) for "${label}": ${raw.length} candidate(s)`,
    data: eventEnvelope({
      scope: 'acquire',
      action: 'search',
      facts: {
        title: input.title,
        season: input.seasonNumber,
        indexers: indexersOf(raw),
        counts: { candidates: raw.length },
      },
    }),
  });

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

  // One event for the whole deterministic gate — prefilter, dedupe and cap are three
  // implementations of "what did not reach the model", and splitting them into three rows
  // would say the same thing three times. The cap keeps its `warn`: dropping viable
  // candidates for budget is the one part of this an operator may want to tune.
  ctx.events.append({
    kind: 'acquire.filter',
    ...(capDropped.length > 0 ? { level: 'warn' as const } : {}),
    jobId: input.jobId,
    message:
      capDropped.length > 0
        ? `Filtered "${label}" to ${kept.length} of ${raw.length} candidate(s), ${capDropped.length} of them dropped by the cap`
        : `Filtered "${label}" to ${kept.length} of ${raw.length} candidate(s)`,
    data: eventEnvelope({
      scope: 'acquire',
      action: 'filter',
      facts: {
        title: input.title,
        season: input.seasonNumber,
        counts: {
          candidates: raw.length,
          kept: kept.length,
          dropped: dropped.length,
          capped: capDropped.length,
        },
        reasons: topDropReasons(dropped),
      },
    }),
  });

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
    picked: {
      title: picked.title,
      indexer: picked.indexer,
      quality: picked.quality?.quality?.name,
      type: picked.fullSeason === true ? 'pack' : (picked.episodeNumbers?.length ?? 0) > 1 ? 'multi' : 'single',
    },
    kept,
    dropped,
  };
}

/** Distinct indexers a search actually answered from, in first-seen order. */
function indexersOf(candidates: ReleaseCandidate[]): string[] {
  return [...new Set(candidates.map((c) => c.indexer).filter((name) => name !== ''))];
}

/** The handful of reasons that account for most of a filter pass's drops. A drop reason
 * carries the arr's own rejection text, which is per-candidate prose — the head before the
 * first colon is the class, which is what repeats and what a human reads. */
export function topDropReasons(dropped: DroppedCandidate[], limit = 3): string[] {
  const tally = new Map<string, number>();
  for (const d of dropped) {
    const key = d.reason.split(':')[0]!.trim();
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([reason]) => reason);
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
      data: eventEnvelope(
        {
          scope: 'acquire',
          action: 'no-candidates',
          facts: { title: label, season: seasonNumber },
          verdict: { tone: 'warning' },
        },
        targetEventData(job, { ...extra, title: label }),
      ),
    });
    return;
  }
  // `data.accept` is what `POST /api/attention/:id/accept` dispatches on (`ForceGrabSchema`
  // in src/server/app.ts): the accept re-executes exactly this payload. It sits under its
  // own key rather than at `data`'s top level because the envelope owns `action` there.
  const forceGrabData = result.forceGrab
    ? {
        accept: {
          action: 'force-grab',
          instance: job.arr_instance,
          guid: result.forceGrab.guid,
          indexerId: result.forceGrab.indexerId,
          pickedTitle: result.forceGrab.title,
          releaseGroup: result.forceGrab.releaseGroup,
          ...(seasonNumber === undefined ? {} : { seasonNumber }),
        },
      }
    : {};
  ctx.events.append({
    kind: 'acquire.none-viable',
    level: 'attention',
    jobId: job.id,
    message: result.forceGrab
      ? `The model rejected every release for "${label}" (${result.reasoning}) - accept to grab "${result.forceGrab.title}" anyway`
      : `Couldn't pick a release for "${label}": ${result.reasoning}`,
    // `reasoning` and `accept` stay outside the envelope: the attention mirror stores
    // `data` as written, and the accept route re-executes `data.accept` verbatim.
    data: eventEnvelope(
      {
        scope: 'acquire',
        action: 'none-viable',
        facts: { title: label, season: seasonNumber, reason: result.reasoning },
        verdict: { tone: 'warning' },
      },
      targetEventData(job, { ...extra, title: label, reasoning: result.reasoning, ...forceGrabData }),
    ),
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
    data: eventEnvelope(
      {
        scope: 'acquire',
        action: 'record-failed',
        facts: { title: label, release: { title: pickedTitle }, error: errorMessage(err) },
        verdict: { tone: 'warning' },
      },
      targetEventData(job),
    ),
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

/** Retracts the review items this target raised, now that it no longer needs one. With a
 * `seasonNumber` it is scoped by the same season-level dedupe key
 * `appendNonGrabAttentionEvent` emits with, so settling season 1 never silences season 2;
 * without one it matches only the items stored with no key at all (a movie's, or the
 * series-level "no monitored seasons"), which no season-scoped settle can reach. */
function settleSeasonAttention(ctx: AppContext, job: JobRow, seasonNumber?: number): void {
  new AttentionItems(ctx.db).resolveForTarget({
    kinds: ['acquire.no-candidates', 'acquire.none-viable'],
    instance: job.arr_instance,
    targetKind: job.target_kind,
    targetId: job.target_id,
    dedupeKey: seasonNumber === undefined ? undefined : String(seasonNumber),
  });
}

/** The three ways a target turns out to already hold what a search would go looking for
 * (the movie's file is in place, the season's file count covers its aired episodes, or the
 * arr refused every release because of what we already hold): record the outcome, say so at
 * info level, and retract whatever review item is still open for it. Never raises attention:
 * "we already have it" is the one outcome that needs nobody. */
function recordAlreadySatisfied(
  ctx: AppContext,
  job: JobRow,
  input: { message: string; candidates: object; seasonNumber?: number; label: string },
): void {
  recordOutcome(ctx, job, {
    status: 'already-satisfied',
    candidates: input.candidates,
    label: input.label,
    seasonNumber: input.seasonNumber,
  });
  ctx.events.append({
    kind: 'acquire.already-satisfied',
    jobId: job.id,
    message: input.message,
    data: eventEnvelope(
      {
        scope: 'acquire',
        action: 'already-satisfied',
        facts: { title: input.label, season: input.seasonNumber },
        verdict: { tone: 'success' },
      },
      targetEventData(job),
    ),
  });
  settleSeasonAttention(ctx, job, input.seasonNumber);
}

/**
 * Writes the audit row AND the event that says what this scope concluded, at the moment it
 * concluded it. One call, always both: an `acquire_records` row with no matching event was
 * exactly the gap that forced the dashboard to interpolate timestamps for the search and
 * filter steps it never saw.
 *
 * This is the whole of the old `acquire.grabbed` kind, generalised — a grab is one of four
 * things a pick can conclude, not a separate kind of happening.
 */
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
  const grabbed = input.status === 'grabbed';
  ctx.events.append({
    kind: 'acquire.pick',
    jobId: job.id,
    message: grabbed
      ? `Grabbed "${input.picked?.title}" for "${input.label}"`
      : `Nothing grabbed for "${input.label}" (${input.status})`,
    data: eventEnvelope(
      {
        scope: 'acquire',
        action: 'pick',
        facts: {
          title: input.label,
          season: input.seasonNumber,
          reason: input.reasoning ?? input.status,
          ...(grabbed
            ? {
                release: {
                  title: input.picked?.title,
                  indexer: input.picked?.indexer,
                  quality: input.picked?.quality,
                  type: input.picked?.type,
                  guid: input.pickedGuid,
                  group: input.releaseGroup ?? undefined,
                },
                counts: { grabbed: 1 },
              }
            : { counts: { grabbed: 0 } }),
        },
        verdict: { tone: grabbed || input.status === 'already-satisfied' ? 'success' : 'warning' },
      },
      targetEventData(job),
    ),
  });
}
