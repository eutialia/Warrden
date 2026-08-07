import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type {
  ArrApi,
  EpisodeFileResource,
  EpisodeResource,
  HistoryRecord,
  ManualImportFile,
  ManualImportItem,
  MovieFileResource,
} from '../../arr/types.js';
import type { AppContext } from '../../context.js';
import { PlacedFiles, type PlacedFileRow } from '../../db/placedFiles.js';
import { targetEventData } from '../../events/target.js';
import { atomicCopy, ensureMounts, MountError, walkFiles } from '../../fs/files.js';
import { mapArrPath, type PathMapping } from '../../fs/paths.js';
import { RescheduleError } from '../../jobs/errors.js';
import type { JobRow } from '../../jobs/queue.js';
import { resolveTargetTitle } from '../targetTitle.js';
import { errorMessage } from '../../util/errors.js';
import { planBundleImport } from './bundle.js';
import { matchSidecarsWithLlm } from './matchLlm.js';
import { assessQueue, type QueueAssessment } from './queueState.js';
import { buildSidecarName, matchSidecarDeterministic, parseLangTag, sidecarKindForExt, sidecarStem, SIDECAR_EXTS, VIDEO_EXTS } from './sidecars.js';
import { resolveSourceDirsDetailed } from './sources.js';

export const SETTLE_RETRY_MS = 2 * 60_000;
export const SETTLE_DEADLINE_MS = 24 * 60 * 60_000;
export const MOUNT_RETRY_MS = 5 * 60_000;

type MatchedBy = 'deterministic' | 'llm';

/** Everything `runIngestJob` fetched about this job's target, gathered once up front so
 * the sidecar sweep (and, after it, this file's own stuck-import/bundle rescue stage) both work
 * off the same snapshot instead of re-querying the arr mid-run. */
interface SeriesTargetContext {
  kind: 'series';
  seriesTitle: string;
  episodes: EpisodeResource[];
  episodeFiles: EpisodeFileResource[];
  history: HistoryRecord[];
}
interface MovieTargetContext {
  kind: 'movie';
  movieFiles: MovieFileResource[];
  history: HistoryRecord[];
}
type TargetContext = SeriesTargetContext | MovieTargetContext;

/**
 * Runs one ingest job end-to-end for a series or movie target: waits out any in-progress
 * arr import, prunes provenance for sidecars whose video vanished, sweeps the torrent's
 * source folder(s) for leftover audio/subtitle sidecars, matches each one to the episode
 * (or movie) it belongs to — deterministically first, then via one batched LLM call for
 * whatever's left — and atomically copies matches into place beside their video,
 * recording provenance so a later run (or `Reconcile`) can tell what Warrden itself put
 * there.
 *
 * The handler owns its own deadline: rescheduling itself while the arr is still importing
 * is unbounded by design (`RescheduleError` isn't a retry, the runner never counts it
 * against `attempts`), so `SETTLE_DEADLINE_MS` against `job.created_at` is the only thing
 * that stops it from waiting forever on an arr that never finishes. Every reschedule is
 * cheap and idempotent to re-enter (settle re-check, provenance short-circuit), which
 * matters because `queue.reschedule`'s early-wake-up asymmetry means a fresh trigger can
 * re-run this handler well before the delay it asked for elapses.
 *
 * Once sidecars are placed, a rescue stage retries anything the arr's own manual-import
 * queue is still holding: any `'stuck'` download (`assessment`'s `downloadIds`) plus, for
 * a series target, any leftover bundle video sitting in one of `bundleFolders`'s
 * root-derived folders that the sidecar sweep never touched — a sidecar only ever matches
 * beside an EXISTING video, so a whole extra episode file needs its own manual import. A
 * high/medium-confidence mapping imports immediately (`copy` mode); a low-confidence one
 * is proposed as an `attention` item instead of executed unattended. Movies only ever
 * rescue a stuck download 1:1 onto `movieId` (dropping rejected/other-movie items first)
 * — leftover movie-folder videos are extras and are never imported; a movie that already
 * has a file on disk proposes instead of executing, mirroring the series occupied-episode
 * cap. The whole stage runs in its own try/catch so a planning/import failure there can
 * never undo the sidecar work above, or fail the job outright.
 */
