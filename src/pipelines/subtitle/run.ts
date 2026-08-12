import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { searchSite } from '../../agent/run.js';
import { reflectOnRun } from '../../agent/siteReflection.js';
import type { AppContext } from '../../context.js';
import { siteKey, siteLabel } from '../../config/siteLabel.js';
import type { SubtitleSiteConfig } from '../../config/schema.js';
import { ArchiveCache, type ArchiveCacheRow } from '../../db/archiveCache.js';
import { PlacedFiles } from '../../db/placedFiles.js';
import { targetEventData } from '../../events/target.js';
import { atomicCopy } from '../../fs/files.js';
import { mapArrPath } from '../../fs/paths.js';
import type { ArrApi } from '../../arr/types.js';
import type { JobRow } from '../../jobs/queue.js';
import { decodeSubtitleBytes, parseSubtitleCues, type SubtitleCue } from '../../media/subtitles.js';
import type { MediaTools } from '../../media/tools.js';
import { resolveTargetMeta } from '../targetTitle.js';
import { assertMounted } from '../mounts.js';
import { buildSidecarName, matchSidecarDeterministic } from '../ingest/sidecars.js';
import { placeBlocked } from '../placeGuard.js';
import {
  entriesForFiles,
  extractArchive,
  isIngestibleSubtitlePayload,
  UnsupportedArchiveError,
} from './archives.js';
import { assessDrift } from './drift.js';
import { mapArchiveWithLlm } from './mapArchive.js';
import { buildSearchHints } from './queries.js';
import { findMissingSubtitles, langCovers } from './reconcile.js';

/** Injectable seams for `runSubtitleJob` — same injectable-factory pattern as `searchSite`'s
 * own `tiers` param (Task 8): tests stub `searchSite` to a fake that returns a pre-built
 * archive instead of running a real browser + LLM loop. */
interface RunSubtitleDeps {
  searchSite?: typeof searchSite;
  reflectOnRun?: typeof reflectOnRun;
}

/** One episode the pipeline is trying to cover: its on-disk video plus what's still missing
 * (languages) and the embedded subtitle streams (used as a drift reference when present). */
interface EpisodeTarget {
  episodeId: number;
  seasonNumber: number;
  episodeNumber: number;
  videoPath: string; // local (mapped) path on disk
  missingLanguages: string[];
  embeddedRefs: { streamIndex: number; lang: string | null }[];
}

/** The verdict of the drift gate for one candidate file: what to do with it, and which on-disk
 * path to treat as the source if we place it (the original candidate, or a resynced output). */
type CandidatePlan =
  | { kind: 'place'; path: string; lang: string | null; offsetMs: number; drift: 'in-sync' | 'unverified' | 'resynced' }
  | { kind: 'quarantine' };

/**
 * The subtitle pipeline runner for a series or movie target. Mounts-guard, reconciles
 * which videos still lack the target languages via `findMissingSubtitles`, checks the
 * per-target archive cache, searches each configured site for what's still missing, and
 * drift-gates + places every candidate with full `placed_files` provenance.
 *
 * Movies: one video slot (the arr's movie file); archive files map onto that single slot.
 * Series: per-episode matching as before. Ingest sidecars still cover packs that already
 * shipped `.srt`/`.ass`; site search covers the rest (design: movie no-op was a bug).
 *
 * The drift gate decides per candidate whether to place as-is (`in-sync`), resync
 * (alass then ffsubsync) and place, or quarantine. No embedded reference → place
 * `unverified`. Any video with no survivor after cache + every site raises
 * `subtitle.unresolved`.
 */
