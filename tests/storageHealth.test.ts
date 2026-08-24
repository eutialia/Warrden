import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import type { StatDev } from '../src/fs/mountPoint.js';
import { cachedStorage, probeStorage, resetStorageCache } from '../src/server/storageHealth.js';
import { tmpDir } from './helpers.js';

function cfgWith(storage: Record<string, string>) {
  return ConfigSchema.parse({ storage });
}

/** Every path on one device, so the containing mount walks all the way up to `/`. Whether a
 * real mkdtemp directory does that depends on the host: `/tmp` is its own tmpfs on many
 * Linux boxes and shares a device with `/` on a Mac. */
const oneDevice: StatDev = () => ({ dev: 1 });

/** `path` sits on its own filesystem, the NFS and SMB case a test cannot really mount. */
function mountedAt(path: string): StatDev {
  return (p) => ({ dev: p === path ? 2 : 1 });
}

/** A mount that fails every syscall with `code`/`errno`, the way a dropped SMB share does. */
function statFailsWith(path: string, code: string, errno: number): StatDev {
  return (p) => {
    if (p !== path) return { dev: 1 };
    throw Object.assign(new Error(`${code}: stat '${p}'`), { code, errno, syscall: 'stat', path: p });
  };
}

function statusOf(storage: Record<string, string>, id: string, stat?: StatDev): string {
  return probeStorage(cfgWith(storage), stat).find((c) => c.id === id)!.status;
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
    expect(statusOf({ series: dir }, 'series', oneDevice)).toBe('looks-unmounted');
  });

  it('accepts a directory on the machine filesystem that has media in it', () => {
    const dir = join(tmpDir(), 'tv');
    mkdirSync(dir);
    writeFileSync(join(dir, 'Frieren S01E01.mkv'), 'video');
    expect(statusOf({ series: dir }, 'series', oneDevice)).toBe('ok');
  });

  it('accepts an empty directory that is its own filesystem, which is the mounted share', () => {
    const dir = join(tmpDir(), 'tv');
    mkdirSync(dir);
    expect(statusOf({ series: dir }, 'series', mountedAt(dir))).toBe('ok');
  });

  // A dead SMB share answers `existsSync` and `access` with yes and then throws ESTALE from
  // every real syscall. Probing it used to escape the map and 500 the whole overview route.
  it('reports a stale mount as unreadable instead of throwing', () => {
    const dir = join(tmpDir(), 'movies');
    mkdirSync(dir);
    const stat = statFailsWith(dir, 'Unknown system error -116', -116);
    const check = probeStorage(cfgWith({ movies: dir }), stat).find((c) => c.id === 'movies')!;
    expect(check.status).toBe('unreadable');
    expect(check.detail).toContain('stale mount');
    expect(check.usage).toBeUndefined();
  });

  it('names the errno when a mount fails for a reason it cannot diagnose', () => {
    const dir = join(tmpDir(), 'movies');
    mkdirSync(dir);
    const check = probeStorage(cfgWith({ movies: dir }), statFailsWith(dir, 'EIO', -5)).find(
      (c) => c.id === 'movies',
    )!;
    expect(check.status).toBe('unreadable');
    expect(check.detail).toContain('EIO');
  });

  it('still calls an absent path missing when the stat itself reports ENOENT', () => {
    const dir = join(tmpDir(), 'movies');
    expect(statusOf({ movies: dir }, 'movies', statFailsWith(dir, 'ENOENT', -2))).toBe('missing');
  });

  it('keeps probing the other roles after one of them fails', () => {
    const bad = join(tmpDir(), 'movies');
    const good = join(tmpDir(), 'tv');
    mkdirSync(bad);
    mkdirSync(good);
    const stat: StatDev = (p) => {
      if (p === bad) throw Object.assign(new Error('boom'), { code: 'ESTALE', errno: -116 });
      return { dev: p === good ? 2 : 1 };
    };
    const checks = probeStorage(cfgWith({ movies: bad, series: good }), stat);
    expect(checks.find((c) => c.id === 'movies')!.status).toBe('unreadable');
    expect(checks.find((c) => c.id === 'series')!.status).toBe('ok');
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
    const first = cachedStorage(cfgWith({ series: dir }), 1_000, oneDevice);
    writeFileSync(join(dir, 'Frieren S01E01.mkv'), 'video');
    const second = cachedStorage(cfgWith({ series: dir }), 5_000, oneDevice);
    expect(second[0].status).toBe(first[0].status);
  });

  it('re-probes after resetStorageCache, so a saved path shows its real status at once', () => {
    resetStorageCache();
    const dir = join(tmpDir(), 'tv');
    mkdirSync(dir);
    expect(cachedStorage(cfgWith({ series: dir }), 1_000, oneDevice)[0].status).toBe('looks-unmounted');
    writeFileSync(join(dir, 'Frieren S01E01.mkv'), 'video');
    resetStorageCache();
    expect(cachedStorage(cfgWith({ series: dir }), 5_000, oneDevice)[0].status).toBe('ok');
  });
});
