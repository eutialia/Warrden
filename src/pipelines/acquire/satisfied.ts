/** Whether the target already holds what a search would go looking for. */
export type Satisfaction = 'satisfied' | 'unsatisfied' | 'unknown';

/** The subset of Sonarr's season statistics that answers "do we already have this".
 * `episodeFileCount` is optional because older payloads and fixtures omit it. */
export interface SeasonFileStats {
  episodeCount: number;
  totalEpisodeCount: number;
  episodeFileCount?: number;
}

/**
 * Measures files on disk against episodes that have aired, not against the season's
 * full length: a half-aired season with every aired episode on disk is satisfied, and
 * searching it again only turns up releases the arr will refuse.
 *
 * `unknown` is a real answer, not a failure. It means the arr told us nothing about
 * files, so the caller should fall back to reading rejection text rather than assume
 * either way. An unaired season is also `unknown` here, so the existing unaired skip
 * keeps deciding that case on its own terms.
 */
export function seasonSatisfaction(stats: SeasonFileStats | undefined | null): Satisfaction {
  if (stats == null) return 'unknown';
  const { episodeCount, episodeFileCount } = stats;
  if (episodeFileCount === undefined || !Number.isFinite(episodeFileCount)) return 'unknown';
  if (!Number.isFinite(episodeCount) || episodeCount <= 0) return 'unknown';
  return episodeFileCount >= episodeCount ? 'satisfied' : 'unsatisfied';
}

/**
 * Rejection phrases that describe OUR library rather than the candidate. The arr sends
 * these as free text and joins several into one line, so this matches on substrings.
 *
 * Brittle on purpose and by necessity: there is no structured field for it. A wording
 * change upstream silently stops this matching, which is why it is only ever consulted
 * when `seasonSatisfaction` came back `unknown` and never on its own.
 */
const SATISFIED_PHRASES = ['existing file meets cutoff', 'not an upgrade for existing'];

export function isSatisfiedRejection(reason: string): boolean {
  const lower = reason.toLowerCase();
  return SATISFIED_PHRASES.some((phrase) => lower.includes(phrase));
}

/** True when the arr refused at least one candidate because we already hold the content. */
export function anyDropSatisfied(dropped: { reason: string }[]): boolean {
  return dropped.some((d) => isSatisfiedRejection(d.reason));
}