export async function runIngestJob(ctx: AppContext, job: JobRow): Promise<void> {
  const client = ctx.clients.get(job.arr_instance);
  if (!client) {
    throw new Error(`No arr client configured for instance "${job.arr_instance}"`);
  }

  assertMounted(ctx, job);

  const records = await client.listQueue();
  const assessment = assessQueue(records, { kind: job.target_kind, id: job.target_id });

  if (assessment.state === 'busy') {
    if (Date.now() - job.created_at > SETTLE_DEADLINE_MS) {
      ctx.events.append({
        kind: 'ingest.settle-timeout',
        level: 'attention',
        jobId: job.id,
        message: `Gave up waiting for the arr to finish importing (still busy after ${Math.round(SETTLE_DEADLINE_MS / 3_600_000)}h)`,
        data: targetEventData(job),
      });
      return;
    }
    throw new RescheduleError('arr still importing this target', SETTLE_RETRY_MS);
  }

  const placedFiles = new PlacedFiles(ctx.db);
  cleanupStaleProvenance(ctx, job, placedFiles);

  const target = await resolveTarget(client, job);

  const droppedPaths = target.history.map((h) => h.data.droppedPath).filter((p): p is string => Boolean(p));
  // One derivation pass feeds both the sidecar sweep's full dir set (`all`) and the
  // rescue stage's narrower, root-derived-only set (`rootDerived`) — see
  // resolveSourceDirsDetailed's own doc for why the rescue stage needs the narrower one.
  const { all: sourceDirsArr, rootDerived: bundleFolders } = resolveSourceDirsDetailed(droppedPaths, ctx.config.ingest.downloadRoots);
  let sourceDirsLocal = sourceDirsArr.map((d) => mapArrPath(ctx.config.pathMappings, d)).filter((d) => existsSync(d));

  // Hoisted once so the fallback derivation and the source-video identification below both
  // read the same value without re-narrowing `target` (a series/movie union) inside a
  // nested closure.
  const movieFile = target.kind === 'movie' ? target.movieFiles[0] : undefined;

  // Movie-only fallback: Radarr's own downloadFolderImported history record (and with it
  // originalFilePath/sceneName) only exists for imports Radarr made itself — a movie
  // imported before Warrden existed, or old enough to have aged out of history retention,
  // leaves nothing to derive a source dir from. Gated on `sourceDirsLocal` (post-mapping,
  // post-existsSync), not `sourceDirsArr`: history whose droppedPath maps to a dir that's
  // since vanished locally deserves the same fallback — that's the exact symptom this
  // exists for, not just "no history at all". Copy-mode imports are byte-identical to their
  // source, so an exact size match between the movie's current file and a video sitting
  // under a configured torrent-client root re-derives that torrent's own folder with no
  // history needed at all.
  if (sourceDirsLocal.length === 0 && movieFile) {
    const { dirs: fallbackDirs, rootsScanned } = findMovieSourceDirsBySize(
      ctx.config.ingest.downloadRoots,
      ctx.config.pathMappings,
      movieFile.size,
    );
    if (fallbackDirs.length > 0) {
      sourceDirsLocal = fallbackDirs;
      ctx.events.append({
        kind: 'ingest.source-fallback',
        jobId: job.id,
        message: `No import history for this movie — matched its source folder by exact file size instead`,
        data: targetEventData(job, { matchedDirs: fallbackDirs }),
      });
    } else {
      // Visible rather than silent: a history-less movie that never matches anything would
      // otherwise re-run this scan (fruitlessly) on every future ingest job with no trace of
      // it ever having tried.
      ctx.events.append({
        kind: 'ingest.source-fallback-miss',
        jobId: job.id,
        message: `No import history for this movie, and no source folder matched its file size across ${rootsScanned} download root(s)`,
        data: targetEventData(job, { rootsScanned }),
      });
    }
  }

  // Deduped: nested source dirs (e.g. a configured-root miss falling back to two different
  // dropped files' own dirnames, one inside the other) would otherwise have `walkFiles`
  // — itself recursive — walk the same physical file more than once, double-placing it and
  // double-listing it in the LLM batch below.
  const sidecarPaths = [...new Set(sourceDirsLocal.flatMap((d) => walkFiles(d, SIDECAR_EXTS)))];

  // The specific video Radarr actually imported, identified by exact size match across
  // every swept dir's videos — works whether those dirs came from history or the fallback
  // above, so the movie branch's sidecar stem guard (in sweepSidecars) has one source of
  // truth instead of two paths that could disagree.
  const identifiedSourceVideo = movieFile
    ? sourceDirsLocal.flatMap((d) => walkFiles(d, VIDEO_EXTS)).find((v) => fileSizeEquals(v, movieFile.size))
    : undefined;

  await sweepSidecars(ctx, job, placedFiles, target, sidecarPaths, identifiedSourceVideo);

  await rescueStuckImports(ctx, job, client, target, assessment, bundleFolders);
}

/** Verifies every configured mount marker is present, translating a `MountError` into an
 * attention event plus a bounded reschedule — filesystem work (the sweep below) against an
 * unmounted NAS share would otherwise look like "nothing to do" instead of "not actually
 * mounted", silently pruning provenance for files that are really just unreachable. */
function assertMounted(ctx: AppContext, job: JobRow): void {
  try {
    ensureMounts(ctx.config.ingest.mountMarkers);
  } catch (err) {
    if (!(err instanceof MountError)) throw err;
    ctx.events.append({
      kind: 'ingest.mount-missing',
      level: 'attention',
      jobId: job.id,
      message: `Ingest paused — missing mount marker(s): ${err.missing.join(', ')}`,
      data: targetEventData(job, { missing: err.missing }),
    });
    throw new RescheduleError('mount marker(s) missing', MOUNT_RETRY_MS);
  }
}