export async function runSubtitleJob(ctx: AppContext, job: JobRow, deps: RunSubtitleDeps = {}): Promise<void> {
  const client = ctx.clients.get(job.arr_instance);
  if (!client) {
    throw new Error(`No arr client configured for instance "${job.arr_instance}"`);
  }

  assertMounted(ctx, job, 'subtitle');

  const media = requireMedia(ctx);
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

  // videoPath -> extracted reference subtitle path, cached for the whole run so a video with
  // an embedded track is only ever extracted once no matter how many candidates it's tried
  // against (or how many resync rounds each triggers).
  const refCache = new Map<string, string>();

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

    const missingList = await findMissingSubtitles({
      videos: targets.map((t) => ({ videoPath: t.videoPath, episodeId: t.episodeId })),
      languages: ctx.config.subtitle.languages,
      media,
    });
    const byVideoPath = new Map(missingList.map((m) => [m.videoPath, m]));
    const missing: EpisodeTarget[] = targets
      .filter((t) => byVideoPath.has(t.videoPath))
      .map((t) => {
        const m = byVideoPath.get(t.videoPath)!;
        return { ...t, missingLanguages: m.languages, embeddedRefs: m.embeddedRefs };
      });

    if (missing.length === 0) {
      ctx.events.append({
        kind: 'subtitle.complete',
        jobId: job.id,
        message: `Nothing missing — every video already has subtitles for ${describeLanguages(ctx.config.subtitle.languages)}`,
        data: targetEventData(job, { counts: { missing: 0, placed: 0 } }),
      });
      return;
    }

    ctx.events.append({
      kind: 'subtitle.missing',
      jobId: job.id,
      message: `${missing.length} video(s) missing subtitles for ${describeLanguages(ctx.config.subtitle.languages)}`,
      data: targetEventData(job, {
        counts: { missing: missing.length, byEpisode: missing.map((m) => m.episodeId) },
      }),
    });

    // Cache pass first — a previously-downloaded pack can cover a mid-season episode that
    // landed after the pack was fetched, avoiding a re-download.
    for (const row of cache.forTarget(job.arr_instance, job.target_kind, job.target_id)) {
      if (missing.length === 0) break;
      const resolved = await matchArchiveRow(ctx, job, row, missing, title, media, placedFiles, refCache, refDir, rawDir, undefined);
      if (resolved.length > 0) {
        ctx.events.append({
          kind: 'subtitle.cache-hit',
          jobId: job.id,
          message: `Covered ${resolved.length} video(s) from the cached archive "${basename(row.path)}"`,
          data: targetEventData(job, { count: resolved.length, episodeIds: resolved, archive: row.path }),
        });
      }
    }

    await siteSearchPass(ctx, job, title, meta.alternates, missing, media, placedFiles, refCache, refDir, rawDir, cache, deps);

    for (const t of missing) {
      const label =
        job.target_kind === 'movie'
          ? title
          : `S${t.seasonNumber}E${t.episodeNumber} (${title})`;
      ctx.events.append({
        kind: 'subtitle.unresolved',
        level: 'attention',
        jobId: job.id,
        message: `No subtitle found for ${label} after searching configured sites`,
        data: targetEventData(job, { episodeId: t.episodeId, dedupeKey: String(t.episodeId), title: label }),
      });
    }
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

/** Series: every hasFile episode with an episode file. Movie: the single movie file, if any.
 * `episodeId` for movies is the movie id so resolved tracking / attention de-dup still work. */
async function listVideoTargets(ctx: AppContext, client: ArrApi, job: JobRow): Promise<EpisodeTarget[]> {
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
        missingLanguages: [],
        embeddedRefs: [],
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
        missingLanguages: [],
        embeddedRefs: [],
      };
    });
}

function describeLanguages(langs: string[]): string {
  return langs.length > 0 ? langs.join(', ') : 'the target';
}

function requireMedia(ctx: AppContext): MediaTools {
  if (!ctx.media) throw new Error('subtitle pipeline requires ctx.media (MediaTools)');
  return ctx.media;
}

/** Removes fully-resolved episodes (every target language filled) from the working
 * `missing` list so later passes (next cache row / next site / later files in this pack)
 * don't keep chasing them. */
