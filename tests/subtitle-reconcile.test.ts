import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findMissingSubtitles,
  langCovers,
  parseSidecarLanguage,
  rankReferenceStreams,
  type VideoEntry,
} from '../src/pipelines/subtitle/reconcile.js';
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
    const { videos: gaps, absent } = await findMissingSubtitles({ videos, languages: ['zh-Hans'], media: fakeMedia({ [video]: [] }) });
    expect(gaps).toEqual([{ videoPath: video, episodeId: 1, lacking: ['zh-Hans'], covered: false, embeddedRefs: [] }]);
    expect(absent).toEqual([]);
  });

  it('passes a video whose embedded track covers the language', async () => {
    const { video } = videoDir();
    const { videos: gaps } = await findMissingSubtitles({
      videos: [{ videoPath: video, episodeId: 1 }],
      languages: ['zh-Hans'],
      media: fakeMedia({ [video]: ZH_EMBEDDED }),
    });
    expect(gaps).toEqual([]);
  });

  it('passes a video covered by an external sibling sub with a matching lang tag', async () => {
    const { dir, video } = videoDir();
    writeFileSync(join(dir, 'Show - S01E05.zh-Hans.ass'), 'x');
    const { videos: gaps } = await findMissingSubtitles({
      videos: [{ videoPath: video, episodeId: 1 }],
      languages: ['zh-Hans'],
      media: fakeMedia({ [video]: [] }),
    });
    expect(gaps).toEqual([]);
  });

  it('reports embeddedRefs for drift-gate reference extraction when other languages are missing', async () => {
    const { video } = videoDir();
    const { videos: gaps } = await findMissingSubtitles({
      videos: [{ videoPath: video, episodeId: 1 }],
      languages: ['zh-Hans', 'zh-Hant'],
      media: fakeMedia({ [video]: ZH_EMBEDDED }),
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.lacking).toEqual(['zh-Hant']);
    expect(gaps[0]!.covered).toBe(true);
    expect(gaps[0]!.embeddedRefs).toEqual([{ streamIndex: 2, lang: 'zh-Hans' }]);
  });

  it('matches an embedded language tag case-insensitively', async () => {
    const { video } = videoDir();
    const media = fakeMedia({ [video]: [stream({ index: 2, codecName: 'ass', language: 'ZH-HANS' })] });
    const { videos: gaps } = await findMissingSubtitles({
      videos: [{ videoPath: video, episodeId: 1 }],
      languages: ['zh-Hans'],
      media,
    });
    expect(gaps).toEqual([]);
  });

  it('does not let a generic embedded zh track cover zh-Hans', async () => {
    // ffprobe's `zh`/`chi`/`zho` say "Chinese", not which script — accepting one as zh-Hans
    // is how a Traditional track ends up filed as Simplified.
    const { video } = videoDir();
    const media = fakeMedia({ [video]: [stream({ index: 2, codecName: 'ass', language: 'zh' })] });
    const { videos: gaps } = await findMissingSubtitles({
      videos: [{ videoPath: video, episodeId: 1 }],
      languages: ['zh-Hans'],
      media,
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.covered).toBe(false);
  });

  it('any one configured language covers the video, the rest stay lacking', async () => {
    const { dir, video } = videoDir();
    writeFileSync(join(dir, 'Show - S01E05.zh-Hans.srt'), 'x');
    const { videos: gaps } = await findMissingSubtitles({
      videos: [{ videoPath: video, episodeId: 1 }],
      languages: ['zh-Hans', 'zh-Hant'],
      media: fakeMedia({ [video]: [] }),
    });
    expect(gaps).toEqual([{ videoPath: video, episodeId: 1, lacking: ['zh-Hant'], covered: true, embeddedRefs: [] }]);
  });

  it('reads the lang tag of a sidecar whose video stem has dots of its own', async () => {
    // 'The.Big.Sick.2017.zh-Hans.srt' only says zh-Hans if the segments are taken after the
    // stem; taken after the first dot, 'Big' reads as a three-letter code and wins.
    const dir = mkdtempSync(join(tmpdir(), 'warrden-sub-'));
    const video = join(dir, 'The.Big.Sick.2017.mkv');
    writeFileSync(video, 'video');
    writeFileSync(join(dir, 'The.Big.Sick.2017.zh-Hans.srt'), 'x');
    const { videos: gaps } = await findMissingSubtitles({
      videos: [{ videoPath: video, episodeId: 1 }],
      languages: ['zh-Hans'],
      media: fakeMedia({ [video]: [] }),
    });
    expect(gaps).toEqual([]);
  });

  it('a sidecar in none of the configured languages leaves the video uncovered', async () => {
    const { dir, video } = videoDir();
    writeFileSync(join(dir, 'Show - S01E05.zh.srt'), 'x');
    const { videos: gaps } = await findMissingSubtitles({
      videos: [{ videoPath: video, episodeId: 1 }],
      languages: ['zh-Hans', 'zh-Hant'],
      media: fakeMedia({ [video]: [] }),
    });
    expect(gaps).toEqual([
      { videoPath: video, episodeId: 1, lacking: ['zh-Hans', 'zh-Hant'], covered: false, embeddedRefs: [] },
    ]);
  });

  it('drops a video that carries every configured language', async () => {
    const { dir, video } = videoDir();
    writeFileSync(join(dir, 'Show - S01E05.zh-Hans.srt'), 'x');
    writeFileSync(join(dir, 'Show - S01E05.zh-Hant.srt'), 'x');
    const { videos: gaps } = await findMissingSubtitles({
      videos: [{ videoPath: video, episodeId: 1 }],
      languages: ['zh-Hans', 'zh-Hant'],
      media: fakeMedia({ [video]: [] }),
    });
    expect(gaps).toEqual([]);
  });

  it('treats an untagged external sibling sub as covering nothing', async () => {
    const { dir, video } = videoDir();
    writeFileSync(join(dir, 'Show - S01E05.ass'), 'x');
    const { videos: gaps } = await findMissingSubtitles({
      videos: [{ videoPath: video, episodeId: 1 }],
      languages: ['zh-Hans'],
      media: fakeMedia({ [video]: [] }),
    });
    expect(gaps).toHaveLength(1);
  });

  it('does not let a longer same-prefix sibling sub cover an episode', async () => {
    const { dir, video } = videoDir();
    writeFileSync(join(dir, 'Show - S01E05 Special.zh-Hans.ass'), 'x');
    const { videos: gaps } = await findMissingSubtitles({
      videos: [{ videoPath: video, episodeId: 1 }],
      languages: ['zh-Hans'],
      media: fakeMedia({ [video]: [] }),
    });
    expect(gaps).toEqual([{ videoPath: video, episodeId: 1, lacking: ['zh-Hans'], covered: false, embeddedRefs: [] }]);
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
    const { videos: gaps, absent } = await findMissingSubtitles({
      videos: [
        { videoPath: gone, episodeId: 2 },
        { videoPath: video, episodeId: 1 },
      ],
      languages: ['zh-Hans'],
      media: spyMedia,
    });
    expect(gaps.map((g) => g.videoPath)).toEqual([video]);
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
    const { videos: gaps } = await findMissingSubtitles({
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
    expect(gaps[0]!.embeddedRefs).toEqual([
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

describe('parseSidecarLanguage', () => {
  // Jellyfin's own rule (ExternalPathParser): dot-separated segments after the video stem,
  // each judged on its own, in any order.
  const cases: [string, string, string | null][] = [
    ['Show.zh-Hans.srt', 'Show', 'zh-Hans'],
    ['Show.ZH-HANT.ass', 'Show', 'zh-Hant'],
    ['Show.zh.srt', 'Show', 'zh'],
    ['Show.chs.srt', 'Show', 'chs'],
    ['Show.en.hi.srt', 'Show', 'en'],
    ['Show.hi.srt', 'Show', 'hi'],
    ['Show.forced.zh-Hant.srt', 'Show', 'zh-Hant'],
    ['Show.Director Commentary.en.srt', 'Show', 'en'],
    ['Show.srt', 'Show', null],
    ['Show.default.srt', 'Show', null],
    ['Show.ZH-CN.srt', 'Show', 'zh-CN'],
    ['Show.zh-tw.srt', 'Show', 'zh-TW'],
    ['Show.zh-HK.srt', 'Show', 'zh-HK'],
    // A stem with dots of its own: only the segments AFTER it are language candidates,
    // or 'Big' in the first one reads as a three-letter ISO code.
    ['The.Big.Sick.2017.zh-Hans.srt', 'The.Big.Sick.2017', 'zh-Hans'],
    ['Show.Name.S01E05.WEB.DL.zh-Hans.srt', 'Show.Name.S01E05.WEB.DL', 'zh-Hans'],
    ['Show.Name.S01E05.WEB.DL.srt', 'Show.Name.S01E05.WEB.DL', null],
  ];

  it.each(cases)('%s (stem %s) -> %s', (filename, stem, expected) => {
    expect(parseSidecarLanguage(filename, stem)).toBe(expected);
  });
});

describe('langCovers', () => {
  const cases: [string, string | null, boolean][] = [
    ['zh-Hans', 'zh-hans', true],
    ['zh-Hans', 'zh', false],
    ['zh-Hans', 'zh-Hant', false],
    ['en', 'eng', false],
    ['en', null, false],
  ];

  it.each(cases)('want %s, have %s -> %s', (want, have, expected) => {
    expect(langCovers(want, have)).toBe(expected);
  });
});