/** Whether the file at `path` is exactly `size` bytes — `false` on ANY stat failure
 * (ENOENT, EACCES, ...) rather than throwing. The movie branch's size-match logic runs
 * against a live, often SMB-mounted, download share that an active torrent client can be
 * moving or deleting files on at the same time — a file `walkFiles`/`readdirSync` just
 * listed can be gone by the time this actually stats it, and that race must never fail the
 * whole ingest job, same as every other filesystem touchpoint in this file being defensive
 * about a source vanishing mid-run (see `cleanupStaleProvenance`, `tryPlace`, ...). */
function fileSizeEquals(path: string, size: number): boolean {
  try {
    return statSync(path).size === size;
  } catch {
    return false;
  }
}

/** `findMovieSourceDirsBySize`'s result: the matched dirs (empty when nothing matched), plus
 * how many configured download roots were actually scanned (existed locally and got
 * `readdirSync`'d) — surfaced in `ingest.source-fallback-miss` so a history-less movie that
 * never matches anything is visible instead of silently re-scanning forever. */
interface MovieSourceScanResult {
  dirs: string[];
  rootsScanned: number;
}

/**
 * Movie-only fallback source-dir derivation used when a movie's history has nothing to say
 * about where its torrent folder is (see `runIngestJob`'s call site). For each configured
 * download root that exists locally, only depth-1 child directories are considered — one
 * recursion per torrent dir, mirroring how a torrent client actually lays its downloads out
 * under a shared root — and a child qualifies the moment ANY video under it (`walkFiles` is
 * itself recursive) matches the movie's file size exactly. This is stat-only (via
 * `fileSizeEquals`, so a file vanishing mid-scan is a non-match, not a crash): no file
 * content is ever read, and dot-directories are already pruned by `walkFiles`.
 *
 * Stops scanning further roots the moment a root yields ANY match — a real deployment can
 * have hundreds of torrent dirs across a root sitting on SMB, and once one root's already
 * proven itself to be where this movie's download lives, walking every other configured
 * root too is pure wasted latency against a shared, possibly slow, filesystem. Every
 * matching child dir WITHIN that one winning root is still collected (not just the first) —
 * a false-positive size collision between two folders in the same root is rare enough that
 * surfacing both for the sidecar sweep to try is safer than guessing which one is real; it's
 * scanning OTHER roots after a hit that's skipped, not sibling collision detection.
 */
function findMovieSourceDirsBySize(downloadRoots: string[], pathMappings: PathMapping[], size: number): MovieSourceScanResult {
  let rootsScanned = 0;
  for (const arrRoot of downloadRoots) {
    const localRoot = mapArrPath(pathMappings, arrRoot);
    if (!existsSync(localRoot)) continue;
    rootsScanned++;

    const matched = new Set<string>();
    for (const entry of readdirSync(localRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const childDir = join(localRoot, entry.name);
      if (walkFiles(childDir, VIDEO_EXTS).some((video) => fileSizeEquals(video, size))) {
        matched.add(childDir);
      }
    }
    if (matched.size > 0) {
      return { dirs: [...matched].sort(), rootsScanned };
    }
  }
  return { dirs: [], rootsScanned };
}

/** Videos sitting directly in `dir` (no recursion into subfolders) — used by the movie
 * branch's sidecar stem guard to find the specific sibling video a sidecar's filename
 * names, without also picking up a video from some unrelated nested folder (e.g. a torrent
 * client's own "SPs"/specials subfolder). */
function siblingVideosInDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const wanted = new Set(VIDEO_EXTS.map((e) => e.toLowerCase()));
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && wanted.has(extname(e.name).toLowerCase()))
    .map((e) => join(dir, e.name));
}

/** Deletes provenance (and the placed file itself) for any sidecar whose video has
 * disappeared — a re-imported/upgraded/deleted episode or movie takes its sidecar with
 * it, since a sidecar with no video beside it is just orphaned clutter. Only rows this
 * job's target owns are considered, and only `placed_files`-recorded paths are ever
 * touched, per the destruction limit: Warrden never deletes a file it didn't place.
 *
 * A missing `video_path` is ambiguous on its own: it can mean the video genuinely vanished
 * (re-imported/upgraded/deleted — real stale), or it can mean the video's whole share isn't
 * mounted right now (`ingest.mountMarkers` defaults to `[]`, so an unmounted NAS share can
 * slip past `assertMounted` entirely). Only the parent folder's own reachability tells the
 * two apart: `existsSync(dirname(row.video_path))` true means the folder is there and the
 * video specifically is gone (real stale, safe to clean); false means the whole folder is
 * unreachable, so nothing here can tell deletion from an outage — the row is skipped rather
 * than cleaned, because provenance for an unavailable mount must survive the outage, not be
 * read as "the file is gone" and destroyed. Every skipped row for this run is folded into
 * one `ingest.stale-clean-deferred` warn event rather than one per row, so a whole
 * unreachable share doesn't flood the event log.
 *
 * One row's `rmSync` failure (a permission error, the path being a directory, ...) is
 * contained per-row (same shape as `tryPlace`'s containment) rather than aborting the rest
 * of the cleanup pass — and the row is deliberately kept, not deleted, on failure: the file
 * is still sitting there unremoved, so dropping provenance for it now would misrepresent
 * reality and drop it from being retried next run. */
