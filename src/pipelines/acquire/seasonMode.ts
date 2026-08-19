export type SeasonMode = 'unaired' | 'complete' | 'airing' | 'unknown';

export interface SeasonAiringStats {
  episodeCount: number;
  totalEpisodeCount: number;
  nextAiring?: string | null;
}

/**
 * Pack vs weekly is a facts question Sonarr already answered. Missing stats
 * (`unknown`) means "search as we always did" — a fixture or an older payload
 * must not be treated as unaired and skipped.
 */
export function classifySeason(stats: SeasonAiringStats | undefined | null): SeasonMode {
  if (stats == null) return 'unknown';
  if (!Number.isFinite(stats.episodeCount) || !Number.isFinite(stats.totalEpisodeCount)) return 'unknown';
  if (stats.episodeCount === 0) return 'unaired';
  const upcoming = typeof stats.nextAiring === 'string' && stats.nextAiring.length > 0;
  if (stats.episodeCount === stats.totalEpisodeCount && !upcoming) return 'complete';
  return 'airing';
}
