import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findMissingSubtitles, type VideoEntry } from '../src/pipelines/subtitle/reconcile.js';
import type { MediaStream, MediaTools } from '../src/media/tools.js';

function fakeMedia(streamsByPath: Record<string, MediaStream[]>): MediaTools {
  return {
    probeStreams: async (p: string) => streamsByPath[p] ?? [],
    extractSubtitle: async () => {},
    resyncAlass: async () => {},
    resyncFfsubsync: async () => {},
    available: async () => ({ ffprobe: true, alass: true, ffsubsync: true }),
  };
}

function videoDir(): { dir: string; video: string } {
  const dir = mkdtempSync(join(tmpdir(), 'warrden-sub-'));
  const video = join(dir, 'Show - S01E05.mkv');
  writeFileSync(video, 'video');
  return { dir, video };
}

const ZH_EMBEDDED: MediaStream[] = [
  { index: 0, codecType: 'video', codecName: 'hevc', language: null },
  { index: 2, codecType: 'subtitle', codecName: 'ass', language: 'zh-Hans' },
];

describe('findMissingSubtitles', () => {
  it('flags a video with no subtitle streams at all', async () => {
    const { video } = videoDir();
    const videos: VideoEntry[] = [{ videoPath: video, episodeId: 1 }];
    const missing = await findMissingSubtitles({ videos, languages: ['zh-Hans'], media: fakeMedia({ [video]: [] }) });
    expect(missing).toEqual([{ videoPath: video, episodeId: 1, languages: ['zh-Hans'], embeddedRefs: [] }]);
  });

  it('passes a video whose embedded track covers the language', async () => {
    const { video } = videoDir();
    const missing = await findMissingSubtitles({
      videos: [{ videoPath: video, episodeId: 1 }],
      languages: ['zh-Hans'],
      media: fakeMedia({ [video]: ZH_EMBEDDED }),
    });
    expect(missing).toEqual([]);
  });

  it('passes a video covered by an external sibling sub with a matching lang tag', async () => {
    const { dir, video } = videoDir();
    writeFileSync(join(dir, 'Show - S01E05.zh-Hans.ass'), 'x');
    const missing = await findMissingSubtitles({
      videos: [{ videoPath: video, episodeId: 1 }],
      languages: ['zh-Hans'],
      media: fakeMedia({ [video]: [] }),
    });
    expect(missing).toEqual([]);
  });

  it('reports embeddedRefs for drift-gate reference extraction when other languages are missing', async () => {
    const { video } = videoDir();
    const missing = await findMissingSubtitles({
      videos: [{ videoPath: video, episodeId: 1 }],
      languages: ['zh-Hans', 'zh-Hant'],
      media: fakeMedia({ [video]: ZH_EMBEDDED }),
    });
    expect(missing).toHaveLength(1);
    expect(missing[0]!.languages).toEqual(['zh-Hant']);
    expect(missing[0]!.embeddedRefs).toEqual([{ streamIndex: 2, lang: 'zh-Hans' }]);
  });

  it('matches language tags case-insensitively and by primary subtag', async () => {
    const { video } = videoDir();
    const media = fakeMedia({ [video]: [{ index: 2, codecType: 'subtitle', codecName: 'ass', language: 'ZH' }] });
    const missing = await findMissingSubtitles({
      videos: [{ videoPath: video, episodeId: 1 }],
      languages: ['zh-Hans'],
      media,
    });
    expect(missing).toEqual([]);
  });

  it('treats an untagged external sibling sub as covering nothing', async () => {
    const { dir, video } = videoDir();
    writeFileSync(join(dir, 'Show - S01E05.ass'), 'x');
    const missing = await findMissingSubtitles({
      videos: [{ videoPath: video, episodeId: 1 }],
      languages: ['zh-Hans'],
      media: fakeMedia({ [video]: [] }),
    });
    expect(missing).toHaveLength(1);
  });

  it('does not let a longer same-prefix sibling sub cover an episode', async () => {
    const { dir, video } = videoDir();
    writeFileSync(join(dir, 'Show - S01E05 Special.zh-Hans.ass'), 'x');
    const missing = await findMissingSubtitles({
      videos: [{ videoPath: video, episodeId: 1 }],
      languages: ['zh-Hans'],
      media: fakeMedia({ [video]: [] }),
    });
    expect(missing).toEqual([{ videoPath: video, episodeId: 1, languages: ['zh-Hans'], embeddedRefs: [] }]);
  });

  it('skips a video whose probe throws instead of crashing the reconcile', async () => {
    const { video } = videoDir();
    const other = join(videoDir().dir, 'Show - S02E01.mkv');
    const throwingMedia: MediaTools = {
      probeStreams: async (p: string) => {
        if (p === video) throw new Error('file vanished');
        return ZH_EMBEDDED;
      },
      extractSubtitle: async () => {},
      resyncAlass: async () => {},
      resyncFfsubsync: async () => {},
      available: async () => ({ ffprobe: true, alass: true, ffsubsync: true }),
    };
    const missing = await findMissingSubtitles({
      videos: [
        { videoPath: video, episodeId: 1 },
        { videoPath: other, episodeId: 2 },
      ],
      languages: ['zh-Hans'],
      media: throwingMedia,
    });
    expect(missing).toEqual([]);
  });
});
