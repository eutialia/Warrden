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
 * so the drift gate can extract a reference track later without re-probing.
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
    // A video can vanish mid-probe (a torrent client moving files on a live share makes
    // `probeStreams` reject): skip it rather than crash the whole reconcile or report it
    // as missing when it's simply gone.
    let streams: MediaStream[];
    try {
      streams = await media.probeStreams(video.videoPath);
    } catch {
      continue;
    }
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
        embeddedRefs: embedded.map((s) => ({ streamIndex: s.index, lang: s.language })),
      });
    }
  }
  return missing;
}
