import { existsSync, rmSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { ArrApi, EpisodeFileResource, EpisodeResource, HistoryRecord, MovieFileResource } from '../../arr/types.js';
import type { AppContext } from '../../context.js';
import { PlacedFiles, type PlacedFileRow } from '../../db/placedFiles.js';
import { atomicCopy, ensureMounts, MountError, walkFiles } from '../../fs/files.js';
import { mapArrPath } from '../../fs/paths.js';
import { RescheduleError } from '../../jobs/errors.js';
import type { JobRow } from '../../jobs/queue.js';
import { resolveTargetTitle } from '../targetTitle.js';
import { errorMessage } from '../../util/errors.js';
import { matchSidecarsWithLlm } from './matchLlm.js';
import { assessQueue } from './queueState.js';
import { buildSidecarName, matchSidecarDeterministic, parseLangTag, sidecarKindForExt, SIDECAR_EXTS } from './sidecars.js';
import { resolveSourceDirs } from './sources.js';

export const SETTLE_RETRY_MS = 2 * 60_000;
export const SETTLE_DEADLINE_MS = 24 * 60 * 60_000;
export const MOUNT_RETRY_MS = 5 * 60_000;

type MatchedBy = 'deterministic' | 'llm';

/** Everything `runIngestJob` fetched about this job's target, gathered once up front so
 * the sidecar sweep (and, after it, Task 10's stuck-import/bundle rescue stage) both work
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
 * `stuckDownloadIds` (from a `'stuck'` queue assessment) and `sourceDirsArr` are both
 * computed here but not acted on beyond the sidecar sweep — Task 10's bundle/stuck-import
 * rescue stage slots in right after it, reusing this same target/source-dir context
 * instead of re-deriving it.
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
        data: { instance: job.arr_instance, targetKind: job.target_kind, targetId: job.target_id },
      });
      return;
    }
    throw new RescheduleError('arr still importing this target', SETTLE_RETRY_MS);
  }

  // Consumed by Task 10's stuck-import rescue stage — not acted on in this task.
  const stuckDownloadIds = assessment.state === 'stuck' ? assessment.downloadIds : [];

  const placedFiles = new PlacedFiles(ctx.db);
  cleanupStaleProvenance(ctx, job, placedFiles);

  const target = await resolveTarget(client, job);

  const droppedPaths = target.history.map((h) => h.data.droppedPath).filter((p): p is string => Boolean(p));
  const sourceDirsArr = resolveSourceDirs(droppedPaths, ctx.config.ingest.downloadRoots);
  const sourceDirsLocal = sourceDirsArr.map((d) => mapArrPath(ctx.config.pathMappings, d)).filter((d) => existsSync(d));

  const sidecarPaths = sourceDirsLocal.flatMap((d) => walkFiles(d, SIDECAR_EXTS));
  await sweepSidecars(ctx, job, placedFiles, target, sidecarPaths);

  // Task 10's rescue stage goes here, reading `stuckDownloadIds` / `sourceDirsArr` above.
  void stuckDownloadIds;
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
      data: { instance: job.arr_instance, targetKind: job.target_kind, targetId: job.target_id, missing: err.missing },
    });
    throw new RescheduleError('mount marker(s) missing', MOUNT_RETRY_MS);
  }
}

/** Deletes provenance (and the placed file itself) for any sidecar whose video has
 * disappeared — a re-imported/upgraded/deleted episode or movie takes its sidecar with
 * it, since a sidecar with no video beside it is just orphaned clutter. Only rows this
 * job's target owns are considered, and only `placed_files`-recorded paths are ever
 * touched, per the destruction limit: Warrden never deletes a file it didn't place. */
function cleanupStaleProvenance(ctx: AppContext, job: JobRow, placedFiles: PlacedFiles): void {
  const rows = placedFiles.listByTarget(job.arr_instance, job.target_kind, job.target_id);
  for (const row of rows) {
    if (existsSync(row.video_path)) continue;
    rmSync(row.placed_path, { force: true });
    placedFiles.deleteById(row.id);
    ctx.events.append({
      kind: 'ingest.stale-cleaned',
      jobId: job.id,
      message: `Removed "${row.placed_path}" — its video no longer exists`,
      data: {
        instance: job.arr_instance,
        targetKind: job.target_kind,
        targetId: job.target_id,
        placedPath: row.placed_path,
        videoPath: row.video_path,
      },
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
 * A sidecar whose source path already has a live provenance row (its video still exists)
 * short-circuits straight to a row refresh — no re-matching, no re-copy — which is what
 * keeps a settle-wait's early wake-up cheap to re-enter.
 */
async function sweepSidecars(ctx: AppContext, job: JobRow, placedFiles: PlacedFiles, target: TargetContext, sidecarPaths: string[]): Promise<void> {
  const existingPlaced = placedFiles.listByTarget(job.arr_instance, job.target_kind, job.target_id);
  const episodesWithFiles = target.kind === 'series' ? target.episodes.filter((e) => e.hasFile) : [];
  const llmBatch: string[] = [];

  for (const sidecarPath of sidecarPaths) {
    const existing = existingPlaced.find((r) => r.source_path === sidecarPath);
    if (existing && existsSync(existing.video_path)) {
      refreshPlacedRow(placedFiles, job, existing);
      continue;
    }

    if (target.kind === 'movie') {
      const video = target.movieFiles[0];
      if (!video) {
        appendDeferred(ctx, job, sidecarPath, 'no movie file is on disk yet');
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
        data: { instance: job.arr_instance, targetKind: job.target_kind, targetId: job.target_id, sidecarPath },
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

function appendDeferred(ctx: AppContext, job: JobRow, sidecarPath: string, reason: string): void {
  ctx.events.append({
    kind: 'ingest.deferred',
    jobId: job.id,
    message: `Deferred "${basename(sidecarPath)}" — ${reason}`,
    data: { instance: job.arr_instance, targetKind: job.target_kind, targetId: job.target_id, sidecarPath },
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
      data: { instance: job.arr_instance, targetKind: job.target_kind, targetId: job.target_id, sidecarPath },
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
 *   DIFFERENT still-existing source (two sidecars — e.g. two lang-null subs — resolving
 *   to the same filename). Re-placement from the SAME source is always allowed (that's
 *   the idempotent-refresh path); a claim from a source that's since vanished no longer
 *   contests the slot either.
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
      data: { instance: job.arr_instance, targetKind: job.target_kind, targetId: job.target_id, sidecarPath, targetPath },
    });
    return;
  }

  if (existingAtTarget && existingAtTarget.source_path !== sidecarPath && existsSync(existingAtTarget.source_path)) {
    ctx.events.append({
      kind: 'ingest.skipped-collision',
      level: 'warn',
      jobId: job.id,
      message: `Skipped "${basename(sidecarPath)}" — "${targetName}" is already claimed by "${existingAtTarget.source_path}"`,
      data: { instance: job.arr_instance, targetKind: job.target_kind, targetId: job.target_id, sidecarPath, targetPath },
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
    data: { instance: job.arr_instance, targetKind: job.target_kind, targetId: job.target_id, sidecarPath, placedPath: targetPath, matchedBy },
  });
}
