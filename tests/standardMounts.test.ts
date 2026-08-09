import { afterEach, describe, expect, it } from 'vitest';
import {
  downloadsMountPath,
  effectiveDownloadRoots,
  effectiveMountMarkers,
  standardMountPaths,
  standardMounts,
} from '../src/config/standardMounts.js';
import { ConfigSchema } from '../src/config/schema.js';

const ENV_KEYS = [
  'WARRDEN_MOUNT_SERIES',
  'WARRDEN_MOUNT_ANIME',
  'WARRDEN_MOUNT_MOVIES',
  'WARRDEN_MOUNT_DOWNLOADS',
] as const;

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

function cfg(partial: Record<string, unknown> = {}) {
  return ConfigSchema.parse(partial);
}

describe('standardMounts', () => {
  it('defaults to /tv, /anime, /movies, /downloads', () => {
    expect(standardMountPaths()).toEqual(['/tv', '/anime', '/movies', '/downloads']);
    expect(standardMounts().map((m) => m.label)).toEqual(['Series', 'Anime', 'Movies', 'Downloads']);
    expect(downloadsMountPath()).toBe('/downloads');
  });

  it('honors env overrides', () => {
    process.env.WARRDEN_MOUNT_SERIES = '/data/tv';
    process.env.WARRDEN_MOUNT_ANIME = '/data/anime';
    process.env.WARRDEN_MOUNT_MOVIES = '/data/movies';
    process.env.WARRDEN_MOUNT_DOWNLOADS = '/data/dl';
    expect(standardMountPaths()).toEqual(['/data/tv', '/data/anime', '/data/movies', '/data/dl']);
  });

  it('effectiveMountMarkers uses standard paths when config is empty', () => {
    expect(effectiveMountMarkers(cfg())).toEqual(['/tv', '/anime', '/movies', '/downloads']);
  });

  it('effectiveMountMarkers keeps non-empty config as a test override', () => {
    const c = cfg({ ingest: { mountMarkers: ['/tmp/marker'] } });
    expect(effectiveMountMarkers(c)).toEqual(['/tmp/marker']);
  });

  it('effectiveDownloadRoots defaults to the downloads mount', () => {
    expect(effectiveDownloadRoots(cfg())).toEqual(['/downloads']);
  });

  it('effectiveDownloadRoots derives arr-side path from pathMappings to /downloads', () => {
    const c = cfg({
      pathMappings: [{ from: '/mnt/nas/Downloads', to: '/downloads' }],
    });
    expect(effectiveDownloadRoots(c)).toEqual(['/mnt/nas/Downloads']);
  });

  it('effectiveDownloadRoots prefers legacy config.downloadRoots when set', () => {
    const c = cfg({
      ingest: { downloadRoots: ['/legacy/dl'] },
      pathMappings: [{ from: '/mnt/nas/Downloads', to: '/downloads' }],
    });
    expect(effectiveDownloadRoots(c)).toEqual(['/legacy/dl']);
  });
});
