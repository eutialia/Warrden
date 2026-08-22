/**
 * Reading `SxxEyy` back out of a placed file's path.
 *
 * The subtitle pipeline names what it places after the video it sits beside, so the
 * library filename is the only episode identity a `placed_files` row carries. Release
 * numbering inside a pack (`… [04] …`, `… - 21 …`) is deliberately not matched: those
 * numbers belong to the source archive's own ordering, not to the library.
 */
export interface EpisodeCode {
  season: number;
  episode: number;
}

const EPISODE_CODE = /\bS(\d{1,3})E(\d{1,4})\b/i;

export function parseEpisodeCode(path: string): EpisodeCode | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const match = EPISODE_CODE.exec(name);
  if (!match) return null;
  const season = Number(match[1]);
  const episode = Number(match[2]);
  if (!Number.isFinite(season) || !Number.isFinite(episode)) return null;
  return { season, episode };
}

/** Zero-padded, the way the library writes it: `S02E04`. */
export function formatEpisodeCode(code: EpisodeCode): string {
  return `S${pad(code.season)}E${pad(code.episode)}`;
}

export function compareEpisodeCodes(a: EpisodeCode, b: EpisodeCode): number {
  return a.season - b.season || a.episode - b.episode;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
