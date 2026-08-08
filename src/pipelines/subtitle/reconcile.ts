import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { MediaTools } from '../../media/tools.js';
import { parseLangTag } from '../ingest/sidecars.js';

export interface VideoEntry {
  videoPath: string;
  episodeId?: number;
  movieId?: number;
  externalSubtitles: string[]; // filled by findMissingSubtitles itself; callers pass []
}

export interface MissingSubtitle {
  videoPath: string;
  episodeId?: number;
  movieId?: number;
  languages: string[]; // still-missing target languages
  embeddedRefs: { streamIndex: number; lang: string | null }[]; // embedded subs usable as drift reference
}

const SUB_EXTS = new Set(['.srt', '.ass', '.ssa']);

/** Primary-subtag + full-tag match, case-insensitive: config 'zh-Hans' covers stream tags
 * 'zh-hans' and 'zh', but NOT 'zh-Hant'. ffprobe tags are ISO codes, so no fansub-token
 * normalization here — that's parseLangTag's job, and only on filenames. */
function langCovers(want: string, have: string | null): boolean {
  if (have === null) return false;
  const w = want.toLowerCase();
  const h = have.toLowerCase();
  return h === w || h === w.split('-')[0] || w === h.split('-')[0];
}

/** Same-stem sibling subtitle files for a video, e.g. 'Show - S01E05.zh-Hans.ass'. */
function externalSubsFor(videoPath: string): string[] {
  const dir = dirname(videoPath);
  if (!existsSync(dir)) return [];
  const stem = basename(videoPath).replace(/\.[^.]+$/, '');
  return readdirSync(dir)
    .filter((f) => SUB_EXTS.has(extname(f).toLowerCase()) && f.replace(/\.[^.]+$/, '').startsWith(stem))
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
    const streams = await media.probeStreams(video.videoPath);
    const embedded = streams.filter((s) => s.codecType === 'subtitle');
    video.externalSubtitles = externalSubsFor(video.videoPath);
    const externalLangs = video.externalSubtitles.map((p) => parseLangTag(basename(p)));

    const lacking = languages.filter((lang) => {
      const embeddedHit = embedded.some((s) => langCovers(lang, s.language));
      const externalHit = externalLangs.some((l) => langCovers(lang, l));
      return !embeddedHit && !externalHit;
    });

    if (lacking.length > 0) {
      missing.push({
        videoPath: video.videoPath,
        episodeId: video.episodeId,
        movieId: video.movieId,
        languages: lacking,
        embeddedRefs: embedded.map((s) => ({ streamIndex: s.index, lang: s.language })),
      });
    }
  }
  return missing;
}