function cleanupStaleProvenance(ctx: AppContext, job: JobRow, placedFiles: PlacedFiles): void {
  const rows = placedFiles.listByTarget(job.arr_instance, job.target_kind, job.target_id);
  let deferredCount = 0;
  for (const row of rows) {
    if (existsSync(row.video_path)) continue;
    if (!existsSync(dirname(row.video_path))) {
      deferredCount++;
      continue;
    }
    try {
      rmSync(row.placed_path, { force: true });
    } catch (err) {
      ctx.events.append({
        kind: 'ingest.stale-clean-failed',
        level: 'warn',
        jobId: job.id,
        message: `Failed to remove stale "${row.placed_path}": ${errorMessage(err)}`,
        data: targetEventData(job, { placedPath: row.placed_path, videoPath: row.video_path }),
      });
      continue;
    }
    placedFiles.deleteById(row.id);
    ctx.events.append({
      kind: 'ingest.stale-cleaned',
      jobId: job.id,
      message: `Removed "${row.placed_path}" — its video no longer exists`,
      data: targetEventData(job, { placedPath: row.placed_path, videoPath: row.video_path }),
    });
  }

  if (deferredCount > 0) {
    ctx.events.append({
      kind: 'ingest.stale-clean-deferred',
      level: 'warn',
      jobId: job.id,
      message: `Deferred stale-cleanup for ${deferredCount} row(s) — their video's parent folder is unreachable (mount likely unavailable), not just the video itself`,
      data: targetEventData(job, { count: deferredCount }),
    });
  }
}

async function resolveTarget(client: ArrApi, job: JobRow): Promise<TargetContext> {
  if (job.target_kind === 'movie') {
    const [movieFiles, history] = await Promise.all([client.listMovieFiles(job.target_id), client.listMovieHistory(job.target_id)]);
    return { kind: 'movie', movieFiles, history };
  }
  const [episodes, episodeFiles, history, seriesTitle] = await Promise.all([
    client.listEpisodes(job.target_id),
    client.listEpisodeFiles(job.target_id),
    client.listSeriesHistory(job.target_id),
    resolveTargetTitle(client, job),
  ]);
  return { kind: 'series', seriesTitle, episodes, episodeFiles, history };
}

/**
 * Matches and places every swept sidecar. Deterministic matching runs first (against
 * `hasFile: true` episodes only — a sidecar needs a video already on disk to sit beside);
 * whatever it can't place, for a series target, is batched into a single `sidecar-match`
 * LLM call once the loop finishes (matching `matchSidecarsWithLlm`'s documented contract).
 * A sidecar whose source path already has a live provenance row (its video still exists
 * AND the placed file itself is still there) short-circuits straight to a row refresh —
 * no re-matching, no re-copy — which is what keeps a settle-wait's early wake-up cheap to
 * re-enter. When the video is intact but the placed file itself was removed (by hand, or
 * by something outside Warrden), it's restored directly from the row's own recorded
 * source instead — cheap and correct without paying for a second matching pass (or, for
 * an LLM-matched file, a second LLM call), and it also clears the "phantom row" that would
 * otherwise block the collision guard forever for a target that's actually free again.
 *
 * The movie branch additionally guards against a torrent folder that ships MORE than one
 * video (a main film plus side-story/extra videos, each with its own same-named subtitle
 * set): a sidecar only 1:1-matches the movie's actual file when the video its filename
 * names (`sidecarStem`) is `identifiedSourceVideo` — the one Radarr actually imported. A
 * sidecar naming some OTHER sibling video is an extra's own caption and is skipped rather
 * than misattached to the main film, which would otherwise caption the wrong video. A
 * sidecar with no sibling video sharing its stem at all (the common case) is unaffected —
 * it attaches to the movie the same way it always has.
 */
