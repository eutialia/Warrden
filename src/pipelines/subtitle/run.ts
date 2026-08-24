import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { SEARCH_CALLSITE } from '../../agent/loop.js';
import { failBackoffMs, reportAgentStop, searchSite, type SiteRunResult } from '../../agent/run.js';
import { reflectOnRun } from '../../agent/siteReflection.js';
import type { StopReason } from '../../agent/stop.js';
import type { AppContext } from '../../context.js';
import { siteKey, siteLabel } from '../../config/siteLabel.js';
import type { SubtitleSiteConfig } from '../../config/schema.js';
import { ArchiveCache, type ArchiveCacheEntry, type ArchiveCacheRow } from '../../db/archiveCache.js';
import { AttentionItems } from '../../db/attention.js';
import { PlacedFiles } from '../../db/placedFiles.js';
import { SiteProfiles, type SiteProfileRow } from '../../db/siteProfiles.js';
import type { TranscriptEntry } from '../../db/subtitleRuns.js';
import { eventEnvelope } from '../../events/envelope.js';
import { targetEventData } from '../../events/target.js';
import { atomicCopy } from '../../fs/files.js';
import { mapArrPath, safeUrlTailName } from '../../fs/paths.js';
import type { ArrApi, EpisodeResource } from '../../arr/types.js';
import { traceArrClient } from '../../arr/traced.js';
import { RescheduleError } from '../../jobs/errors.js';
import type { JobRow } from '../../jobs/queue.js';
import { decodeSubtitleBytes, parseSubtitleCues, type SubtitleCue } from '../../media/subtitles.js';
import type { MediaTools } from '../../media/tools.js';
import { resolveTargetMeta, type TargetMeta } from '../targetTitle.js';
import { assertMounted, MOUNT_RETRY_MS } from '../mounts.js';
import { SETTLE_DEADLINE_MS, SETTLE_RETRY_MS } from '../settle.js';
import { assessQueue } from '../ingest/queueState.js';
import { buildSidecarName, matchEpisodeRef } from '../ingest/sidecars.js';
import { placeBlocked, type PlaceBlock } from '../placeGuard.js';
import {
  entriesForFiles,
  extractArchive,
  isIngestibleSubtitlePayload,
  UnsupportedArchiveError,
} from './archives.js';
import { assessDrift } from './drift.js';
import { describeEpisodeRanges } from './episodeRanges.js';
import { mapArchiveWithLlm } from './mapArchive.js';
import { buildSearchHints, FRESH_DAYS, isFreshGap, type FetchedPack, type MissingSeason } from './queries.js';
import { findMissingSubtitles, langCovers } from './reconcile.js';

/** Injectable seams for `runSubtitleJob` — same injectable-factory pattern as `searchSite`'s
 * own `tiers` param (Task 8): tests stub `searchSite` to a fake that returns a pre-built
 * archive instead of running a real browser + LLM loop. */
interface RunSubtitleDeps {
  searchSite?: typeof searchSite;
  reflectOnRun?: typeof reflectOnRun;
}

/** One episode as the arr reports it: ids, its on-disk (mapped) video path, and when it
 * aired. */
interface VideoTarget {
  episodeId: number;
  seasonNumber: number;
  episodeNumber: number;
  videoPath: string;
  /** Epoch ms from Sonarr's `airDateUtc`; null when the arr does not say, and always null
   * for a movie (Radarr's movie resource carries no release date we read). */
  airedAt: number | null;
}

/** A VideoTarget the pipeline is trying to cover: which configured language tags it still
 * lacks, whether any one of them is already present, and the embedded subtitle streams (used
 * as a drift reference when present). `covered` is the line between the two jobs a run does:
 * uncovered episodes are what it goes searching for, `lacking` is what it collects from
 * whatever it finds. */
interface EpisodeTarget extends VideoTarget {
  lacking: string[];
  covered: boolean;
  embeddedRefs: { streamIndex: number; lang: string | null }[];
}

/** The verdict of the drift gate for one candidate file: what to do with it, and which on-disk
 * path to treat as the source if we place it (the original candidate, or a resynced output). */
type CandidatePlan =
  | { kind: 'place'; path: string; lang: string; offsetMs: number; drift: 'in-sync' | 'unverified' | 'resynced' }
  | { kind: 'quarantine' };

/** A candidate file as the pipeline handles it once the language gate has run: an archive
 * entry that carries a language tag, the `lang: null` case having been ruled out. */
type Candidate = ArchiveCacheEntry & { lang: string };

/**
 * Everything the per-candidate path needs that is fixed for the whole run: the media tools,
 * the placement ledger, this run's scratch dirs, the extracted-reference cache, and the
 * per-episode tally of candidates set aside. Bundled rather than passed as eleven positional
 * arguments through four call layers.
 */
interface RunState {
  media: MediaTools;
  placedFiles: PlacedFiles;
  /** Every episode of the target that has a video on disk, lacking anything or not. `gaps`
   * shrinks as the run places files and never held the episodes an earlier run already filled,
   * so it cannot answer "does this filename name an episode of this show at all?" — which is
   * the question that decides whether a file is worth an LLM call (see `routeEntry`). */
  allEpisodes: VideoTarget[];
  /** videoPath -> extracted reference subtitle path, cached for the whole run so a video with
   * an embedded track is only ever extracted once no matter how many candidates it's tried
   * against (or how many resync rounds each triggers). */
  refCache: Map<string, string>;
  refDir: string;
  rawDir: string;
  /** episodeId -> how many candidates were quarantined for it this run, for the end-of-run
   * rollup (the per-candidate events are warn-level and carry no attention item). */
  quarantined: Map<number, number>;
  /** episodeId -> how many candidates got as far as the drift gate for it this run, which is
   * what `MAX_CANDIDATES_PER_EPISODE` counts. Only the expensive path is tallied: a file in
   * the wrong language, one that vanished, one whose destination is spoken for, all cost
   * nothing and are not attempts. */
  attempts: Map<number, number>;
}

/**
 * How many candidates one episode is worth per run. Every one past the cheap gates costs a
 * drift assessment and, when it drifts, an alass run plus an ffsubsync run against the
 * video: call it half a minute each. A big pack holds twenty releases of the same episode,
 * and a job that spends twelve minutes failing on three stragglers is twelve minutes it did
 * not spend on the three seasons that had nothing at all. Four is enough for the case this
 * is really for (the pack holds one good copy behind a few bad ones), and cheap to lose.
 */
export const MAX_CANDIDATES_PER_EPISODE = 4;

/**
 * The subtitle pipeline runner for a series or movie target. Mounts-guard, waits out an arr
 * that is still importing this target (`settleGate`), reconciles
 * which videos still lack the target languages via `findMissingSubtitles`, checks the
 * per-target archive cache, searches each configured site for what's still missing, and
 * drift-gates + places every candidate with full `placed_files` provenance.
 *
 * A video the arr lists but that is not on disk is skipped, and when that is every video the
 * run stops with a `subtitle.videos-unreachable` attention item rather than reporting a fully
 * covered library.
 *
 * Movies: one video slot (the arr's movie file); archive files map onto that single slot.
 * Series: per-episode matching as before. Ingest sidecars still cover packs that already
 * shipped `.srt`/`.ass`; site search covers the rest (design: movie no-op was a bug).
 *
 * Only files tagged with a language the operator asked for are ever considered: a pack is
 * mostly other people's languages, and placing an untagged file as if it were the missing
 * one is how a library ends up with Japanese subtitles filed as Chinese.
 *
 * The drift gate decides per candidate whether to place as-is (`in-sync`), resync
 * (alass then ffsubsync) and place, or quarantine. No embedded reference → place
 * `unverified`. Whatever is still uncovered after the cache and every site becomes ONE
 * `subtitle.unresolved` attention item for the job, not one per episode.
 */