function removeResolved(missing: EpisodeTarget[], resolvedEpisodeIds: number[]): void {
  const gone = new Set(resolvedEpisodeIds);
  for (let i = missing.length - 1; i >= 0; i--) {
    if (gone.has(missing[i]!.episodeId)) missing.splice(i, 1);
  }
}

/**
 * After a successful place, drops every still-missing language that `placedLang` covers
 * (same rule as reconcile). When the gap is empty the episode is fully resolved and
 * removed from `missing` immediately so subsequent files in this pack (and the LLM
 * remainder pass) don't re-match it — placing zh-Hans must not stop the hunt for zh-Hant.
 */
function notePlacement(
  missing: EpisodeTarget[],
  resolved: number[],
  t: EpisodeTarget,
  placedLang: string | null,
): void {
  if (placedLang !== null) {
    t.missingLanguages = t.missingLanguages.filter((want) => !langCovers(want, placedLang));
  }
  if (t.missingLanguages.length === 0) {
    resolved.push(t.episodeId);
    removeResolved(missing, [t.episodeId]);
  }
}

/**
 * Matches one archive's files (from a cached row, or a just-downloaded+extracted pack) to the
 * still-missing episodes and drift-gates + places each match. Returns the episode ids that got
 * fully resolved (every target language filled). Deterministic matching first (via the
 * entry's pre-parsed `episodeRef`), then one `mapArchiveWithLlm` call for whatever's left —
 * mirroring ingest's match-then-LLM ordering.
 */
async function matchArchiveRow(
  ctx: AppContext,
  job: JobRow,
  row: ArchiveCacheRow,
  missing: EpisodeTarget[],
  seriesTitle: string,
  media: MediaTools,
  placedFiles: PlacedFiles,
  refCache: Map<string, string>,
  refDir: string,
  rawDir: string,
  site: string | undefined,
): Promise<number[]> {
  const entryByPath = new Map(row.files.map((f) => [f.path, f]));
  const resolved: number[] = [];

  const unmatchedPaths: string[] = [];
  for (const entry of row.files) {
    if (missing.length === 0) break;
    const t = matchDeterministic(missing, entry, job.target_kind === 'movie');
    if (t) {
      const placedLang = await driftAndPlace(ctx, job, row, entry, t, media, placedFiles, refCache, refDir, rawDir, site);
      if (placedLang !== undefined) notePlacement(missing, resolved, t, placedLang);
    } else {
      unmatchedPaths.push(entry.path);
    }
  }

  // Movies: a single video slot — every remaining archive file targets that one video
  // (lang filtering is via notePlacement shrinking missingLanguages).
  if (job.target_kind === 'movie' && unmatchedPaths.length > 0 && missing[0]) {
    const only = missing[0];
    for (const path of unmatchedPaths) {
      // notePlacement may have removed `only` from `missing` once every language is filled.
      if (!missing.includes(only)) break;
      const entry = entryByPath.get(path)!;
      const placedLang = await driftAndPlace(ctx, job, row, entry, only, media, placedFiles, refCache, refDir, rawDir, site);
      if (placedLang !== undefined) notePlacement(missing, resolved, only, placedLang);
    }
    return resolved;
  }

  if (unmatchedPaths.length > 0 && missing.length > 0) {
    const unmatchedEntries = unmatchedPaths.map((p) => entryByPath.get(p)!);
    const ids = await mapArchiveWithLlm({
      llm: ctx.llm,
      seriesTitle,
      files: unmatchedEntries,
      episodes: missing.map((m) => ({
        id: m.episodeId,
        seriesId: job.target_id,
        seasonNumber: m.seasonNumber,
        episodeNumber: m.episodeNumber,
        title: '',
        episodeFileId: 0,
        hasFile: true,
      })),
    });
    const episodesById = new Map(missing.map((m) => [m.episodeId, m]));
    for (let i = 0; i < unmatchedEntries.length; i++) {
      const episodeId = ids[i] ?? null;
      if (episodeId === null) continue;
      const t = episodesById.get(episodeId);
      // Episode may already have been fully resolved by an earlier file in this pack
      // (and removed from `missing`); skip rather than re-placing over a closed gap.
      if (!t) continue;
      const placedLang = await driftAndPlace(ctx, job, row, unmatchedEntries[i]!, t, media, placedFiles, refCache, refDir, rawDir, site);
      if (placedLang !== undefined) notePlacement(missing, resolved, t, placedLang);
    }
  }

  return resolved;
}