async function sweepSidecars(
  ctx: AppContext,
  job: JobRow,
  placedFiles: PlacedFiles,
  target: TargetContext,
  sidecarPaths: string[],
  identifiedSourceVideo?: string,
): Promise<void> {
  const existingPlaced = placedFiles.listByTarget(job.arr_instance, job.target_kind, job.target_id);
  const episodesWithFiles = target.kind === 'series' ? target.episodes.filter((e) => e.hasFile) : [];
  const llmBatch: string[] = [];

  for (const sidecarPath of sidecarPaths) {
    const existing = existingPlaced.find((r) => r.source_path === sidecarPath);
    if (existing && existsSync(existing.video_path)) {
      if (existsSync(existing.placed_path)) {
        refreshPlacedRow(placedFiles, job, existing);
      } else {
        tryRestore(ctx, job, placedFiles, existing);
      }
      continue;
    }

    if (target.kind === 'movie') {
      const video = target.movieFiles[0];
      if (!video) {
        appendDeferred(ctx, job, sidecarPath, 'no movie file is on disk yet');
        continue;
      }

      const siblingVideo = siblingVideosInDir(dirname(sidecarPath)).find(
        (v) => sidecarStem(basename(v)) === sidecarStem(basename(sidecarPath)),
      );
      if (siblingVideo && siblingVideo !== identifiedSourceVideo) {
        ctx.events.append({
          kind: 'ingest.skipped-extra',
          jobId: job.id,
          message: `Skipped "${basename(sidecarPath)}" — belongs to "${basename(siblingVideo)}", an extra the arr never imported`,
          data: targetEventData(job, { sidecarPath, videoPath: siblingVideo }),
        });
        continue;
      }

      tryPlace(ctx, job, placedFiles, sidecarPath, video.path, 'deterministic');
      continue;
    }

    const hit = matchSidecarDeterministic(basename(sidecarPath), episodesWithFiles);
    if (hit) {
      placeEpisodeSidecar(ctx, job, placedFiles, target, sidecarPath, hit, 'deterministic');
      continue;
    }

    // A miss against the hasFile-only list can still name a real episode that simply has
    // no file yet — that's "wait for the file", not "hand this to the LLM", since the LLM
    // is never shown fileless episodes either (matchSidecarsWithLlm's own contract).
    const fullHit = matchSidecarDeterministic(basename(sidecarPath), target.episodes);
    if (fullHit && !fullHit.hasFile) {
      appendDeferred(ctx, job, sidecarPath, `matched S${fullHit.seasonNumber}E${fullHit.episodeNumber} but it has no file yet`);
      continue;
    }

    llmBatch.push(sidecarPath);
  }

  if (target.kind !== 'series' || llmBatch.length === 0) return;

  const ids = await matchSidecarsWithLlm({
    llm: ctx.llm,
    seriesTitle: target.seriesTitle,
    files: llmBatch.map((p) => basename(p)),
    episodes: episodesWithFiles,
  });

  llmBatch.forEach((sidecarPath, i) => {
    const episodeId = ids[i] ?? null;
    const episode = episodeId === null ? undefined : episodesWithFiles.find((e) => e.id === episodeId);
    if (!episode) {
      ctx.events.append({
        kind: 'ingest.unmatched',
        level: 'attention',
        jobId: job.id,
        message: `Could not match "${basename(sidecarPath)}" to any episode of "${target.seriesTitle}"`,
        data: targetEventData(job, { sidecarPath }),
      });
      return;
    }
    placeEpisodeSidecar(ctx, job, placedFiles, target, sidecarPath, episode, 'llm');
  });
}

/** Re-upserts an already-placed sidecar's row as-is (bumping `job_id`/`created_at` to this
 * run) without touching the filesystem or re-running any matching — the cheap path for a
 * sidecar this job has already placed correctly in a previous run. */
function refreshPlacedRow(placedFiles: PlacedFiles, job: JobRow, row: PlacedFileRow): void {
  placedFiles.upsert({
    arrInstance: row.arr_instance,
    targetKind: row.target_kind,
    targetId: row.target_id,
    kind: row.kind,
    placedPath: row.placed_path,
    videoPath: row.video_path,
    sourcePath: row.source_path,
    jobId: job.id,
    data: row.data,
  });
}

/** Re-copies an already-known-good sidecar from its recorded source straight back to its
 * recorded target and refreshes the row — the restore path for a placed file that got
 * removed while its video (and the row itself) are still intact. Wrapped the same way as
 * `tryPlace`: a failure (e.g. the source itself has since vanished too) is contained to a
 * warn event rather than aborting the sweep. */
function tryRestore(ctx: AppContext, job: JobRow, placedFiles: PlacedFiles, row: PlacedFileRow): void {
  try {
    atomicCopy(row.source_path, row.placed_path);
    refreshPlacedRow(placedFiles, job, row);
    ctx.events.append({
      kind: 'ingest.placed',
      jobId: job.id,
      message: `Restored "${basename(row.placed_path)}" — it had gone missing from the library`,
      data: targetEventData(job, { sidecarPath: row.source_path, placedPath: row.placed_path, matchedBy: row.data.matchedBy }),
    });
  } catch (err) {
    ctx.events.append({
      kind: 'ingest.place-failed',
      level: 'warn',
      jobId: job.id,
      message: `Failed to restore "${basename(row.placed_path)}": ${errorMessage(err)}`,
      data: targetEventData(job, { sidecarPath: row.source_path }),
    });
  }
}