export async function runSubtitleJob(ctx: AppContext, job: JobRow, deps: RunSubtitleDeps = {}): Promise<void> {
  const rawClient = ctx.clients.get(job.arr_instance);
  if (!rawClient) {
    throw new Error(`No arr client configured for instance "${job.arr_instance}"`);
  }
  // Wrapped once so every arr call this job makes (resolveTargetMeta, listVideoTargets, ...)
  // traces without each site opting in, same as acquire and ingest.
  const client = traceArrClient(rawClient, ctx.trace, job.id);

  assertMounted(ctx, job, 'subtitle');
  if (await settleGate(ctx, job, client)) return;

  const media = requireMedia(ctx);
  await assertProbeAvailable(ctx, job, media);

  const placedFiles = new PlacedFiles(ctx.db);
  const cache = new ArchiveCache(ctx.db);

  // This run's own scratch under dataDir: reference extractions + resync outputs + raw
  // downloads. Everything under here is ours to delete in the finally below; the archive
  // cache (dataDir/subtitle/cache) and quarantine live OUTSIDE it so they persist.
  const runDir = join(ctx.dataDir, 'subtitle', 'runs', String(job.id));
  mkdirSync(runDir, { recursive: true });
  const refDir = join(runDir, 'refs');
  const rawDir = join(runDir, 'downloads');
  mkdirSync(refDir, { recursive: true });
  mkdirSync(rawDir, { recursive: true });

  try {
    const meta = await resolveTargetMeta(client, job);
    const title = meta.title;
    const targets = await listVideoTargets(ctx, client, job);

    if (targets.length === 0) {
      ctx.events.append({
        kind: 'subtitle.complete',
        jobId: job.id,
        message: `No on-disk videos for "${title}" to subtitle`,
        data: targetEventData(job, { counts: { missing: 0, placed: 0 } }),
      });
      return;
    }

    const { videos: gapList, absent } = await findMissingSubtitles({
      videos: targets.map((t) => ({ videoPath: t.videoPath, episodeId: t.episodeId })),
      languages: ctx.config.subtitle.languages,
      media,
    });

    // Every video gone at once is not a library that emptied itself, it is a path that does
    // not resolve: a wrong `pathMappings` entry, or a share the arr can see and we cannot.
    // Reporting it as "nothing missing" is how a whole series silently never gets subtitles.
    if (absent.length === targets.length) {
      ctx.events.append({
        kind: 'subtitle.videos-unreachable',
        level: 'attention',
        jobId: job.id,
        message: `None of the ${targets.length} video files for "${title}" exist at their mapped paths (first: ${absent[0]}). Check Settings, Path mappings.`,
        data: targetEventData(job, { absent: absent.slice(0, 5), total: targets.length }),
      });
      return;
    }
    if (absent.length > 0) {
      ctx.events.append({
        kind: 'subtitle.videos-absent',
        level: 'warn',
        jobId: job.id,
        message: `${absent.length} of ${targets.length} video files for "${title}" are not at their mapped paths (first: ${absent[0]}); carrying on with the rest`,
        data: targetEventData(job, { absent: absent.slice(0, 5), total: targets.length }),
      });
    }
    const state: RunState = {
      media,
      placedFiles,
      refCache: new Map(),
      refDir,
      rawDir,
      quarantined: new Map(),
      attempts: new Map(),
      allEpisodes: targets,
    };

    const byVideoPath = new Map(gapList.map((g) => [g.videoPath, g]));
    const gaps: EpisodeTarget[] = targets
      .filter((t) => byVideoPath.has(t.videoPath))
      .map((t) => {
        const g = byVideoPath.get(t.videoPath)!;
        return { ...t, lacking: g.lacking, covered: g.covered, embeddedRefs: g.embeddedRefs };
      });

    const langs = describeLanguages(ctx.config.subtitle.languages);
    const withoutSubs = uncovered(gaps);
    if (withoutSubs.length > 0) {
      ctx.events.append({
        kind: 'subtitle.missing',
        jobId: job.id,
        message: `${withoutSubs.length} video(s) without subtitles in ${langs}`,
        data: targetEventData(job, {
          counts: { missing: withoutSubs.length, byEpisode: withoutSubs.map((t) => t.episodeId) },
        }),
      });
    }

    // Cache pass first — a previously-downloaded pack can cover a mid-season episode that
    // landed after the pack was fetched, avoiding a re-download. It runs even when every
    // episode is already covered: reading packs we already hold costs nothing, and it is the
    // only way a lower-preference tag is ever collected for a series nobody has to search for.
    for (const row of cache.forTarget(job.arr_instance, job.target_kind, job.target_id)) {
      if (gaps.length === 0) break;
      const { resolved } = await matchArchiveRow(ctx, job, row, gaps, title, state, undefined);
      if (resolved.length > 0) {
        ctx.events.append({
          kind: 'subtitle.cache-hit',
          jobId: job.id,
          message: `Covered ${resolved.length} video(s) from the cached archive "${basename(row.path)}"`,
          data: targetEventData(job, { count: resolved.length, episodeIds: resolved, archive: row.path }),
        });
      }
    }

    // Only an uncovered episode is worth a site search, and nothing the cache pass does can
    // uncover one — so a run that opened with everything covered ends here.
    if (withoutSubs.length === 0) {
      resolveUnresolved(ctx, job);
      ctx.events.append({
        kind: 'subtitle.complete',
        jobId: job.id,
        message: `Nothing missing — every video already has subtitles in ${langs}`,
        data: targetEventData(job, { counts: { missing: 0, placed: 0 } }),
      });
      return;
    }

    await siteSearchPass(ctx, job, meta, gaps, state, cache, deps);

    const stillMissing = uncovered(gaps);
    if (stillMissing.length > 0) raiseUnresolved(ctx, job, title, stillMissing, state.quarantined);
    else resolveUnresolved(ctx, job);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

/**
 * The same wait ingest opens a run with, for the same reason one level down: a subtitle job
 * enqueued off one season's import can be claimed while the arr is still moving the next
 * season's files, and reconciling "what is missing" against a half-imported library sends the
 * agent hunting for episodes that are seconds from existing.
 *
 * Returns `true` when the caller must stop without doing anything — the deadline has passed
 * and a human now owns it. A `busy` verdict inside the deadline throws `RescheduleError`,
 * which is not a retry: the runner never counts it against `attempts`, so
 * `SETTLE_DEADLINE_MS` against `job.created_at` is the only thing bounding the wait.
 */
async function settleGate(ctx: AppContext, job: JobRow, client: ArrApi): Promise<boolean> {
  const assessment = assessQueue(await client.listQueue(), { kind: job.target_kind, id: job.target_id });
  if (assessment.state !== 'busy') return false;

  if (Date.now() - job.created_at > SETTLE_DEADLINE_MS) {
    ctx.events.append({
      kind: 'subtitle.settle-timeout',
      level: 'attention',
      jobId: job.id,
      message: `Gave up waiting for Sonarr/Radarr to finish importing before searching for subtitles (still busy after ${Math.round(SETTLE_DEADLINE_MS / 3_600_000)}h) — check the download queue there`,
      data: targetEventData(job),
    });
    return true;
  }

  ctx.trace.event({ jobId: job.id, kind: 'pipeline.wait', summary: 'waiting for arr import to settle' });
  throw new RescheduleError('arr still importing this target', SETTLE_RETRY_MS);
}

/** Series: every hasFile episode with an episode file. Movie: the single movie file, if any.
 * `episodeId` for movies is the movie id so resolved tracking / attention de-dup still work. */
async function listVideoTargets(ctx: AppContext, client: ArrApi, job: JobRow): Promise<VideoTarget[]> {
  if (job.target_kind === 'movie') {
    const movieFiles = await client.listMovieFiles(job.target_id);
    const file = movieFiles[0];
    if (!file) return [];
    return [
      {
        episodeId: job.target_id,
        seasonNumber: 0,
        episodeNumber: 0,
        videoPath: mapArrPath(ctx.config.pathMappings, file.path),
        airedAt: null,
      },
    ];
  }

  const [episodes, episodeFiles] = await Promise.all([client.listEpisodes(job.target_id), client.listEpisodeFiles(job.target_id)]);
  const byFileId = new Map(episodeFiles.map((f) => [f.id, f]));
  return episodes
    .filter((e) => e.hasFile && byFileId.has(e.episodeFileId))
    .map((e) => {
      const file = byFileId.get(e.episodeFileId)!;
      return {
        episodeId: e.id,
        seasonNumber: e.seasonNumber,
        episodeNumber: e.episodeNumber,
        videoPath: mapArrPath(ctx.config.pathMappings, file.path),
        airedAt: parseAirDate(e.airDateUtc),
      };
    });
}

/** Sonarr's `airDateUtc` as epoch ms. An absent or unparseable date is null, never a NaN
 * that would silently read as "aired at the epoch". */
function parseAirDate(airDateUtc: string | undefined): number | null {
  if (airDateUtc === undefined) return null;
  const ms = Date.parse(airDateUtc);
  return Number.isNaN(ms) ? null : ms;
}

/** The configured languages as a human reads the any-of rule: `zh-Hans or zh-Hant`. */
function describeLanguages(langs: string[]): string {
  return langs.length > 0 ? langs.join(' or ') : 'the target';
}

/** The targets a site search is actually for. A covered episode still lacking a lower-
 * preference tag rides along with whatever the search brings back, but it is not a reason to
 * go looking, and it is not something a human is asked to act on. */
function uncovered(gaps: EpisodeTarget[]): EpisodeTarget[] {
  return gaps.filter((t) => !t.covered);
}

/**
 * The run's one "still not covered" attention item. One per job, not one per episode: a
 * four-season series that found nothing is a single fact a human acts on once, and the
 * per-episode variant is what filled the queue with hundreds of identical cards. The detail
 * survives in `data.episodes` — which episodes are still uncovered, and how many candidates
 * were set aside for each this run — for the dashboard to expand.
 */
function raiseUnresolved(
  ctx: AppContext,
  job: JobRow,
  title: string,
  missing: EpisodeTarget[],
  quarantined: Map<number, number>,
): void {
  const episodes = missing.map((t) => ({
    episodeId: t.episodeId,
    seasonNumber: t.seasonNumber,
    episodeNumber: t.episodeNumber,
    quarantined: quarantined.get(t.episodeId) ?? 0,
  }));
  const langs = describeLanguages(ctx.config.subtitle.languages);
  // A movie has exactly one target, so episode ranges say nothing; the candidate count is
  // the only thing that distinguishes "nothing was ever found" from "nothing survived".
  const message =
    job.target_kind === 'movie'
      ? `${title}: still without ${langs} (${episodes[0]?.quarantined ?? 0} candidate(s) set aside)`
      : `${title}: ${missing.length} episode(s) still without ${langs} (${describeEpisodeRanges(missing)})`;

  ctx.events.append({
    kind: 'subtitle.unresolved',
    level: 'attention',
    jobId: job.id,
    message,
    data: targetEventData(job, { dedupeKey: 'unresolved', episodes }),
  });
}

/** Retracts the target's standing `subtitle.unresolved` item once a run confirms every
 * video is covered. Subtitles can land without Warrden placing them (an operator dropping
 * sidecars in by hand, another tool writing into the library), and `raiseUnresolved`'s
 * dedupe only ever REFRESHES the open row — without this, the review item outlives the
 * problem forever. Called only where coverage was actually reconciled this run: the
 * no-videos / unreachable / settle-timeout exits confirm nothing and retract nothing. */
function resolveUnresolved(ctx: AppContext, job: JobRow): void {
  new AttentionItems(ctx.db).resolveForTarget({
    kinds: ['subtitle.unresolved'],
    instance: job.arr_instance,
    targetKind: job.target_kind,
    targetId: job.target_id,
    dedupeKey: 'unresolved',
  });
}

/** The seasons still uncovered when the site search starts, each with the titles that season
 * alone is released under. A multi-cour show is indexed under a different name per season, so
 * "keep looking for season 3" is only actionable with season 3's own title beside it. */
function summarizeMissingSeasons(
  missing: EpisodeTarget[],
  seasonTitles: Map<number, string[]>,
  now = Date.now(),
): MissingSeason[] {
  const bySeason = new Map<number, EpisodeTarget[]>();
  for (const t of missing) bySeason.set(t.seasonNumber, [...(bySeason.get(t.seasonNumber) ?? []), t]);
  return [...bySeason.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([seasonNumber, episodes]) => ({
      seasonNumber,
      episodeNumbers: episodes.map((t) => t.episodeNumber).sort((a, b) => a - b),
      newestAiredDaysAgo: newestAiredDaysAgo(episodes, now),
      titles: seasonTitles.get(seasonNumber) ?? [],
    }));
}

/** Days since the most recent air date among these episodes, floored; null when none of
 * them carries one. An episode that has not aired yet floors to 0 — "today" — rather than
 * reading as a negative age. */
function newestAiredDaysAgo(episodes: EpisodeTarget[], now: number): number | null {
  const dates = episodes.map((t) => t.airedAt).filter((d): d is number => d !== null);
  if (dates.length === 0) return null;
  return Math.max(0, Math.floor((now - Math.max(...dates)) / (24 * 3_600_000)));
}

function requireMedia(ctx: AppContext): MediaTools {
  if (!ctx.media) throw new Error('subtitle pipeline requires ctx.media (MediaTools)');
  return ctx.media;
}

/**
 * ffprobe is the pipeline's only way to see a video's embedded subtitle tracks, so without
 * it reconcile can't tell a covered video from an uncovered one. Same shape as the storage
 * guard in `assertMounted`: an attention event plus an uncounted, fixed-delay reschedule
 * that pauses the pipeline until a human installs ffmpeg. The resync tools (alass,
 * ffsubsync) are deliberately not checked here: a missing one degrades to quarantining that
 * candidate, which is a per-candidate outcome rather than a reason to stop the job.
 */
async function assertProbeAvailable(ctx: AppContext, job: JobRow, media: MediaTools): Promise<void> {
  const avail = await media.available();
  if (avail.ffprobe) return;
  ctx.events.append({
    kind: 'subtitle.tool-missing',
    level: 'attention',
    jobId: job.id,
    message: 'Subtitle search paused: ffprobe is not on PATH. Install ffmpeg (it ships ffprobe) where Warrden runs, then retry.',
    data: targetEventData(job, { missing: ['ffprobe'] }),
  });
  throw new RescheduleError('ffprobe missing', MOUNT_RETRY_MS);
}

/**
 * After a successful place, drops the tag `placedLang` filled from the episode's `lacking`
 * set (same rule as reconcile). The first placement covers the episode — one tag is enough —
 * and that is what `resolved` reports back. The episode stays a placement target while it
 * still lacks something, so later files in this pack (and the LLM remainder pass) can add
 * zh-Hant to an episode this run just gave zh-Hans; it drops out of `gaps` only once it
 * lacks nothing.
 */
function notePlacement(gaps: EpisodeTarget[], resolved: number[], t: EpisodeTarget, placedLang: string): void {
  t.lacking = t.lacking.filter((want) => !langCovers(want, placedLang));
  if (!t.covered) {
    t.covered = true;
    resolved.push(t.episodeId);
  }
  if (t.lacking.length === 0) {
    const i = gaps.indexOf(t);
    if (i >= 0) gaps.splice(i, 1);
  }
}

/**
 * The files in an archive worth spending anything on: a candidate has to carry a language
 * tag, and that tag has to cover one of the configured languages. Everything else — untagged
 * files, a Japanese track in a Chinese-only config, a pack's bonus material — is dropped
 * here: before matching, before the LLM remainder call, and long before any probe or resync.
 * A big pack is mostly files nobody asked for, so this is the ordinary case rather than news:
 * one trace line for the whole archive, no event.
 */
function wantedCandidates(ctx: AppContext, job: JobRow, row: ArchiveCacheRow): Candidate[] {
  const languages = ctx.config.subtitle.languages;
  const wanted = row.files.filter(
    (f): f is Candidate => f.lang !== null && languages.some((want) => langCovers(want, f.lang)),
  );
  const dropped = row.files.length - wanted.length;
  if (dropped > 0) {
    ctx.trace.event({
      jobId: job.id,
      kind: 'subtitle.filter',
      summary: `skipped ${dropped} file(s) in no configured language`,
      payload: () => ({ archive: row.path, kept: wanted.length, dropped }),
    });
  }
  return wanted;
}

/** Whether this candidate is worth trying against this episode: its language has to be one
 * the episode still lacks. `wantedCandidates` has already checked it against the configured
 * set; this narrows to what THIS episode lacks (a zh-Hans file is worth nothing to an episode
 * that already carries zh-Hans, covered or not). */
function wantedFor(entry: Candidate, t: EpisodeTarget): boolean {
  return t.lacking.some((want) => langCovers(want, entry.lang));
}

/**
 * Matches one archive's files (from a cached row, or a just-downloaded+extracted pack) to the
 * episodes still lacking a language and drift-gates + places each match. Deterministic matching first
 * (via the entry's pre-parsed `episodeRef`), then one `mapArchiveWithLlm` call for whatever's
 * left — mirroring ingest's match-then-LLM ordering. "Whatever's left" is narrower than
 * "everything that didn't match": see `routeEntry` for what gets dropped before the paid call.
 *
 * Returns two different counts, for two different callers: `resolved` is the episode ids this
 * call took from uncovered to covered — what the cache-hit event reports. `placedCount` is how
 * many individual files this call placed on disk, newly covering an episode or merely adding a
 * second language to one — the number `extractAndMatch` needs, since any file landing is a
 * real, verifiable placement (see the design doc's "Writing" section).
 */
async function matchArchiveRow(
  ctx: AppContext,
  job: JobRow,
  row: ArchiveCacheRow,
  gaps: EpisodeTarget[],
  seriesTitle: string,
  state: RunState,
  site: string | undefined,
): Promise<{ resolved: number[]; placedCount: number }> {
  const candidates = wantedCandidates(ctx, job, row);
  const entryByPath = new Map(candidates.map((f) => [f.path, f]));
  const resolved: number[] = [];
  let placedCount = 0;

  const unmatchedPaths: string[] = [];
  let covered = 0;
  for (const entry of candidates) {
    if (gaps.length === 0) break;
    const route = routeEntry(entry, gaps, state.allEpisodes, job.target_kind === 'movie');
    if (route.kind === 'covered') {
      covered++;
      continue;
    }
    if (route.kind === 'llm') {
      unmatchedPaths.push(entry.path);
      continue;
    }
    const placedLang = await driftAndPlace(ctx, job, row, entry, route.target, state, site);
    if (placedLang !== undefined) {
      placedCount++;
      notePlacement(gaps, resolved, route.target, placedLang);
    }
  }
  if (covered > 0) {
    ctx.trace.event({
      jobId: job.id,
      kind: 'subtitle.filter',
      summary: `skipped ${covered} file(s) naming episodes already covered`,
      payload: () => ({ archive: row.path, covered }),
    });
  }

  // Movies: a single video slot — every remaining archive file targets that one video
  // (lang filtering is via notePlacement shrinking `lacking`).
  if (job.target_kind === 'movie' && unmatchedPaths.length > 0 && gaps[0]) {
    const only = gaps[0];
    for (const path of unmatchedPaths) {
      // notePlacement may have removed `only` from `gaps` once every language is filled.
      if (!gaps.includes(only)) break;
      const entry = entryByPath.get(path)!;
      const placedLang = await driftAndPlace(ctx, job, row, entry, only, state, site);
      if (placedLang !== undefined) {
        placedCount++;
        notePlacement(gaps, resolved, only, placedLang);
      }
    }
    return { resolved, placedCount };
  }

  if (unmatchedPaths.length > 0 && gaps.length > 0) {
    const unmatchedEntries = unmatchedPaths.map((p) => entryByPath.get(p)!);
    const ids = await mapArchiveWithLlm({
      llm: ctx.llm,
      seriesTitle,
      files: unmatchedEntries,
      rootDir: row.path,
      episodes: gaps.map((m) => ({
        id: m.episodeId,
        seriesId: job.target_id,
        seasonNumber: m.seasonNumber,
        episodeNumber: m.episodeNumber,
        title: '',
        episodeFileId: 0,
        hasFile: true,
      })),
      jobId: job.id,
    });
    const episodesById = new Map(gaps.map((m) => [m.episodeId, m]));
    for (let i = 0; i < unmatchedEntries.length; i++) {
      const episodeId = ids[i] ?? null;
      if (episodeId === null) continue;
      const t = episodesById.get(episodeId);
      // Episode may already lack nothing after an earlier file in this pack (and have been
      // removed from `gaps`); skip rather than re-placing over a closed gap.
      if (!t) continue;
      const placedLang = await driftAndPlace(ctx, job, row, unmatchedEntries[i]!, t, state, site);
      if (placedLang !== undefined) {
        placedCount++;
        notePlacement(gaps, resolved, t, placedLang);
      }
    }
  }

  return { resolved, placedCount };
}

/** What happens to one archive entry: place it against an episode, hand it to the LLM
 * mapper, or drop it because the episode it names is already covered. */
type EntryRoute =
  | { kind: 'match'; target: EpisodeTarget }
  | { kind: 'llm' }
  | { kind: 'covered' };

/**
 * Routes one archive entry.
 *
 * The `covered` verdict is the point of this function. `gaps` holds only the episodes the
 * run still wants a file for, so matching against it alone reads every file for an
 * already-filled episode as "unmatched" — and on a re-run against a cached 1,500-file pack
 * that is most of the pack, several hundred files handed to `mapArchiveWithLlm` in batches
 * to learn what their own filenames already said. Resolving the ref against every episode on disk tells
 * "this names an episode we have covered" apart from "this names nothing this show has", and
 * only the second is worth paying for.
 *
 * A season the entry names outright that no gap belongs to is the same fact one level up:
 * whichever episode of season 1 this is, season 1 is done.
 *
 * Movies keep the old path: one video slot, no episode refs to resolve, and the caller's
 * movie branch tries every leftover file against that slot itself.
 */
function routeEntry(entry: Candidate, gaps: EpisodeTarget[], all: VideoTarget[], isMovie: boolean): EntryRoute {
  const direct = matchDeterministic(gaps, entry, isMovie);
  if (direct) return { kind: 'match', target: direct };
  if (isMovie) return { kind: 'llm' };

  const ref = entry.episodeRef;
  if (ref === null) return { kind: 'llm' };

  const hit = matchEpisodeRef(ref, asEpisodeResources(all));
  if (hit !== null) {
    const stillWanted = gaps.find((m) => m.episodeId === hit.id);
    return stillWanted ? { kind: 'match', target: stillWanted } : { kind: 'covered' };
  }
  if (ref.season !== null && !gaps.some((m) => m.seasonNumber === ref.season)) return { kind: 'covered' };
  return { kind: 'llm' };
}

/** Episode targets in the shape `matchEpisodeRef` reads. Only the season/episode numbers and
 * the id carry meaning here; the rest of `EpisodeResource` exists to satisfy the type. */
function asEpisodeResources(targets: VideoTarget[]): EpisodeResource[] {
  return targets.map((m) => ({
    id: m.episodeId,
    seriesId: 0,
    seasonNumber: m.seasonNumber,
    episodeNumber: m.episodeNumber,
    title: '',
    episodeFileId: 0,
    hasFile: true,
  }));
}

/** Deterministically matches an archive entry to an episode still lacking something, using the ref
 * `entriesForFiles` already parsed at cache-write time — that ref carries the season the
 * pack's directory names implied, which re-parsing the basename here would throw away.
 * Matching itself is ingest's own `matchEpisodeRef` (same season/episode/absolute rules).
 * Movies with a single open slot always match that slot. Returns null when nothing matches. */
function matchDeterministic(gaps: EpisodeTarget[], entry: ArchiveCacheEntry, isMovie: boolean): EpisodeTarget | null {
  if (isMovie && gaps.length === 1) return gaps[0]!;
  if (entry.episodeRef === null) return null;
  const hit = matchEpisodeRef(entry.episodeRef, asEpisodeResources(gaps));
  return hit ? gaps.find((m) => m.episodeId === hit.id) ?? null : null;
}

/** The sidecar path a candidate would land at, derived from the candidate alone: its own
 * language tag and its own extension, both of which a resync output keeps. Knowing the
 * destination without running the drift gate is what lets the collision guards fire before
 * any media work. */
function destinationFor(videoPath: string, entry: Candidate): string {
  const ext = extname(entry.path).toLowerCase() || '.srt';
  return join(dirname(videoPath), buildSidecarName(basename(videoPath), { lang: entry.lang, ext }));
}

/** The warn event for a placement one of the guards stopped: a file Warrden didn't place
 * already sits at the destination, or another source already claims it. */
function reportBlocked(ctx: AppContext, job: JobRow, block: PlaceBlock, sourcePath: string, targetPath: string): void {
  const targetName = basename(targetPath);
  const message =
    block.kind === 'foreign'
      ? `Skipped "${basename(sourcePath)}" — "${targetName}" already exists and wasn't placed by Warrden`
      : `Skipped "${basename(sourcePath)}" — "${targetName}" is already claimed by "${block.claimedBy}"`;
  ctx.events.append({
    kind: block.kind === 'foreign' ? 'subtitle.skipped-foreign' : 'subtitle.skipped-collision',
    level: 'warn',
    jobId: job.id,
    message,
    data: targetEventData(job, { sourcePath, targetPath }),
  });
}

/**
 * The gates + placement for one candidate file against one episode. Returns the language tag
 * that was placed (which the caller uses to shrink the episode's `lacking` set), or
 * `undefined` when nothing was placed.
 *
 * The cheap gates run first and in this order, because everything after them costs real
 * time: a language nobody asked for, a candidate that vanished, a destination already
 * spoken for. Only then the drift gate, in the order the design calls for: no reference ->
 * place unverified; in-sync -> place; drifted -> resyncAlass then re-assess -> place or try
 * resyncFfsubsync -> re-assess -> place or quarantine; unscorable -> quarantine.
 *
 * A quarantined / skipped candidate returns `undefined`: the episode's gap is untouched, so
 * it stays in the working set and (if nothing else covers it) lands in the run's
 * `subtitle.unresolved` rollup — quarantining a bad candidate is not "this gap is filled".
 */
async function driftAndPlace(
  ctx: AppContext,
  job: JobRow,
  row: ArchiveCacheRow,
  entry: Candidate,
  t: EpisodeTarget,
  state: RunState,
  site: string | undefined,
): Promise<string | undefined> {
  // A file in a language this episode doesn't need is the common case in any pack that
  // carries more than one — no event, not even a trace line of its own.
  if (!wantedFor(entry, t)) return undefined;

  // A candidate that no longer exists (already quarantined by an earlier run, or the cache
  // row is stale) is not a failure worth reporting — just skip it.
  if (!existsSync(entry.path)) return undefined;

  const targetPath = destinationFor(t.videoPath, entry);
  const blocked = placeBlocked(state.placedFiles, targetPath, entry.path);
  if (blocked) {
    reportBlocked(ctx, job, blocked, entry.path, targetPath);
    return undefined;
  }

  // Everything below here is measured in tens of seconds, so this is where the cap sits:
  // after the free gates, before the first probe/resync of this candidate.
  const tried = state.attempts.get(t.episodeId) ?? 0;
  if (tried >= MAX_CANDIDATES_PER_EPISODE) return undefined;
  state.attempts.set(t.episodeId, tried + 1);

  const plan = await decideCandidate(entry, t, state);
  if (plan.kind === 'quarantine') {
    // A covered episode is already watchable; a candidate that fails to add a second
    // language to it is nothing to warn about and nothing to set aside. Only an episode
    // with no subtitles at all reaches the rollup, so only that one earns these events.
    if (!t.covered) {
      quarantine(ctx, job, state, t, entry.path);
      // The trip fires here rather than at the first skipped candidate, so it is exactly one
      // event per episode whether the pack held five more candidates or none.
      if (tried + 1 === MAX_CANDIDATES_PER_EPISODE) reportCapped(ctx, job, t);
    }
    return undefined;
  }

  return placeSubtitle(ctx, job, state, t, targetPath, plan, row, entry, site);
}

/** The warn event for an episode that has used up its candidates. Warn like the quarantines
 * it follows, and for the same reason: the human-facing fact is the run's one
 * `subtitle.unresolved` rollup, which counts these candidates per episode. This event is what
 * makes that rollup explicable, since "nothing was found" and "four things were found and
 * none of them fit" look identical from outside without it. */
function reportCapped(ctx: AppContext, job: JobRow, t: EpisodeTarget): void {
  const label = job.target_kind === 'movie' ? basename(t.videoPath) : describeEpisodeRanges([t]);
  ctx.events.append({
    kind: 'subtitle.candidates-capped',
    level: 'warn',
    jobId: job.id,
    message: `${label}: ${MAX_CANDIDATES_PER_EPISODE} candidates tried, none verified; giving up on it this run`,
    data: targetEventData(job, { episodeId: t.episodeId, tried: MAX_CANDIDATES_PER_EPISODE }),
  });
}

/** Runs the drift gate for one candidate, returning what to do with it (and the source path
 * to place — the original, or a resynced output — plus the offset/drift labels for the event
 * and provenance). */
async function decideCandidate(entry: Candidate, t: EpisodeTarget, state: RunState): Promise<CandidatePlan> {
  const { media } = state;
  // No embedded reference track -> nothing to compare against; place unverified (VAD stays a
  // future tier). This is also the fallback when the extracted reference turns out unreadable.
  const refCues = await referenceCues(t, state);
  if (refCues === null) {
    return { kind: 'place', path: entry.path, lang: entry.lang, offsetMs: 0, drift: 'unverified' };
  }

  const candCues = parseSubtitleCues(decodeSubtitleBytes(readFileSync(entry.path)));
  const first = assessDrift(refCues, candCues);

  if (first.state === 'in-sync') {
    return { kind: 'place', path: entry.path, lang: entry.lang, offsetMs: first.offsetMs, drift: 'in-sync' };
  }
  if (first.state === 'unscorable') {
    return { kind: 'quarantine' };
  }

  // drifted: resync against the video, then re-assess; fall back from alass to ffsubsync. The
  // resync reference is the video path itself (alass accepts a video as its reference).
  const resyncDir = join(state.rawDir, 'resync', String(t.episodeId));
  mkdirSync(resyncDir, { recursive: true });
  const c = await tryResyncPipeline(entry.path, entry.lang, t, refCues, media, resyncDir);
  if (c === null) return { kind: 'quarantine' };
  return c;
}

/** Extracts the episode video's first embedded subtitle track to a per-run temp path once
 * (cached per video), then parses it. `null` when there's no embedded reference at all, or
 * the extraction produced nothing parseable — the caller treats `null` as "no usable
 * reference", placing the candidate unverified rather than failing the whole gate on one
 * broken video. */
async function referenceCues(t: EpisodeTarget, state: RunState): Promise<SubtitleCue[] | null> {
  const { media, refCache, refDir } = state;
  if (t.embeddedRefs.length === 0) return null;
  let refPath: string;
  if (refCache.has(t.videoPath)) {
    refPath = refCache.get(t.videoPath)!;
  } else {
    // `.srt` chosen as the muxer despite the source possibly being ASS: ffmpeg converts on the
    // way out, and parseSubtitleCues auto-detects by content anyway, so the timing cues that
    // drive drift scoring are preserved regardless of the container.
    refPath = join(refDir, `${sanitizeFilename(basename(t.videoPath))}.srt`);
    try {
      await media.extractSubtitle(t.videoPath, t.embeddedRefs[0]!.streamIndex, refPath);
      refCache.set(t.videoPath, refPath);
    } catch {
      // Extraction failed (e.g. the stream index vanished) — no usable reference this run.
      return null;
    }
  }
  const cues = parseSubtitleCues(decodeSubtitleBytes(readFileSync(refPath)));
  return cues.length > 0 ? cues : null;
}


/** Tries alass then, if the result still isn't in-sync, ffsubsync; returns the place-plan for
 * the first that lands in-sync, or null if both fail to reach in-sync. Degrades gracefully
 * when a resync binary is missing (or fails): a missing alass skips straight to ffsubsync,
 * and both missing returns null so the caller quarantines — a missing/failed binary never
 * kills the job (see CliMediaTools' availability contract). */
async function tryResyncPipeline(
  entryPath: string,
  lang: string,
  t: EpisodeTarget,
  refCues: SubtitleCue[],
  media: MediaTools,
  resyncDir: string,
): Promise<CandidatePlan | null> {
  const ext = extname(entryPath).toLowerCase() || '.srt';
  const base = sanitizeFilename(basename(entryPath).replace(/\.[^.]+$/, ''));

  const avail = await media.available();
  if (!avail.alass && !avail.ffsubsync) return null; // no resync tool at all -> quarantine

  // Attempt 1: alass, reference = the video. Skipped when alass isn't on PATH; a throw
  // (missing binary, or a failed run) also falls through to the ffsubsync attempt.
  if (avail.alass) {
    const alassOut = join(resyncDir, `${base}-alass${ext}`);
    let alassOk = false;
    try {
      await media.resyncAlass({ reference: t.videoPath, subtitle: entryPath, outPath: alassOut });
      alassOk = true;
    } catch {
      // alass failed (not installed despite availability, or errored) -> try ffsubsync.
    }
    if (alassOk) {
      const afterAlass = assessDrift(refCues, parseSubtitleCues(decodeSubtitleBytes(readFileSync(alassOut))));
      if (afterAlass.state === 'in-sync') {
        return { kind: 'place', path: alassOut, lang, offsetMs: afterAlass.offsetMs, drift: 'resynced' };
      }
    }
  }

  // Attempt 2: ffsubsync (aligns to the video's audio), then re-assess.
  if (!avail.ffsubsync) return null;
  const ffOut = join(resyncDir, `${base}-ffsubsync${ext}`);
  try {
    await media.resyncFfsubsync({ videoPath: t.videoPath, subtitlePath: entryPath, outPath: ffOut });
  } catch {
    return null; // ffsubsync failed -> caller quarantines
  }
  const afterFf = assessDrift(refCues, parseSubtitleCues(decodeSubtitleBytes(readFileSync(ffOut))));
  if (afterFf.state === 'in-sync') {
    return { kind: 'place', path: ffOut, lang, offsetMs: afterFf.offsetMs, drift: 'resynced' };
  }

  return null; // neither tool reached in-sync -> caller quarantines
}

/**
 * Moves an unusable candidate (unscorable, or never landable in-sync after both resync
 * tools) into `dataDir/quarantine/` and records it against its episode.
 *
 * Warn, not attention: one pack that doesn't fit a library can set aside hundreds of files
 * in a single run, and each of those is a symptom of one fact, not a thing to click. The
 * fact reaches a human through the run's single `subtitle.unresolved` rollup, which reports
 * this tally per episode.
 */
function quarantine(ctx: AppContext, job: JobRow, state: RunState, t: EpisodeTarget, entryPath: string): void {
  const quarantineDir = join(ctx.dataDir, 'subtitle', 'quarantine');
  mkdirSync(quarantineDir, { recursive: true });
  let dest = join(quarantineDir, basename(entryPath));
  let i = 1;
  while (existsSync(dest)) {
    dest = join(quarantineDir, `${basename(entryPath)}.${i}`);
    i++;
  }
  renameSync(entryPath, dest);
  state.quarantined.set(t.episodeId, (state.quarantined.get(t.episodeId) ?? 0) + 1);
  ctx.events.append({
    kind: 'subtitle.quarantined',
    level: 'warn',
    jobId: job.id,
    message: `Set aside subtitle file "${basename(entryPath)}" — couldn't verify timing or resync it to the video`,
    data: targetEventData(job, { sourceFile: entryPath, quarantinedPath: dest, episodeId: t.episodeId }),
  });
}

/**
 * Atomically copies a candidate (original or resynced) beside its episode video and records
 * provenance. The foreign-file + collision guards already ran in `driftAndPlace`, against
 * this same destination and before any media work; this only writes. Returns the language
 * tag it placed, which the caller uses to shrink the episode's `lacking` set.
 */
function placeSubtitle(
  ctx: AppContext,
  job: JobRow,
  state: RunState,
  t: EpisodeTarget,
  targetPath: string,
  plan: { path: string; lang: string; offsetMs: number; drift: 'in-sync' | 'unverified' | 'resynced' },
  row: ArchiveCacheRow,
  entry: Candidate,
  site: string | undefined,
): string {
  const { path: sourcePath, lang: effectiveLang, offsetMs, drift } = plan;
  const videoLocal = t.videoPath;
  const targetName = basename(targetPath);

  atomicCopy(sourcePath, targetPath);
  ctx.trace.event({
    jobId: job.id,
    kind: 'pipeline.place',
    summary: `placed ${targetName}`,
    sideEffect: true,
    payload: () => ({ from: sourcePath, to: targetPath, lang: effectiveLang, drift }),
  });
  state.placedFiles.upsert({
    arrInstance: job.arr_instance,
    targetKind: job.target_kind,
    targetId: job.target_id,
    kind: 'subtitle',
    placedPath: targetPath,
    videoPath: videoLocal,
    sourcePath,
    jobId: job.id,
    data: {
      lang: effectiveLang,
      matchedBy: 'pipeline',
      site,
      archive: row.path,
      sourceFile: basename(entry.path),
      offsetMs,
      drift,
    },
  });

  if (drift === 'resynced') {
    ctx.events.append({
      kind: 'subtitle.resynced',
      jobId: job.id,
      message: `Resynced "${basename(sourcePath)}" (+${offsetMs}ms) and placed "${targetName}" beside "${basename(videoLocal)}"`,
      data: targetEventData(job, { sourcePath, placedPath: targetPath, offsetMs, targetName }),
    });
    return effectiveLang;
  }

  ctx.events.append({
    kind: 'subtitle.placed',
    jobId: job.id,
    message: `Placed "${targetName}" beside "${basename(videoLocal)}"${drift === 'unverified' ? ' (unverified — no reference track)' : ''}`,
    data: targetEventData(job, { sourcePath, placedPath: targetPath, drift, targetName }),
  });
  return effectiveLang;
}

/** How many search rounds one site gets per job. A pack usually covers one season, so a
 * four-season series needs the agent back on the same site more than once — but a site that
 * keeps yielding is also a site that could soak up the whole job, and three rounds is enough
 * to clear the common two-or-three-cour case without letting one target run away. */
export const MAX_SEARCH_ROUNDS = 3;

/** Site-search pass: for each configured site in order, up to `MAX_SEARCH_ROUNDS` rounds of
 * search + download, extract, cache, match, and drift-gate/place (see `searchSiteRounds`) —
 * stopping as soon as nothing is missing.
 *
 * A gap made entirely of episodes that aired this week gets one quick look per site instead:
 * one round, on the site's remembered tier, no escalation. Job 74 spent 36 chromium steps
 * across three rounds proving that five episodes aired that week had no subtitles anywhere,
 * which the next scheduled run will find out again for a fraction of the price. */
async function siteSearchPass(
  ctx: AppContext,
  job: JobRow,
  meta: TargetMeta,
  gaps: EpisodeTarget[],
  state: RunState,
  cache: ArchiveCache,
  deps: RunSubtitleDeps,
): Promise<void> {
  const sites = ctx.config.subtitle.sites;
  if (sites.length === 0) return; // missing-resolution emissions happen back in runSubtitleJob

  const profiles = new SiteProfiles(ctx.db);
  // What this library already holds for this target, read once for the whole pass. Round 1
  // used to start blind, since the "already fetched" list only began filling at round 2, so a
  // re-run's first round happily re-picked the pack the cache pass had just replayed.
  const cached = cachedPacks(cache, job);

  const fresh = isFreshGap(gaps, Date.now(), FRESH_DAYS);
  // Emitted on the first site actually attempted, not up front: a pass where every site is
  // disabled or on cooldown scoped nothing down, and saying so is a line about a search that
  // never happened.
  let scopedAnnounced = false;
  const announceScoped = (): void => {
    if (!fresh || scopedAnnounced) return;
    scopedAnnounced = true;
    ctx.events.append({
      kind: 'subtitle.search-scoped',
      jobId: job.id,
      message: `${meta.title}: every missing episode aired within ${FRESH_DAYS} days; one quick look per site`,
      data: targetEventData(job, { freshDays: FRESH_DAYS, episodes: uncovered(gaps).length }),
    });
  };

  for (const site of sites) {
    if (uncovered(gaps).length === 0) break;

    // A site that is disabled or in failure cooldown gets no attempt: no run, no reflection,
    // no cooldown touch. It is filtered HERE rather than inside `searchSite` so that
    // reaching `searchSite` means an attempt actually starts — which is what keeps the
    // scoped-down note below honest about a search that happened. If every configured site
    // is skipped this loop ends having done nothing, and the caller's own "no subtitle
    // found" resolution covers it.
    const skip = skipReason(profiles.get(site.baseUrl), ctx.config.browser.siteCooldownSeconds, Date.now());
    if (skip !== null) {
      reportAgentStop(ctx, job, skip.stop, {
        callsite: SEARCH_CALLSITE,
        site: siteLabel(site.baseUrl),
        steps: 0,
        ...(skip.backoffMs !== undefined ? { backoffMs: skip.backoffMs } : {}),
      });
      continue;
    }

    announceScoped();
    await searchSiteRounds(ctx, job, site, meta, gaps, state, cache, deps, profiles, cached, fresh);
  }
}

/**
 * Why this site gets no attempt this pass, or `null` when it does. Cooldown only applies
 * while `fail_count > 0`: success (and the dashboard's "reset failures") set it back to 0,
 * and without that guard a stale `last_failure_at` would still hold the site for
 * `failBackoffMs(0)` after a clean run.
 */
function skipReason(
  profile: SiteProfileRow | null,
  cooldownSeconds: number,
  now: number,
): { stop: StopReason; backoffMs?: number } | null {
  if (profile === null) return null;
  if (profile.disabled_at !== null) return { stop: { kind: 'skipped', why: 'disabled' } };
  const backoffMs = failBackoffMs(profile.fail_count, cooldownSeconds);
  if (profile.fail_count > 0 && profile.last_failure_at !== null && now - profile.last_failure_at < backoffMs) {
    return { stop: { kind: 'skipped', why: 'cooldown' }, backoffMs };
  }
  return null;
}

/** Every pack url this target has in the archive cache, deduped, in the shape the search
 * prompt names them by. */
function cachedPacks(cache: ArchiveCache, job: JobRow): FetchedPack[] {
  const byUrl = new Map<string, FetchedPack>();
  for (const row of cache.forTarget(job.arr_instance, job.target_kind, job.target_id)) {
    if (!byUrl.has(row.source_url)) byUrl.set(row.source_url, { url: row.source_url, ...packTitleFromUrl(row.source_url) });
  }
  return [...byUrl.values()];
}

/**
 * Every round one site gets this job. A round is a whole `searchSite` call — its own
 * `subtitle_runs` row, its own agent loop, its own reflection — and the site gets another
 * one as long as the last round brought back a pack this job did not already have and
 * something is still missing, up to `MAX_SEARCH_ROUNDS`. That is what turns "one pack per
 * site per job" into "keep pulling from a site that is working": a pack covering S1+S2 used
 * to end the job with S3 and S4 untouched.
 *
 * A round that ends without a download ends the site, and so does one that hands back a pack
 * already in `alreadyFetched` (which starts the job holding every pack the archive cache has
 * for this target). Both mean the next round would replay the same search at full step budget
 * for the same result. Placing nothing does NOT: a pack that fit no episode says something
 * about that pack, not about the seasons nobody has searched for yet, and treating it as the
 * site's last word is what left a re-run's S3 and S4 untouched.
 */
async function searchSiteRounds(
  ctx: AppContext,
  job: JobRow,
  site: SubtitleSiteConfig,
  meta: TargetMeta,
  gaps: EpisodeTarget[],
  state: RunState,
  cache: ArchiveCache,
  deps: RunSubtitleDeps,
  profiles: SiteProfiles,
  cached: FetchedPack[],
  fresh: boolean,
): Promise<void> {
  const search = deps.searchSite ?? searchSite;
  const reflect = deps.reflectOnRun ?? reflectOnRun;
  const alreadyFetched: FetchedPack[] = [...cached];
  let downloadedHere = false;
  const maxRounds = fresh ? 1 : MAX_SEARCH_ROUNDS;

  for (let round = 0; round < maxRounds; round++) {
    const stillMissing = uncovered(gaps);
    if (stillMissing.length === 0) break;

    // Rebuilt per round, not per site and certainly not once per pass: a pack from the
    // previous round (or the previous site) may have covered a season, and this round should
    // be told what is actually left — plus what it has already pulled from this site, so it
    // spends its steps on something new.
    const hints = buildSearchHints({
      title: meta.title,
      languages: ctx.config.subtitle.languages,
      preferredGroups: ctx.config.subtitle.preferredGroups,
      alternates: meta.alternates,
      missingSeasons: job.target_kind === 'movie' ? [] : summarizeMissingSeasons(stillMissing, meta.seasonTitles),
      alreadyFetched,
    });

    const result = await search(ctx, job, site, hints, state.rawDir, {
      round: round + 1,
      maxRounds,
      escalate: !fresh,
    });
    // A pack this job already has, from an earlier round or from a run that cached it, means
    // the agent is circling, and this is the cheapest possible moment to say so: before
    // extracting it, before matching it, before reflecting on a round that navigated exactly
    // where the last one did. It downloaded, so `searchSite` has already booked the round as
    // a site success; there is nothing to repair, and nothing more this site will give.
    const fetchedUrl = result.download?.url;
    if (fetchedUrl !== undefined && alreadyFetched.some((p) => p.url === fetchedUrl)) {
      ctx.trace.event({
        jobId: job.id,
        kind: 'subtitle.duplicate-pack',
        summary: `round ${round + 1} fetched a pack this job already has`,
        payload: () => ({ site: site.baseUrl, url: fetchedUrl }),
      });
      return;
    }

    const today = new Date(Date.now()).toISOString().slice(0, 10);
    let verifiedSuccess = false;
    try {
      verifiedSuccess = result.download
        ? await extractAndMatch(ctx, job, site, result.download, meta.title, gaps, state, cache)
        : false;
    } catch (err) {
      // A hard extraction failure (not UnsupportedArchiveError, which extractAndMatch
      // already turns into `false`) is still a completed, non-cooldown run — it reflects
      // with verifiedSuccess: false before the error propagates. The propagation itself is
      // unchanged: the job fails and the runner retries. It does NOT raise unusable: the
      // job is about to fail, and this is not the moment to also ask a human to weigh in on
      // the site's fate.
      await reflect({ ctx, job, site, transcript: result.transcript, verifiedSuccess: false, searchObserved: result.searchObserved, today });
      throw err;
    }

    // Reflection's verdict is honoured only on this path, not the rethrow above — same
    // reasoning: a run whose job is already failing isn't the moment to raise a second,
    // unrelated decision. `verdict === 'unusable'` is raised even when `verifiedSuccess` is
    // true — a contradiction (the model says the site can't be automated, on a run that
    // just proved it could), but the model's own verdict is the thing being reported to a
    // human, not second-guessed here.
    const reflection = worthReflectingOn(fresh, result)
      ? await reflect({ ctx, job, site, transcript: result.transcript, verifiedSuccess, searchObserved: result.searchObserved, today })
      : null;
    if (reflection?.verdict === 'unusable') {
      raiseUnusable(ctx, job, site, reflection.reason, result.transcript);
    }

    if (!result.download) {
      // The site is done for this target. If an earlier round DID download, that is the
      // fact worth remembering: a round that ended in the site's own fault (a wall, a spent
      // budget, a break) has just been booked by `searchSite` as a site failure, which would
      // put a site that worked twice today into cooldown for the next job. Restore what its
      // own successful round left behind. last_working_tier and last_success_at survive a
      // failure untouched, so only these two need putting back.
      if (downloadedHere) profiles.update(site.baseUrl, { failCount: 0, lastFailureAt: null });
      return;
    }

    downloadedHere = true;
    alreadyFetched.push({ url: result.download.url, ...packTitleFromUrl(result.download.url) });
  }
}

/**
 * Whether a completed round has anything to teach the site's notes file. Everything does,
 * except one shape: a fresh-gap round that looked, spent barely any steps, and came back
 * empty. "Searched once, nothing there, it aired yesterday" is a fact about the calendar,
 * and reflection is a paid round trip per site per job. A round that broke or went malformed
 * still reflects however short it was — that one IS about the site.
 */
function worthReflectingOn(fresh: boolean, result: SiteRunResult): boolean {
  if (!fresh || result.download !== null) return true;
  if (BROKEN_STOPS.includes(result.stop.kind)) return true;
  return result.steps >= MIN_REFLECTABLE_STEPS;
}

/** The stops that are about the site rather than the calendar: a round that broke, went
 * malformed or kept aiming at refused addresses has something to teach however short it was. */
const BROKEN_STOPS: readonly StopReason['kind'][] = ['error', 'malformed', 'refused'];

/** Below this many steps a fruitless fresh-gap round is just "the site had nothing listed". */
const MIN_REFLECTABLE_STEPS = 3;

/** The pack's own name as the agent would read it back: the URL's last path segment,
 * percent-decoded. Spread into a `FetchedPack`, so a URL whose tail names nothing (a
 * directory, a bare query) contributes no `title` key at all rather than an empty one. */
function packTitleFromUrl(url: string): { title?: string } {
  const tail = (url.split(/[?#]/)[0] ?? '').split('/').pop() ?? '';
  if (tail.length === 0) return {};
  try {
    return { title: decodeURIComponent(tail) };
  } catch {
    return { title: tail };
  }
}

/** Longest a transcript detail line carries into the attention item's `data` — same cap
 * `siteReflection`'s own prompt uses for the same reason: transcript detail is page-derived
 * text, and this lands in the dashboard verbatim. */
const EVIDENCE_DETAIL_CAP = 300;

/** How many of the most recent transcript entries ride along as evidence. */
const EVIDENCE_LINES = 5;

/**
 * Raises (or refreshes) the attention item proposing that `site` be disabled, after
 * reflection judged it unusable. Deduped per SITE, not per media target: two jobs against
 * different series that both hit the same wall are the same fact ("this site cannot be
 * automated"), not two separate ones — unlike `subtitle.site-failed`/`site-exhausted`,
 * which stay scoped to `targetEventData(job, ...)`'s (instance, targetKind, targetId)
 * because those are about one run's outcome on one target. This item's `data` is built by
 * hand instead of through `targetEventData` so the dedupe key carries only the site's own
 * identity — the same site reached through a different job's target still collapses into
 * the one open item.
 */
function raiseUnusable(ctx: AppContext, job: JobRow, site: SubtitleSiteConfig, reason: string, transcript: TranscriptEntry[]): void {
  const label = siteLabel(site.baseUrl);
  const tiersAttempted = [...new Set(transcript.map((e) => e.tier))];
  const evidence = transcript
    .slice(-EVIDENCE_LINES)
    .map((e) => `[${e.tier}] ${e.action}: ${e.detail.slice(0, EVIDENCE_DETAIL_CAP)}`);
  // The model's own sentence, capped the same way transcript detail is above (G4): it flows
  // into the event message, the attention item's data, and — if the operator accepts the
  // proposal — `site_profiles.disabled_reason`, all three unbounded until this cap.
  const cappedReason = reason.slice(0, EVIDENCE_DETAIL_CAP);

  ctx.events.append({
    kind: 'subtitle.site-unusable',
    level: 'attention',
    jobId: job.id,
    message: `${label} looks unusable: ${cappedReason}`,
    data: eventEnvelope(
      {
        scope: 'subtitle',
        action: 'site-unusable',
        facts: { site: label, reason: cappedReason, reasons: tiersAttempted },
        verdict: { tone: 'danger' },
      },
      {
        // Not `targetEventData`: this item is about the SITE, not the job's arr target, so
        // it carries a site-shaped triple that dedupes across every series that hits it.
        instance: 'subtitle-site',
        targetKind: 'site',
        targetId: label,
        dedupeKey: label,
        evidence,
        accept: { action: 'disable-site', baseUrl: site.baseUrl, reason: cappedReason },
      },
    ),
  });
}

/** A download that reached us but yielded nothing placeable — an empty pack, or an archive
 * no extractor on this box can open. Both used to return `false` in silence, leaving the
 * run's only trace a `subtitle.unresolved` that named no cause. Warn, not attention: the
 * site is working, this particular pack just isn't. */
function packEmpty(ctx: AppContext, job: JobRow, url: string, message: string): void {
  ctx.events.append({
    kind: 'subtitle.pack-empty',
    level: 'warn',
    jobId: job.id,
    message,
    data: targetEventData(job, { url }),
  });
}

/** Extracts one site's downloaded payload into the archive cache and matches it against the
 * episodes still lacking a language. Returns whether anything actually got placed this call —
 * `matchArchiveRow`'s `placedCount` is the placement oracle (at least one subtitle file
 * landed on disk), not "every target language for an episode landed" and not "a download
 * happened" or "extraction succeeded". `false` covers every non-placing case alike: not an
 * ingestible payload, an archive format extractArchive can't open, an archive with nothing
 * in it, or one that extracted fine but matched no episode that wanted it. */
async function extractAndMatch(
  ctx: AppContext,
  job: JobRow,
  site: SubtitleSiteConfig,
  download: { filePath: string; url: string },
  seriesTitle: string,
  gaps: EpisodeTarget[],
  state: RunState,
  cache: ArchiveCache,
): Promise<boolean> {
  if (!isIngestibleSubtitlePayload(download.filePath)) return false;

  // Extract/copy into a PERSISTENT cache dir (outside runDir) so a later episode can reuse
  // the pack without re-downloading. A pack's identity is the site plus its own filename from
  // the URL (which carries the title and the fansub group), NOT the downloaded file's local
  // name, which carries a per-run timestamp. So the same pack fetched again lands in the same
  // dir: one shared extracted copy, and ArchiveCache's (target, path) upsert refreshes that
  // target's row instead of piling up a new one per run.
  const cacheDir = join(ctx.dataDir, 'subtitle', 'cache', `${siteKey(site.baseUrl)}-${safeUrlTailName(download.url)}`);
  let files: string[];
  try {
    // Extract fresh: extraction preserves the pack's directory structure and `collectFrom`
    // walks whatever sits in the dir afterwards, so extracting over a populated one would
    // re-collect stale files from an earlier pack alongside the new ones. The same pack
    // regenerates the same relative paths, so another target's row pointing here stays valid.
    rmSync(cacheDir, { recursive: true, force: true });
    files = await extractArchive(download.filePath, cacheDir);
  } catch (err) {
    if (err instanceof UnsupportedArchiveError) {
      packEmpty(ctx, job, download.url, err.message);
      return false;
    }
    throw err;
  }
  if (files.length === 0) {
    packEmpty(ctx, job, download.url, `Pack from ${siteLabel(site.baseUrl)} held no subtitle files: ${basename(download.url)}`);
    return false;
  }

  const entries = entriesForFiles(files, cacheDir);
  cache.upsert({
    arrInstance: job.arr_instance,
    targetKind: job.target_kind,
    targetId: job.target_id,
    sourceUrl: download.url,
    path: cacheDir,
    files: entries,
  });

  const row: ArchiveCacheRow = {
    id: -1,
    arr_instance: job.arr_instance,
    target_kind: job.target_kind,
    target_id: job.target_id,
    source_url: download.url,
    path: cacheDir,
    files: entries,
    created_at: Date.now(),
  };
  // matchArchiveRow drops episodes that lack nothing from `gaps` itself.
  const { placedCount } = await matchArchiveRow(ctx, job, row, gaps, seriesTitle, state, siteLabel(site.baseUrl));
  return placedCount > 0;
}

/** Replaces path-breaking chars in a filename so it can't escape the ref/resync dirs. */
function sanitizeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_');
}