/** Deterministically matches an archive entry to a still-missing episode. The extracted path
 * carries extractArchive's collision-safe `<index>-` prefix (e.g. `0-Show - 01.ass`), which
 * parseEpisodeRef would misread as a second number and treat as ambiguous — so it's stripped
 * before matching, exactly as `entriesForFiles` does when it pre-annotates `episodeRef`.
 * Matching reuses ingest's `matchSidecarDeterministic` (same season/episode/absolute rules).
 * Movies with a single missing slot always match that slot. Returns null when nothing matches. */
function matchDeterministic(missing: EpisodeTarget[], entry: { path: string }, isMovie: boolean): EpisodeTarget | null {
  if (isMovie && missing.length === 1) return missing[0]!;
  const bareName = basename(entry.path).replace(/^\d+-/, '');
  const hit = matchSidecarDeterministic(
    bareName,
    missing.map((m) => ({
      id: m.episodeId,
      seriesId: 0,
      seasonNumber: m.seasonNumber,
      episodeNumber: m.episodeNumber,
      title: '',
      episodeFileId: 0,
      hasFile: true,
    })),
  );
  return hit ? missing.find((m) => m.episodeId === hit.id) ?? null : null;
}

/**
 * The drift gate + placement for one candidate file against one episode. Returns the
 * effective language tag that was placed (which the caller uses to shrink the episode's
 * still-missing set), or `undefined` when nothing was placed. Handles the gate order from
 * the brief: no reference -> place unverified; in-sync -> place; drifted -> resyncAlass
 * then re-assess -> place or try resyncFfsubsync -> re-assess -> place or quarantine;
 * unscorable -> quarantine. A quarantined / skipped candidate returns `undefined`: the
 * episode's gap is untouched, so it stays in the working set and (if nothing else covers
 * it) raises `subtitle.unresolved` at the end of the run — quarantining a bad candidate is
 * not "this gap is filled".
 */
async function driftAndPlace(
  ctx: AppContext,
  job: JobRow,
  row: ArchiveCacheRow,
  entry: { path: string; lang: string | null },
  t: EpisodeTarget,
  media: MediaTools,
  placedFiles: PlacedFiles,
  refCache: Map<string, string>,
  refDir: string,
  rawDir: string,
  site: string | undefined,
): Promise<string | null | undefined> {
  // A candidate that no longer exists (already quarantined by an earlier run, or the cache
  // row is stale) is not a failure worth reporting — just skip it.
  if (!existsSync(entry.path)) return undefined;

  const plan = await decideCandidate(entry, t, media, refCache, refDir, rawDir);
  if (plan.kind === 'quarantine') {
    quarantine(ctx, job, entry.path);
    return undefined;
  }

  return placeSubtitle(ctx, job, placedFiles, t, plan.path, plan.lang, plan.offsetMs, plan.drift, row, entry, site);
}

/** Runs the drift gate for one candidate, returning what to do with it (and the source path
 * to place — the original, or a resynced output — plus the offset/drift labels for the event
 * and provenance). */