function appendDeferred(ctx: AppContext, job: JobRow, sidecarPath: string, reason: string): void {
  ctx.events.append({
    kind: 'ingest.deferred',
    jobId: job.id,
    message: `Deferred "${basename(sidecarPath)}" — ${reason}`,
    data: targetEventData(job, { sidecarPath }),
  });
}

/** Resolves the episode's on-disk file and places the sidecar beside it — or defers when
 * the episode has no matching `EpisodeFileResource` (a `hasFile: true` episode whose file
 * resource is otherwise missing is a data inconsistency, not a normal wait state, but it's
 * handled the same cheap non-fatal way as the "no file yet" case above). */
function placeEpisodeSidecar(
  ctx: AppContext,
  job: JobRow,
  placedFiles: PlacedFiles,
  target: SeriesTargetContext,
  sidecarPath: string,
  episode: EpisodeResource,
  matchedBy: MatchedBy,
): void {
  const episodeFile = target.episodeFiles.find((f) => f.id === episode.episodeFileId);
  if (!episodeFile) {
    appendDeferred(ctx, job, sidecarPath, `S${episode.seasonNumber}E${episode.episodeNumber}'s file resource is missing`);
    return;
  }
  tryPlace(ctx, job, placedFiles, sidecarPath, episodeFile.path, matchedBy);
}

/** Wraps `place` so one bad file (a permission error, a vanished source mid-sweep, ...)
 * can't abort the rest of the sweep — nothing here is irreversible, and re-runs are cheap,
 * so a warn event is enough to surface it without failing the whole job. */
function tryPlace(ctx: AppContext, job: JobRow, placedFiles: PlacedFiles, sidecarPath: string, videoArrPath: string, matchedBy: MatchedBy): void {
  try {
    place(ctx, job, placedFiles, sidecarPath, videoArrPath, matchedBy);
  } catch (err) {
    ctx.events.append({
      kind: 'ingest.place-failed',
      level: 'warn',
      jobId: job.id,
      message: `Failed to place "${basename(sidecarPath)}": ${errorMessage(err)}`,
      data: targetEventData(job, { sidecarPath }),
    });
  }
}

/**
 * Copies one matched sidecar beside its video and records provenance — the only place
 * `atomicCopy`/`placedFiles.upsert` for a sidecar happen. Two guards run first, both
 * against the destructive-overwrite limit (never touch a file without a matching
 * provenance row):
 * - **Foreign-file guard**: something already sits at the target path with no
 *   `placed_files` row for it — not ours to overwrite.
 * - **Collision guard**: a `placed_files` row already claims the target path from a
 *   DIFFERENT source (two sidecars — e.g. two lang-null subs — resolving to the same
 *   filename). Re-placement from the SAME source is always allowed (that's the
 *   idempotent-refresh path). A claim from a source that's since vanished still blocks the
 *   slot too — once the old source is gone, nothing here can re-derive what's actually
 *   sitting at the target to decide whether overwriting it is safe, and the file may well
 *   be human-edited. Note the block is deliberately durable: the claiming row is only ever
 *   removed by stale cleanup (which triggers on the VIDEO going away, not the sidecar), so
 *   freeing the slot for a different source means removing or renaming the episode's video
 *   (a re-grab/upgrade does exactly that) — deleting just the placed sidecar leaves the
 *   claim in place.
 */
function place(ctx: AppContext, job: JobRow, placedFiles: PlacedFiles, sidecarPath: string, videoArrPath: string, matchedBy: MatchedBy): void {
  const videoLocal = mapArrPath(ctx.config.pathMappings, videoArrPath);
  const ext = extname(sidecarPath);
  const lang = parseLangTag(basename(sidecarPath));
  const targetName = buildSidecarName(basename(videoLocal), { lang, ext });
  const targetPath = join(dirname(videoLocal), targetName);

  const existingAtTarget = placedFiles.findByPlacedPath(targetPath);

  if (existsSync(targetPath) && !existingAtTarget) {
    ctx.events.append({
      kind: 'ingest.skipped-foreign',
      level: 'warn',
      jobId: job.id,
      message: `Skipped "${basename(sidecarPath)}" — "${targetName}" already exists and wasn't placed by Warrden`,
      data: targetEventData(job, { sidecarPath, targetPath }),
    });
    return;
  }

  if (existingAtTarget && existingAtTarget.source_path !== sidecarPath) {
    ctx.events.append({
      kind: 'ingest.skipped-collision',
      level: 'warn',
      jobId: job.id,
      message: `Skipped "${basename(sidecarPath)}" — "${targetName}" is already claimed by "${existingAtTarget.source_path}"`,
      data: targetEventData(job, { sidecarPath, targetPath }),
    });
    return;
  }

  atomicCopy(sidecarPath, targetPath);
  placedFiles.upsert({
    arrInstance: job.arr_instance,
    targetKind: job.target_kind,
    targetId: job.target_id,
    kind: sidecarKindForExt(ext),
    placedPath: targetPath,
    videoPath: videoLocal,
    sourcePath: sidecarPath,
    jobId: job.id,
    data: { lang, matchedBy },
  });
  ctx.events.append({
    kind: 'ingest.placed',
    jobId: job.id,
    message: `Placed "${targetName}" beside "${basename(videoLocal)}"`,
    data: targetEventData(job, { sidecarPath, placedPath: targetPath, matchedBy }),
  });
}

