import { describe, expect, it } from 'vitest';
import { ArchiveCache } from '../src/db/archiveCache.js';
import { freshDb } from './helpers.js';

const INPUT = {
  arrInstance: 'sonarr',
  targetKind: 'series' as const,
  targetId: 42,
  sourceUrl: 'https://acg.rip/t/1',
  path: '/data/cache/42/bundle.zip',
  files: [
    { path: 'S1/01.ass', lang: 'zh-Hans', episodeRef: { season: null, episode: 1 } },
    { path: 'S1/02.ass', lang: null, episodeRef: null },
  ],
};

describe('ArchiveCache', () => {
  it('upserts and reads back rows newest-first', () => {
    const cache = new ArchiveCache(freshDb());
    cache.upsert(INPUT);
    cache.upsert({ ...INPUT, sourceUrl: 'https://acg.rip/t/2', path: '/data/cache/42/b2.zip' });
    const rows = cache.forTarget('sonarr', 'series', 42);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.source_url).toBe('https://acg.rip/t/2');
    expect(rows[1]!.files[0]).toEqual({ path: 'S1/01.ass', lang: 'zh-Hans', episodeRef: { season: null, episode: 1 } });
  });

  it('re-upserting the same path refreshes the row in place', () => {
    const cache = new ArchiveCache(freshDb());
    cache.upsert(INPUT);
    cache.upsert({ ...INPUT, files: [] });
    const rows = cache.forTarget('sonarr', 'series', 42);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.files).toEqual([]);
  });

  it('scopes by target and deletes by id', () => {
    const cache = new ArchiveCache(freshDb());
    cache.upsert(INPUT);
    cache.upsert({ ...INPUT, targetId: 43 });
    expect(cache.forTarget('sonarr', 'series', 42)).toHaveLength(1);
    cache.deleteById(cache.forTarget('sonarr', 'series', 42)[0]!.id);
    expect(cache.forTarget('sonarr', 'series', 42)).toHaveLength(0);
  });
});
