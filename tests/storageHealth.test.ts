import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { cachedStorage, probeStorage, resetStorageCache } from '../src/server/storageHealth.js';
import { tmpDir } from './helpers.js';

function cfgWith(storage: Record<string, string>) {
  return ConfigSchema.parse({ storage });
}

function statusOf(storage: Record<string, string>, id: string): string {
  return probeStorage(cfgWith(storage)).find((c) => c.id === id)!.status;
}

describe('probeStorage', () => {
  it('reports a blank path as not configured, not as an error', () => {
    const check = probeStorage(cfgWith({ anime: '' })).find((c) => c.id === 'anime')!;
    expect(check.status).toBe('not-configured');
    expect(check.path).toBe('');
  });

  it('reports a path that does not exist as missing', () => {
    expect(statusOf({ series: join(tmpDir(), 'nope') }, 'series')).toBe('missing');
  });

  it('reports an empty directory on the machine filesystem as looks-unmounted', () => {
    const dir = join(tmpDir(), 'tv');
    mkdirSync(dir);
    expect(statusOf({ series: dir }, 'series')).toBe('looks-unmounted');
  });

  it('accepts a directory on the machine filesystem that has media in it', () => {
    const dir = join(tmpDir(), 'tv');
    mkdirSync(dir);
    writeFileSync(join(dir, 'Frieren S01E01.mkv'), 'video');
    expect(statusOf({ series: dir }, 'series')).toBe('ok');
  });

  it('keeps the four roles in order', () => {
    expect(probeStorage(ConfigSchema.parse({})).map((c) => c.id)).toEqual([
      'series',
      'anime',
      'movies',
      'downloads',
    ]);
  });
});

describe('cachedStorage', () => {
  it('serves the previous answer inside the cache window', () => {
    resetStorageCache();
    const dir = join(tmpDir(), 'tv');
    mkdirSync(dir);
    const first = cachedStorage(cfgWith({ series: dir }), 1_000);
    writeFileSync(join(dir, 'Frieren S01E01.mkv'), 'video');
    const second = cachedStorage(cfgWith({ series: dir }), 5_000);
    expect(second[0].status).toBe(first[0].status);
  });

  it('re-probes after resetStorageCache, so a saved path shows its real status at once', () => {
    resetStorageCache();
    const dir = join(tmpDir(), 'tv');
    mkdirSync(dir);
    expect(cachedStorage(cfgWith({ series: dir }), 1_000)[0].status).toBe('looks-unmounted');
    writeFileSync(join(dir, 'Frieren S01E01.mkv'), 'video');
    resetStorageCache();
    expect(cachedStorage(cfgWith({ series: dir }), 5_000)[0].status).toBe('ok');
  });
});