/**
 * The rescue stage — retries anything the sidecar sweep above couldn't touch
 * because there was no video on disk to sit beside: a `'stuck'` download's own
 * manual-import queue, and (series only) a leftover bundle video sitting in one of the
 * torrent's own source folders. Wrapped in its own try/catch so a planning/import
 * failure here (a rejected `executeManualImport`, an LLM error, ...) can never undo the
 * sidecar placements already committed above, or fail the job outright — it's surfaced
 * as a warn event instead.
 */
async function rescueStuckImports(
  ctx: AppContext,
  job: JobRow,
  client: ArrApi,
  target: TargetContext,
  assessment: QueueAssessment,
  bundleFolders: string[],
): Promise<void> {
  try {
    if (target.kind === 'series') {
      await rescueSeries(ctx, job, client, target, assessment, bundleFolders);
    } else {
      await rescueMovie(ctx, job, client, target, assessment);
    }
  } catch (err) {
    ctx.events.append({
      kind: 'ingest.rescue-failed',
      level: 'warn',
      jobId: job.id,
      message: `Rescue stage failed: ${errorMessage(err)}`,
      data: targetEventData(job),
    });
  }
}

/** Dedupes manual-import items by path across every scope they were queried from — the
 * same physical file can surface from both a stuck download's own `downloadId` scope
 * and a folder sweep of its (still-present) source directory. */
function dedupeManualImportItems(items: ManualImportItem[]): ManualImportItem[] {
  const seen = new Set<string>();
  const out: ManualImportItem[] = [];
  for (const item of items) {
    if (seen.has(item.path)) continue;
    seen.add(item.path);
    out.push(item);
  }
  return out;
}

/**
 * Series rescue: gathers every unresolved manual-import item across two scopes — each
 * `'stuck'` `downloadId` (an import the arr gave up on) and each of the torrent's own
 * source folders (`filterExistingFiles: true` so the arr's own already-imported files
 * aren't re-offered) — then hands the deduped batch to `planBundleImport` with the
 * FULL episode list. A `null` plan (nothing importable) ends the rescue quietly; a
 * high/medium-confidence plan imports immediately in `copy` mode; a low-confidence one
 * is proposed as an `attention` item instead of executed unattended (`POST /api/attention/:id/accept`
 * is what actually runs it).
 */
async function rescueSeries(
  ctx: AppContext,
  job: JobRow,
  client: ArrApi,
  target: SeriesTargetContext,
  assessment: QueueAssessment,
  bundleFolders: string[],
): Promise<void> {
  const stuckDownloadIds = assessment.state === 'stuck' ? assessment.downloadIds : [];
  const seriesId = job.target_id;

  const itemsByScope = await Promise.all([
    ...stuckDownloadIds.map((downloadId) => client.listManualImport({ downloadId })),
    ...bundleFolders.map((folder) => client.listManualImport({ folder, seriesId, filterExistingFiles: true })),
  ]);
  const items = dedupeManualImportItems(itemsByScope.flat());

  const plan = await planBundleImport({ llm: ctx.llm, seriesTitle: target.seriesTitle, seriesId, items, episodes: target.episodes });
  if (plan === null) return;

  if (plan.confidence !== 'low') {
    await client.executeManualImport(plan.files, 'copy');
    ctx.events.append({
      kind: 'ingest.rescued',
      jobId: job.id,
      message: `Rescued ${plan.files.length} file(s) for "${target.seriesTitle}" via manual import`,
      data: targetEventData(job, { files: plan.files, skipped: plan.skipped, reasoning: plan.reasoning }),
    });
    return;
  }

  ctx.events.append({
    kind: 'ingest.rescue-proposed',
    level: 'attention',
    jobId: job.id,
    message: `Low-confidence bundle rescue for "${target.seriesTitle}" needs review before importing`,
    data: targetEventData(job, { action: 'bundle-import', files: plan.files, reasoning: plan.reasoning }),
  });
}

