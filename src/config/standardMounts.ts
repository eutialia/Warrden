import type { Config } from './schema.js';

/**
 * The four filesystem mounts Warrden supports. Bind these into the container at create
 * time — they are not editable from the web UI.
 *
 *   Series    /tv         Sonarr "Series" root folder
 *   Anime     /anime      Sonarr "Anime" root folder
 *   Movies    /movies     Radarr library root
 *   Downloads /downloads  Torrent client completed/download root
 *
 * Override paths only via env (dev / odd host layouts), never via Settings:
 *   WARRDEN_MOUNT_SERIES, WARRDEN_MOUNT_ANIME, WARRDEN_MOUNT_MOVIES, WARRDEN_MOUNT_DOWNLOADS
 */
export type StandardMountId = 'series' | 'anime' | 'movies' | 'downloads';

export interface StandardMount {
  id: StandardMountId;
  /** Human label for the dashboard. */
  label: string;
  /** Absolute path inside the Warrden process (container-local). */
  path: string;
}

/** Stable order used by health probes, mount gates, and the Settings table. */
export const STANDARD_MOUNT_IDS: readonly StandardMountId[] = ['series', 'anime', 'movies', 'downloads'] as const;

const DEFAULT_PATHS: Record<StandardMountId, string> = {
  series: '/tv',
  anime: '/anime',
  movies: '/movies',
  downloads: '/downloads',
};

const ENV_KEYS: Record<StandardMountId, string> = {
  series: 'WARRDEN_MOUNT_SERIES',
  anime: 'WARRDEN_MOUNT_ANIME',
  movies: 'WARRDEN_MOUNT_MOVIES',
  downloads: 'WARRDEN_MOUNT_DOWNLOADS',
};

const LABELS: Record<StandardMountId, string> = {
  series: 'Series',
  anime: 'Anime',
  movies: 'Movies',
  downloads: 'Downloads',
};

function envPath(id: StandardMountId): string {
  const raw = process.env[ENV_KEYS[id]]?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_PATHS[id];
}

/** Current effective standard mounts (env overrides applied). */
export function standardMounts(): StandardMount[] {
  return STANDARD_MOUNT_IDS.map((id) => ({
    id,
    label: LABELS[id],
    path: envPath(id),
  }));
}

export function standardMountPaths(): string[] {
  return standardMounts().map((m) => m.path);
}

export function downloadsMountPath(): string {
  return envPath('downloads');
}

function normalizePath(p: string): string {
  return p.replace(/\/+$/, '') || '/';
}

/**
 * Paths that must exist before ingest/subtitle touch the filesystem.
 *
 * Always the four standard mounts. A non-empty `config.ingest.mountMarkers` is kept as a
 * **test-only** override (the web UI never writes it); production configs should leave it
 * empty so Series/Anime/Movies/Downloads are enforced.
 */
export function effectiveMountMarkers(config: Config): string[] {
  if (config.ingest.mountMarkers.length > 0) return config.ingest.mountMarkers;
  return standardMountPaths();
}

/**
 * Arr-side download roots used to scope torrent folders from import history.
 *
 * Order of preference:
 *  1. Legacy/test `config.ingest.downloadRoots` when non-empty
 *  2. `pathMappings[].from` whose `to` is the standard Downloads mount
 *  3. The standard Downloads path itself (arr and Warrden share the same path)
 */
export function effectiveDownloadRoots(config: Config): string[] {
  if (config.ingest.downloadRoots.length > 0) return config.ingest.downloadRoots;

  const downloadsLocal = normalizePath(downloadsMountPath());
  const fromMappings = config.pathMappings
    .filter((m) => normalizePath(m.to) === downloadsLocal)
    .map((m) => m.from)
    .filter((from) => from.length > 0);

  if (fromMappings.length > 0) return [...new Set(fromMappings)];
  return [downloadsMountPath()];
}