async function decideCandidate(
  entry: { path: string; lang: string | null },
  t: EpisodeTarget,
  media: MediaTools,
  refCache: Map<string, string>,
  refDir: string,
  rawDir: string,
): Promise<CandidatePlan> {
  // No embedded reference track -> nothing to compare against; place unverified (VAD stays a
  // future tier). This is also the fallback when the extracted reference turns out unreadable.
  const refCues = await referenceCues(t, media, refCache, refDir);
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
  const resyncDir = join(rawDir, 'resync', String(t.episodeId));
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
async function referenceCues(t: EpisodeTarget, media: MediaTools, refCache: Map<string, string>, refDir: string): Promise<SubtitleCue[] | null> {
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
  lang: string | null,
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

/** Moves an unusable candidate (unscorable, or never landable in-sync after both resync
 * tools) into `dataDir/quarantine/` and raises a `subtitle.quarantined` attention event. */
function quarantine(ctx: AppContext, job: JobRow, entryPath: string): void {
  const quarantineDir = join(ctx.dataDir, 'subtitle', 'quarantine');
  mkdirSync(quarantineDir, { recursive: true });
  let dest = join(quarantineDir, basename(entryPath));
  let i = 1;
  while (existsSync(dest)) {
    dest = join(quarantineDir, `${basename(entryPath)}.${i}`);
    i++;
  }
  renameSync(entryPath, dest);
  ctx.events.append({
    kind: 'subtitle.quarantined',
    level: 'attention',
    jobId: job.id,
    message: `Set aside subtitle file "${basename(entryPath)}" — couldn't verify timing or resync it to the video`,
    // Each quarantined candidate is its own sub-target, so the candidate path is the
    // de-dup discriminator (same convention as ingest's per-sidecar attention items).
    data: targetEventData(job, { sourceFile: entryPath, quarantinedPath: dest, dedupeKey: entryPath }),
  });
}

/**
 * Atomically copies a candidate (original or resynced) beside its episode video and records
 * provenance. Same foreign-file + collision guards as ingest's `place` — never overwrites a
 * file at the target path unless a matching `placed_files` row claims it. Returns the
 * effective language tag on success (caller shrinks the episode's still-missing set with
 * it), or `undefined` when the place was skipped (foreign file / collision).
 */
function placeSubtitle(
  ctx: AppContext,
  job: JobRow,
  placedFiles: PlacedFiles,
  t: EpisodeTarget,
  sourcePath: string,
  lang: string | null,
  offsetMs: number,
  drift: 'in-sync' | 'unverified' | 'resynced',
  row: ArchiveCacheRow,
  entry: { path: string; lang: string | null },
  site: string | undefined,
): string | null | undefined {
  // A null lang tag on the candidate falls back to the first language this episode is still
  // missing — the fan-sub convention is that an untagged sub in a pack named for the missing
  // language is that language.
  const effectiveLang = lang ?? t.missingLanguages[0] ?? null;
  const videoLocal = t.videoPath;
  const ext = extname(sourcePath).toLowerCase() || '.srt';
  const targetName = buildSidecarName(basename(videoLocal), { lang: effectiveLang, ext });
  const targetPath = join(dirname(videoLocal), targetName);

  const block = placeBlocked(placedFiles, targetPath, sourcePath);
  if (block?.kind === 'foreign') {
    ctx.events.append({
      kind: 'subtitle.skipped-foreign',
      level: 'warn',
      jobId: job.id,
      message: `Skipped "${basename(sourcePath)}" — "${targetName}" already exists and wasn't placed by Warrden`,
      data: targetEventData(job, { sourcePath, targetPath }),
    });
    return undefined;
  }
  if (block?.kind === 'collision') {
    ctx.events.append({
      kind: 'subtitle.skipped-collision',
      level: 'warn',
      jobId: job.id,
      message: `Skipped "${basename(sourcePath)}" — "${targetName}" is already claimed by "${block.claimedBy}"`,
      data: targetEventData(job, { sourcePath, targetPath }),
    });
    return undefined;
  }

  atomicCopy(sourcePath, targetPath);
  placedFiles.upsert({
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

/** Site-search pass: for each configured site in order, search + download, extract, cache,
 * match, and drift-gate/place — stopping as soon as nothing is missing. */
async function siteSearchPass(
  ctx: AppContext,
  job: JobRow,
  seriesTitle: string,
  alternates: string[],
  missing: EpisodeTarget[],
  media: MediaTools,
  placedFiles: PlacedFiles,
  refCache: Map<string, string>,
  refDir: string,
  rawDir: string,
  cache: ArchiveCache,
  deps: RunSubtitleDeps,
): Promise<void> {
  const search = deps.searchSite ?? searchSite;
  const reflect = deps.reflectOnRun ?? reflectOnRun;
  const sites = ctx.config.subtitle.sites;
  if (sites.length === 0) return; // missing-resolution emissions happen back in runSubtitleJob

  const hints = buildSearchHints({
    title: seriesTitle,
    languages: ctx.config.subtitle.languages,
    preferredGroups: ctx.config.subtitle.preferredGroups,
    alternates,
  });

  for (const site of sites) {
    if (missing.length === 0) break;

    const result = await search(ctx, job, site, hints, rawDir);
    const verifiedSuccess = result.download
      ? await extractAndMatch(ctx, job, site, result.download, seriesTitle, missing, media, placedFiles, refCache, refDir, rawDir, cache)
      : false;

    // A cooldown means the site never ran at all this job — nothing happened worth writing
    // to its notes file. Every other outcome (a download that placed nothing, an archive
    // that failed to extract, a give-up, a hard failure) is a completed run and reflects,
    // with verifiedSuccess carrying whether it actually placed something.
    if (result.outcome !== 'cooldown') {
      await reflect({
        ctx,
        job,
        site,
        transcript: result.transcript,
        verifiedSuccess,
        today: new Date(Date.now()).toISOString().slice(0, 10),
      });
    }
  }
}

/** Extracts one site's downloaded payload into the archive cache and matches it against the
 * still-missing episodes. Returns whether anything actually got placed this call —
 * `matchArchiveRow`'s resolved-episode-ids list is the placement oracle, not "a download
 * happened" or "extraction succeeded". `false` covers every non-placing case alike: not an
 * ingestible payload, an archive format extractArchive can't open, an archive with nothing
 * in it, or one that extracted fine but matched no missing episode. */
async function extractAndMatch(
  ctx: AppContext,
  job: JobRow,
  site: SubtitleSiteConfig,
  download: { filePath: string; url: string },
  seriesTitle: string,
  missing: EpisodeTarget[],
  media: MediaTools,
  placedFiles: PlacedFiles,
  refCache: Map<string, string>,
  refDir: string,
  rawDir: string,
  cache: ArchiveCache,
): Promise<boolean> {
  if (!isIngestibleSubtitlePayload(download.filePath)) return false;

  // Extract/copy into a PERSISTENT cache dir (outside runDir) so a later episode can reuse
  // the pack without re-downloading. Keyed uniquely so ArchiveCache's (target, path) upsert
  // refreshes the same row rather than piling up duplicates.
  const cacheDir = join(ctx.dataDir, 'subtitle', 'cache', `${siteKey(site.baseUrl)}-${basename(download.filePath)}`);
  let files: string[];
  try {
    files = await extractArchive(download.filePath, cacheDir);
  } catch (err) {
    if (err instanceof UnsupportedArchiveError) return false;
    throw err;
  }
  if (files.length === 0) return false;

  const entries = entriesForFiles(files);
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
  // matchArchiveRow drops fully-resolved episodes from `missing` itself.
  const resolved = await matchArchiveRow(ctx, job, row, missing, seriesTitle, media, placedFiles, refCache, refDir, rawDir, siteLabel(site.baseUrl));
  return resolved.length > 0;
}

/** Replaces path-breaking chars in a filename so it can't escape the ref/resync dirs. */
function sanitizeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_');
}
