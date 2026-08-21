import type { Config } from './schema.js';

/**
 * The four libraries Warrden works with. Their paths come from `config.storage` and are
 * editable from Settings, because where the media lives depends on how Warrden was
 * deployed: bind mounts under Docker, NFS paths in an LXC, your own mounts when it runs
 * directly on your machine.
 */
export type StorageRoleId = 'series' | 'anime' | 'movies' | 'downloads';

export interface StorageRole {
  id: StorageRoleId;
  /** Human label for the dashboard. */
  label: string;
  /** Absolute path, or '' when the operator does not have this library. */
  path: string;
  configured: boolean;
}

/** Stable order used by the health probe, the mount gate, and the Settings card. */
export const STORAGE_ROLE_IDS: readonly StorageRoleId[] = ['series', 'anime', 'movies', 'downloads'] as const;

const LABELS: Record<StorageRoleId, string> = {
  series: 'Series',
  anime: 'Anime',
  movies: 'Movies',
  downloads: 'Downloads',
};

export function storageRoles(config: Config): StorageRole[] {
  return STORAGE_ROLE_IDS.map((id) => {
    const path = config.storage[id].trim();
    return { id, label: LABELS[id], path, configured: path.length > 0 };
  });
}

/** The paths that must be present before a pipeline touches the filesystem. A disabled
 * role contributes nothing: there is no share to be missing. */
export function configuredStoragePaths(config: Config): string[] {
  return storageRoles(config)
    .filter((role) => role.configured)
    .map((role) => role.path);
}

export function downloadsPath(config: Config): string | null {
  const path = config.storage.downloads.trim();
  return path.length > 0 ? path : null;
}

function normalizePath(p: string): string {
  return p.replace(/\/+$/, '') || '/';
}

/**
 * Arr-side download roots, used to scope torrent folders from import history. These are
 * paths as the arr sees them, which is why they come from `pathMappings` rather than from
 * `storage` directly.
 *
 * A mapping whose target is the Downloads path wins. With no such mapping, the arr and
 * Warrden see the same path, so the Downloads path is its own root. With Downloads
 * disabled there are no roots at all.
 */
export function effectiveDownloadRoots(config: Config): string[] {
  const downloads = downloadsPath(config);
  if (!downloads) return [];

  const target = normalizePath(downloads);
  const fromMappings = config.pathMappings
    .filter((m) => normalizePath(m.to) === target)
    .map((m) => m.from)
    .filter((from) => from.length > 0);

  if (fromMappings.length > 0) return [...new Set(fromMappings)];
  return [downloads];
}
