import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findMissingSubtitles, rankReferenceStreams, type VideoEntry } from '../src/pipelines/subtitle/reconcile.js';
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

function stream(overrides: Partial<MediaStream> & { index: number }): MediaStream {
  return { codecType: 'subtitle', codecName: 'subrip', language: null, forced: false, title: null, ...overrides };
}

const ZH_EMBEDDED: MediaStream[] = [
  stream({ index: 0, codecType: 'video', codecName: 'hevc' }),
  stream({ index: 2, codecName: 'ass', language: 'zh-Hans' }),
];

describe('findMissingSubtitles', () => {
  it('flags a video with no subtitle streams at all', async () => {
    const { video } = videoDir();
    const videos: VideoEntry[] = [{ videoPath: video, episodeId: 1 }];
    const { missing, absent } = await findMissingSubtitles({ videos, languages: ['zh-Hans'], media: fakeMedia({ [video]: [] }) });
    expect(missing).toEqual([{ videoPath: video, episodeId: 1, languages: ['zh-Hans'], embeddedRefs: [] }]);
    expect(absent).toEqual([]);
  });

  it('passes a video whose embedded track covers the language', async () => {
    const { video } = videoDir();
    const { missing } = await findMissingSubtitles({
      videos: [{ videoPath: video, episodeId: 1 }],
      languages: ['zh-Hans'],
      media: fakeMedia({ [video]: ZH_EMBEDDED }),
    });
    expect(missing).toEqual([]);
  });

  it('passes a video covered by an external sibling sub with a matching lang tag', async () => {
    const { dir, video } = videoDir();
    writeFileSync(join(dir, 'Show - S01E05.zh-Hans.ass'), 'x');
    const { missing } = await findMissingSubtitles({
      videos: [{ videoPath: video, episodeId: 1 }],
      languages: ['zh-Hans'],
      media: fakeMedia({ [video]: [] }),
    });
    expect(missing).toEqual([]);
  });

  it('reports embeddedRefs for drift-gate reference extraction when other languages are missing', async () => {
    const { video } = videoDir();
    const { missing } = await findMissingSubtitles({
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
    const media = fakeMedia({ [video]: [stream({ index: 2, codecName: 'ass', language: 'ZH' })] });
    const { missing } = await findMissingSubtitles({
      videos: [{ videoPath: video, episodeId: 1 }],
      languages: ['zh-Hans'],
      media,
    });
    expect(missing).toEqual([]);
  });

  it('treats an untagged external sibling sub as covering nothing', async () => {
    const { dir, video } = videoDir();
    writeFileSync(join(dir, 'Show - S01E05.ass'), 'x');
    const { missing } = await findMissingSubtitles({
      videos: [{ videoPath: video, episodeId: 1 }],
      languages: ['zh-Hans'],
      media: fakeMedia({ [video]: [] }),
    });
    expect(missing).toHaveLength(1);
  });

  it('does not let a longer same-prefix sibling sub cover an episode', async () => {
    const { dir, video } = videoDir();
    writeFileSync(join(dir, 'Show - S01E05 Special.zh-Hans.ass'), 'x');
    const { missing } = await findMissingSubtitles({
      videos: [{ videoPath: video, episodeId: 1 }],
      languages: ['zh-Hans'],
      media: fakeMedia({ [video]: [] }),
    });
    expect(missing).toEqual([{ videoPath: video, episodeId: 1, languages: ['zh-Hans'], embeddedRefs: [] }]);
  });

  it('reports a video that is gone from disk as absent, without probing it', async () => {
    const { dir, video } = videoDir();
    const gone = join(dir, 'Show - S02E01.mkv');
    const probed: string[] = [];
    const media = fakeMedia({ [video]: [] });
    const spyMedia: MediaTools = {
      ...media,
      probeStreams: async (p: string) => {
        probed.push(p);
        return media.probeStreams(p);
      },
    };
    const { missing, absent } = await findMissingSubtitles({
      videos: [
        { videoPath: gone, episodeId: 2 },
        { videoPath: video, episodeId: 1 },
      ],
      languages: ['zh-Hans'],
      media: spyMedia,
    });
    expect(missing.map((m) => m.videoPath)).toEqual([video]);
    expect(absent).toEqual([gone]);
    expect(probed).toEqual([video]);
  });

  it('propagates a probe failure on a video that is still on disk', async () => {
    const { video } = videoDir();
    const boom = new Error('ffprobe not found');
    const throwingMedia: MediaTools = {
      probeStreams: async () => {
        throw boom;
      },
      extractSubtitle: async () => {},
      resyncAlass: async () => {},
      resyncFfsubsync: async () => {},
      available: async () => ({ ffprobe: true, alass: true, ffsubsync: true }),
    };
    await expect(
      findMissingSubtitles({ videos: [{ videoPath: video, episodeId: 1 }], languages: ['zh-Hans'], media: throwingMedia }),
    ).rejects.toBe(boom);
  });

  it('ranks the full track first when the forced track comes first in the probe', async () => {
    const { video } = videoDir();
    // TARDiS MULTi layout: the forced FR track is stream 3, the full FR track is stream 4.
    const { missing } = await findMissingSubtitles({
      videos: [{ videoPath: video, episodeId: 1 }],
      languages: ['zh-Hans'],
      media: fakeMedia({
        [video]: [
          stream({ index: 0, codecType: 'video', codecName: 'hevc' }),
          stream({ index: 3, language: 'fre', title: 'FR Forced : SRT', forced: true }),
          stream({ index: 4, language: 'fre', title: 'FR Full : SRT' }),
        ],
      }),
    });
    expect(missing[0]!.embeddedRefs).toEqual([
      { streamIndex: 4, lang: 'fre' },
      { streamIndex: 3, lang: 'fre' },
    ]);
  });
});

describe('rankReferenceStreams', () => {
  const cases: { name: string; streams: MediaStream[]; expected: number[] }[] = [
    {
      name: 'forced by disposition sinks below the full track',
      streams: [stream({ index: 3, forced: true }), stream({ index: 4 })],
      expected: [4, 3],
    },
    {
      name: 'forced by title sinks below the full track',
      streams: [stream({ index: 3, title: 'FR Forced : SRT' }), stream({ index: 4, title: 'FR Full : SRT' })],
      expected: [4, 3],
    },
    {
      name: 'a signs & songs track sinks below the full track',
      streams: [stream({ index: 2, title: 'Signs & Songs' }), stream({ index: 3, title: 'Full Subtitles' })],
      expected: [3, 2],
    },
    {
      name: 'a bitmap track sinks below every text track, forced ones included',
      streams: [
        stream({ index: 2, codecName: 'hdmv_pgs_subtitle' }),
        stream({ index: 3, codecName: 'dvd_subtitle' }),
        stream({ index: 4, codecName: 'subrip', forced: true }),
      ],
      expected: [4, 2, 3],
    },
    {
      name: 'equally good tracks fall back to stream index',
      streams: [stream({ index: 5, codecName: 'ass' }), stream({ index: 2, codecName: 'subrip' }), stream({ index: 9, codecName: 'mov_text' })],
      expected: [2, 5, 9],
    },
    {
      name: 'non-subtitle streams are dropped',
      streams: [stream({ index: 0, codecType: 'video', codecName: 'hevc' }), stream({ index: 1, codecType: 'audio', codecName: 'eac3' }), stream({ index: 2 })],
      expected: [2],
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(rankReferenceStreams(c.streams).map((r) => r.streamIndex)).toEqual(c.expected);
    });
  }

  it('carries the language of each ranked stream', () => {
    expect(rankReferenceStreams([stream({ index: 3, language: 'fre', forced: true }), stream({ index: 4, language: 'eng' })])).toEqual([
      { streamIndex: 4, lang: 'eng' },
      { streamIndex: 3, lang: 'fre' },
    ]);
  });
});
