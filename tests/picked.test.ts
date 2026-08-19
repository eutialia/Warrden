import { describe, it, expect } from 'vitest';
import { resolvePickedRelease } from '../src/pipelines/acquire/picked.js';
import { BYTES_PER_GB } from '../src/util/bytes.js';

const packKept = {
  guid: 'g-pack',
  indexer: 'Nyaa',
  title: '[Trix] Show S01 Batch',
  size: Math.round(12 * BYTES_PER_GB),
  seeders: 40,
  fullSeason: true,
  quality: { quality: { name: 'Bluray-1080p' } },
  languages: [
    { id: 1, name: 'English' },
    { id: 2, name: 'Japanese' },
  ],
};

describe('resolvePickedRelease', () => {
  it('kept matching guid returns title, indexer, size, seeders, quality, languages, pack shape, seasonNumber', () => {
    const picked = resolvePickedRelease({
      picked_guid: 'g-pack',
      candidates_json: { seasonNumber: 1, kept: [packKept], dropped: [] },
    });
    expect(picked).toEqual({
      title: '[Trix] Show S01 Batch',
      indexer: 'Nyaa',
      size: Math.round(12 * BYTES_PER_GB),
      seeders: 40,
      quality: 'Bluray-1080p',
      languages: ['English', 'Japanese'],
      shape: 'pack',
      seasonNumber: 1,
      forceGrab: false,
    });
  });

  it("kept single (no fullSeason, one episode number) has shape 'single'", () => {
    const picked = resolvePickedRelease({
      picked_guid: 'g-ep',
      candidates_json: {
        kept: [
          {
            guid: 'g-ep',
            title: 'Show S01E03',
            indexer: 'Nyaa',
            size: 1_000_000,
            seeders: 5,
            episodeNumbers: [3],
          },
        ],
      },
    });
    expect(picked).toMatchObject({ shape: 'single', forceGrab: false, title: 'Show S01E03' });
  });

  it('missing guid match returns null even if kept is non-empty', () => {
    expect(
      resolvePickedRelease({
        picked_guid: 'missing',
        candidates_json: { kept: [packKept] },
      }),
    ).toBeNull();
  });

  it('forceGrab + pickedTitle returns title with forceGrab true', () => {
    expect(
      resolvePickedRelease({
        picked_guid: 'g-top',
        candidates_json: { seasonNumber: 1, forceGrab: true, pickedTitle: '[Trix] S01 Batch' },
      }),
    ).toEqual({
      title: '[Trix] S01 Batch',
      indexer: null,
      size: null,
      seeders: null,
      quality: null,
      languages: [],
      shape: null,
      seasonNumber: 1,
      forceGrab: true,
    });
  });

  it('forceGrab without pickedTitle returns null', () => {
    expect(
      resolvePickedRelease({
        picked_guid: 'g-top',
        candidates_json: { forceGrab: true },
      }),
    ).toBeNull();
  });

  it('null candidates_json returns null', () => {
    expect(resolvePickedRelease({ picked_guid: 'g-pack', candidates_json: null })).toBeNull();
  });
});
