import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isMountPoint, probeStorage } from '../src/server/storageHealth.js';
import { tmpDir } from './helpers.js';

const ENV_KEYS = [
  'WARRDEN_MOUNT_SERIES',
  'WARRDEN_MOUNT_ANIME',
  'WARRDEN_MOUNT_MOVIES',
  'WARRDEN_MOUNT_DOWNLOADS',
] as const;

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

describe('isMountPoint / probeStorage', () => {
  it('a normal subdirectory on the same filesystem is not a mount point', () => {
    const root = tmpDir();
    const child = join(root, 'tv');
    mkdirSync(child);
    expect(isMountPoint(child)).toBe(false);
  });

  it('probeStorage reports not-mounted for empty local dirs that are not bind mounts', () => {
    const root = tmpDir();
    const series = join(root, 'tv');
    const anime = join(root, 'anime');
    const movies = join(root, 'movies');
    const downloads = join(root, 'downloads');
    for (const p of [series, anime, movies, downloads]) mkdirSync(p);

    process.env.WARRDEN_MOUNT_SERIES = series;
    process.env.WARRDEN_MOUNT_ANIME = anime;
    process.env.WARRDEN_MOUNT_MOVIES = movies;
    process.env.WARRDEN_MOUNT_DOWNLOADS = downloads;
    try {
      const checks = probeStorage();
      const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
      expect(byId.series?.status).toBe('not-mounted');
      expect(byId.anime?.status).toBe('not-mounted');
      expect(byId.movies?.status).toBe('not-mounted');
      expect(byId.downloads?.status).toBe('not-mounted');
      expect(byId.series?.detail).toMatch(/bind mount/i);
      // `download-root` is a retired id no probe may resurrect. Widened to `string[]`
      // because it no longer exists in `StandardMountId` — comparing it directly is a
      // type error, which is exactly the point of the assertion.
      const ids: string[] = checks.map((c) => c.id);
      expect(ids).not.toContain('download-root');
    } finally {
      clearEnv();
    }
  });

  it('probeStorage reports missing when the path does not exist', () => {
    process.env.WARRDEN_MOUNT_SERIES = '/no/such/warrden/series/mount';
    process.env.WARRDEN_MOUNT_ANIME = '/no/such/warrden/anime/mount';
    process.env.WARRDEN_MOUNT_MOVIES = '/no/such/warrden/movies/mount';
    process.env.WARRDEN_MOUNT_DOWNLOADS = '/no/such/warrden/downloads/mount';
    try {
      const checks = probeStorage();
      expect(checks.every((c) => c.status === 'missing')).toBe(true);
      expect(checks.some((c) => c.id === 'anime')).toBe(true);
    } finally {
      clearEnv();
    }
  });
});
