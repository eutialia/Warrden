import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { MediaStream, MediaTools } from '../../media/tools.js';

export interface VideoEntry {
  // Kept exported: tests build VideoEntry[] fixtures against this shape.
  videoPath: string;
}

export interface SubtitleGap {
  videoPath: string;
  lacking: string[]; // configured tags this video does not carry, in config order
  covered: boolean; // at least one configured tag is present
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

/** Exact tag equality, case-insensitive: 'zh-Hans' is covered by 'zh-hans' and by nothing
 * else — not by 'zh', not by 'zh-Hant', not by 'chi'. A generic Chinese tag says nothing
 * about the script, and treating it as Simplified is how a Traditional track ends up filed
 * as the language the operator asked for. Exported so the pipeline runner can apply the same
 * rule when deciding whether a just-placed candidate filled a language the episode lacked. */
export function langCovers(want: string, have: string | null): boolean {
  if (have === null) return false;
  return want.toLowerCase() === have.toLowerCase();
}

/** Segments that are a track attribute rather than a language. `hi` is absent on purpose:
 * it is Hindi when it stands alone and hearing-impaired when it sits beside a language. */
const FLAG_SEGMENTS = new Set(['default', 'forced', 'foreign', 'sdh', 'cc']);

/** The only language tags Jellyfin recognizes beyond bare ISO codes, and the casing it
 * writes them in. Bare `zh`/`chi`/`zho` stay generic Chinese. */
const SCRIPT_TAGS = new Map([
  ['zh-hans', 'zh-Hans'],
  ['zh-hant', 'zh-Hant'],
  ['zh-cn', 'zh-CN'],
  ['zh-tw', 'zh-TW'],
  ['zh-hk', 'zh-HK'],
]);

/**
 * The language of an external subtitle file as Jellyfin reads it (ExternalPathParser): the
 * dot-separated segments between the video stem and the extension, each judged on its own
 * and in any order. A segment is a language when it is a two- or three-letter ISO code or
 * one of the `zh-*` script tags; `default`/`forced`/`foreign`/`sdh`/`cc` are flags and
 * anything else is a title. Returns the first language segment in canonical casing, or null.
 *
 * `stem` is the video's own stem and has to be passed in: scene names carry dots
 * (`The.Big.Sick.2017.zh-Hans.srt`), and splitting on the first dot instead reads `Big` as a
 * three-letter ISO code. A file that does not sit under the stem has no segments at all.
 *
 * No ISO code table rides along: a three-letter segment is taken at face value, which at
 * worst yields a tag that matches no configured language — exactly what an unrecognized
 * segment would have done anyway. Fansub tokens (`chs`, `cht`) are deliberately NOT
 * translated: this is the library side, and the library is Jellyfin's to read.
 */
export function parseSidecarLanguage(filename: string, stem: string): string | null {
  const noExt = filename.replace(/\.[^.]+$/, '');
  const prefix = `${stem}.`;
  if (!noExt.startsWith(prefix)) return null;
  const segments = noExt.slice(prefix.length).split('.');
  let sawHi = false;
  for (const segment of segments) {
    const s = segment.toLowerCase();
    const script = SCRIPT_TAGS.get(s);
    if (script !== undefined) return script;
    if (s === 'hi') {
      sawHi = true;
      continue;
    }
    if (FLAG_SEGMENTS.has(s)) continue;
    if (/^[a-z]{2}$/.test(s) || /^[a-z]{3}$/.test(s)) return s;
  }
  return sawHi ? 'hi' : null;
}

/** Sibling subtitle files sitting under a video's stem, e.g. 'Show - S01E05.zh-Hans.hi.ass'.
 * Anything after `${stem}.` is left to `parseSidecarLanguage`, which anchors on the same stem:
 * a file may carry any number of flag and title segments around its language tag. The dot is
 * what keeps `Show - S01E05 Special.zh-Hans.ass` from covering `Show - S01E05.mkv`. */
function externalSubsFor(videoPath: string, stem: string): string[] {
  const dir = dirname(videoPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => SUB_EXTS.has(extname(f).toLowerCase()) && f.startsWith(`${stem}.`))
    .map((f) => join(dir, f));
}

/**
 * The subtitle pipeline's reconcile: for every video the arr knows about, decide which
 * configured language tags it still lacks (an embedded ffprobe stream or a same-stem
 * external sibling carrying the tag) and whether any one of them is present at all.
 * `covered` is what "this video has subtitles" means — one tag is enough — while `lacking`
 * is what a run passing by can still collect. A video carrying every configured tag is
 * dropped from the result entirely. `embeddedRefs` rides along so the drift gate can extract
 * a reference track later without re-probing, ranked by `rankReferenceStreams` because the
 * gate only ever reads the first entry.
 *
 * `absent` collects the videos that were not on disk at all. They are not gaps and not
 * failures here, but the caller needs them: a whole target coming back absent means the
 * paths are wrong, not that the library is complete.
 */
export async function findMissingSubtitles(input: {
  videos: VideoEntry[];
  languages: string[];
  media: MediaTools;
}): Promise<{ videos: SubtitleGap[]; absent: string[] }> {
  const { videos, languages, media } = input;
  if (languages.length === 0) return { videos: [], absent: [] };
  const gaps: SubtitleGap[] = [];
  const absent: string[] = [];

  for (const video of videos) {
    // A video can vanish mid-run (a torrent client moving files on a live share), and a
    // mis-configured path mapping makes every video look that way: skip it rather than
    // report a gap for a file that is not there, but hand the path back in `absent` so the
    // caller can tell "this one moved" from "none of these paths resolve". Every other probe
    // failure (no ffprobe on PATH, a timeout) propagates, because swallowing it would read
    // as "this video already has every language".
    if (!existsSync(video.videoPath)) {
      absent.push(video.videoPath);
      continue;
    }
    const streams = await media.probeStreams(video.videoPath);
    const embedded = streams.filter((s) => s.codecType === 'subtitle');
    const stem = basename(video.videoPath, extname(video.videoPath));
    const externalLangs = externalSubsFor(video.videoPath, stem).map((p) => parseSidecarLanguage(basename(p), stem));

    const lacking = languages.filter((lang) => {
      const embeddedHit = embedded.some((s) => langCovers(lang, s.language));
      const externalHit = externalLangs.some((l) => langCovers(lang, l));
      return !embeddedHit && !externalHit;
    });

    if (lacking.length > 0) {
      gaps.push({
        videoPath: video.videoPath,
        lacking,
        covered: lacking.length < languages.length,
        embeddedRefs: rankReferenceStreams(embedded),
      });
    }
  }
  return { videos: gaps, absent };
}
