import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { MediaStream, MediaTools } from '../../media/tools.js';
import { parseLangTag, sidecarStem } from '../ingest/sidecars.js';

export interface VideoEntry {
  // Kept exported: tests build VideoEntry[] fixtures against this shape.
  videoPath: string;
  episodeId?: number;
}

interface MissingSubtitle {
  videoPath: string;
  episodeId?: number;
  languages: string[]; // still-missing target languages
  embeddedRefs: { streamIndex: number; lang: string | null }[]; // embedded subs usable as drift reference
}

const SUB_EXTS = new Set(['.srt', '.ass', '.ssa']);

const TEXT_SUB_CODECS = new Set(['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);

/** Titles that mean "this track only covers signs, songs, or foreign dialogue". Fansub
 * "Signs & Songs" tracks are as sparse as a forced track and just as useless for timing. */
const SPARSE_TITLE = /\b(forced|signs?|songs?)\b/i;

function isSparse(s: MediaStream): boolean {
  return s.forced || (s.title !== null && SPARSE_TITLE.test(s.title));
}

/**
 * Orders the subtitle streams of a container best-first as a drift-timing reference. Order
 * matters because the drift gate extracts `embeddedRefs[0]` and nothing else: pick a forced
 * track (a handful of sign lines) and every candidate scores unscorable and gets quarantined,
 * which is exactly what a TARDiS MULTi mux does when its forced FR track is muxed before the
 * full one. Full text tracks rank first, then forced/signs text tracks, then bitmap tracks.
 * Bitmap tracks are ranked rather than dropped so a PGS-only release keeps the same reference
 * it had before: `extractSubtitle` writes .srt, ffmpeg refuses to transcode PGS into it, and
 * `referenceCues` already reads a failed extraction as "no reference".
 */
export function rankReferenceStreams(streams: MediaStream[]): { streamIndex: number; lang: string | null }[] {
  return streams
    .filter((s) => s.codecType === 'subtitle')
    .map((s) => ({ s, rank: (TEXT_SUB_CODECS.has(s.codecName.toLowerCase()) ? 0 : 2) + (isSparse(s) ? 1 : 0) }))
    .sort((a, b) => a.rank - b.rank || a.s.index - b.s.index)
    .map(({ s }) => ({ streamIndex: s.index, lang: s.language }));
}

/** Primary-subtag + full-tag match, case-insensitive: config 'zh-Hans' covers stream tags
 * 'zh-hans' and 'zh', but NOT 'zh-Hant'. ffprobe tags are ISO codes, so no fansub-token
 * normalization here — that's parseLangTag's job, and only on filenames. Exported so the
 * pipeline runner can apply the same coverage rule when deciding whether a just-placed
 * candidate actually filled a still-missing language. */
export function langCovers(want: string, have: string | null): boolean {
  if (have === null) return false;
  const w = want.toLowerCase();
  const h = have.toLowerCase();
  return h === w || h === w.split('-')[0] || w === h.split('-')[0];
}

/** Same-stem sibling subtitle files for a video, e.g. 'Show - S01E05.zh-Hans.ass'.
 * Matching uses exact stem equality (via `sidecarStem`, which strips the extension then
 * one trailing lang token), never a prefix match — a `Show - S01E05 Special.zh-Hans.ass`
 * must not count as covering `Show - S01E05.mkv`. */
function externalSubsFor(videoPath: string): string[] {
  const dir = dirname(videoPath);
  if (!existsSync(dir)) return [];
  const stem = sidecarStem(basename(videoPath));
  return readdirSync(dir)
    .filter((f) => SUB_EXTS.has(extname(f).toLowerCase()) && sidecarStem(f) === stem)
    .map((f) => join(dir, f));
}

/**
 * The subtitle pipeline's reconcile: for every video the arr knows about, decide which
 * target languages it still lacks — covered means an embedded ffprobe stream OR a same-stem
 * external sibling carries that language. Videos already fully covered are dropped from the
 * result entirely; the agent only ever hears about actual gaps. `embeddedRefs` rides along
 * so the drift gate can extract a reference track later without re-probing, ranked by
 * `rankReferenceStreams` because the gate only ever reads the first entry.
 */
export async function findMissingSubtitles(input: {
  videos: VideoEntry[];
  languages: string[];
  media: MediaTools;
}): Promise<MissingSubtitle[]> {
  const { videos, languages, media } = input;
  if (languages.length === 0) return [];
  const missing: MissingSubtitle[] = [];

  for (const video of videos) {
    // A video can vanish mid-run (a torrent client moving files on a live share): skip it
    // rather than report a gap for a file that is no longer there. Every other probe
    // failure (no ffprobe on PATH, an unmapped path, a timeout) propagates, because
    // swallowing it would read as "this video already has every language".
    if (!existsSync(video.videoPath)) continue;
    const streams = await media.probeStreams(video.videoPath);
    const embedded = streams.filter((s) => s.codecType === 'subtitle');
    const externalLangs = externalSubsFor(video.videoPath).map((p) => parseLangTag(basename(p)));

    const lacking = languages.filter((lang) => {
      const embeddedHit = embedded.some((s) => langCovers(lang, s.language));
      const externalHit = externalLangs.some((l) => langCovers(lang, l));
      return !embeddedHit && !externalHit;
    });

    if (lacking.length > 0) {
      missing.push({
        videoPath: video.videoPath,
        episodeId: video.episodeId,
        languages: lacking,
        embeddedRefs: rankReferenceStreams(embedded),
      });
    }
  }
  return missing;
}