/**
 * Movie rescue: only ever retries a `'stuck'` download's own manual-import queue — a
 * leftover video sitting in a movie's torrent folder that ISN'T the stuck download is an
 * extra (behind-the-scenes, trailer, ...) and must never be imported as the movie itself,
 * so there's no folder-scoped sweep here (unlike the series branch).
 *
 * Two filters run before anything is built into a command, same intent as
 * `planBundleImport`'s own safety passes for the series branch:
 * - An item carrying a rejection (the arr already flagged it — wrong format, bad quality,
 *   ...) is dropped; a stuck import gave up on it, retrying it unattended would too.
 * - An item whose `movie` names a movie other than `job.target_id` (the arr's own guess,
 *   when it has one) is dropped — a sample/featurette/other-movie mismatch must never
 *   ship as this movie's file. An item with no `movie` guess at all still passes through:
 *   it's exactly the "unresolved, needs 1:1 mapping" case this rescue exists for.
 *
 * Surviving items map 1:1 onto `job.target_id` with `quality`/`languages`/`releaseGroup`
 * round-tripped verbatim — no LLM call, since there's no episode to guess at. Every item
 * the two filters drop is still tracked (by path) into `skipped`: when at least one item
 * survives, `skipped` rides along in the eventual `ingest.rescued` event's `data` (parity
 * with the series branch's `plan.skipped`); when NOTHING survives — dedupe returned
 * something but the filters dropped all of it — an info `ingest.rescue-skipped` event
 * names the dropped paths instead of the stage going quiet, since "the arr had leftover
 * items but every one was unsafe to import" is worth a visible record, not silence. A
 * dedupe result that was already empty (nothing to filter at all) stays silent, same as
 * the "nothing leftover" case elsewhere in this stage.
 *
 * Exactly one survivor maps 1:1 onto `job.target_id` and executes unattended, as above.
 * MORE than one survivor is never executed, even though every one of them individually
 * looks safe: with no episode numbers to disambiguate by (unlike the series branch's
 * per-episode mapping), picking which single file actually belongs to this one movie slot
 * is a human decision — mirrors the series branch's duplicate-target guard (an occupied
 * episode also proposes rather than executes). Proposed via the same `ingest.rescue-proposed`
 * attention shape the occupied-movie guard below uses, with `reasoning` naming the multi-file
 * situation instead of "already has a file on disk".
 *
 * If the movie already has a file on disk (`target.movieFiles`, fetched once up front in
 * `resolveTarget` — the movie equivalent of the series occupied-episode cap), replacing it
 * is always a human decision: the command is proposed as an `attention` item instead of
 * executed, using the same `bundle-import` payload shape the series branch uses. This also
 * breaks a re-execution loop: without it, a stuck queue record that lingers after a
 * successful import would re-run (and re-execute) this same rescue every job run.
 */
async function rescueMovie(ctx: AppContext, job: JobRow, client: ArrApi, target: MovieTargetContext, assessment: QueueAssessment): Promise<void> {
  if (assessment.state !== 'stuck') return;

  const itemsByScope = await Promise.all(assessment.downloadIds.map((downloadId) => client.listManualImport({ downloadId })));
  const deduped = dedupeManualImportItems(itemsByScope.flat());
  if (deduped.length === 0) return;

  const skipped: string[] = [];
  const items = deduped.filter((item) => {
    const keep = item.rejections.length === 0 && (item.movie === undefined || item.movie.id === job.target_id);
    if (!keep) skipped.push(item.path);
    return keep;
  });

  if (items.length === 0) {
    ctx.events.append({
      kind: 'ingest.rescue-skipped',
      jobId: job.id,
      message: `Rescue found ${skipped.length} leftover file(s) for movie #${job.target_id}, but none were safe to import (rejected, or a different movie)`,
      data: targetEventData(job, { skipped }),
    });
    return;
  }

  const files: ManualImportFile[] = items.map((item) => ({
    path: item.path,
    folderName: item.folderName,
    movieId: job.target_id,
    quality: item.quality,
    languages: item.languages,
    releaseGroup: item.releaseGroup,
  }));

  const movieTitle = await resolveTargetTitle(client, job);

  if (items.length > 1) {
    ctx.events.append({
      kind: 'ingest.rescue-proposed',
      level: 'attention',
      jobId: job.id,
      message: `Movie rescue for "${movieTitle}" needs review — ${items.length} unresolved files all claim this one movie slot`,
      data: targetEventData(job, {
        action: 'bundle-import',
        files,
        reasoning: `${items.length} files survived filtering with no episode numbers to disambiguate them — picking which one actually belongs is a human decision`,
      }),
    });
    return;
  }

  if (target.movieFiles.length > 0) {
    ctx.events.append({
      kind: 'ingest.rescue-proposed',
      level: 'attention',
      jobId: job.id,
      message: `Movie rescue for "${movieTitle}" needs review — it already has a file on disk`,
      data: targetEventData(job, {
        action: 'bundle-import',
        files,
        reasoning: `"${movieTitle}" already has a file on disk; replacing it is a human decision`,
      }),
    });
    return;
  }

  await client.executeManualImport(files, 'copy');
  ctx.events.append({
    kind: 'ingest.rescued',
    jobId: job.id,
    message: `Rescued ${files.length} file(s) for "${movieTitle}" via manual import`,
    data: targetEventData(job, { files, skipped, reasoning: `stuck download(s) mapped 1:1 onto "${movieTitle}"` }),
  });
}
