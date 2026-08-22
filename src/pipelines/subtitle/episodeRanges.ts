/** One episode in a rollup, identified the way a human reads it: season plus episode. */
export interface EpisodeRef {
  seasonNumber: number;
  episodeNumber: number;
}

/**
 * Renders a set of episodes as the compact list an operator can scan: sorted, deduped, and
 * with consecutive episodes inside one season collapsed into a range —
 * `S2E4, S2E12, S3E1-E24, S4E1-E23`. A season boundary always breaks a run, so S1E12 and
 * S2E13 never join. Empty input renders as the empty string.
 */
export function describeEpisodeRanges(episodes: EpisodeRef[]): string {
  const sorted = [...episodes].sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
  const groups: { season: number; from: number; to: number }[] = [];
  for (const e of sorted) {
    const last = groups[groups.length - 1];
    if (last && last.season === e.seasonNumber && e.episodeNumber - last.to <= 1) {
      last.to = Math.max(last.to, e.episodeNumber);
      continue;
    }
    groups.push({ season: e.seasonNumber, from: e.episodeNumber, to: e.episodeNumber });
  }
  return groups.map((g) => (g.from === g.to ? `S${g.season}E${g.from}` : `S${g.season}E${g.from}-E${g.to}`)).join(', ');
}
