/**
 * Builds the browse-agent search context from the arr title + operator subtitle prefs.
 * Does NOT assume "site UI language = subtitle language" (OpenSubtitles-class indexes are
 * multi-language); instead it biases query advice toward the languages the operator wants
 * on disk and soft-prefers known fansub groups.
 */
import { describeEpisodeNumbers } from './episodeRanges.js';

/** One season the target still needs subtitles for, with the titles that season is
 * released under (Sonarr's scene-season alternates) — a multi-cour show is sold as a
 * separate title per season on most fansub indexes, so "still missing season 3" is only
 * actionable with season 3's own name beside it. */
export interface MissingSeason {
  seasonNumber: number;
  /** Which episodes of this season are still missing, ascending. */
  episodeNumbers: number[];
  /** Days since the most recently aired uncovered episode of this season; null when no
   * episode of it carries an air date. A season whose newest gap aired days ago is one no
   * index has had time to publish for, and the agent is told so. */
  newestAiredDaysAgo: number | null;
  /** Titles this season is known by, beyond the series title. */
  titles: string[];
}

/** One pack this library already holds for the target: pulled earlier in this job, or by a
 * run that cached it. Named in the prompt so the agent spends its steps on something new
 * instead of re-fetching what is already on disk. */
export interface FetchedPack {
  url: string;
  /** The pack's own name, when the URL carries one worth showing. */
  title?: string;
}

export interface SearchHints {
  /** Primary title (arr canonical). Always the first query the agent should try. */
  title: string;
  /** Extra title forms to try (arr alternates, romanization, …) — no duplicates of `title`. */
  alternateQueries: string[];
  /** Configured target languages (e.g. zh-Hans). */
  languages: string[];
  /** Soft-prefer fansub groups; never exclusive. */
  preferredGroups: string[];
  /** True when any language looks Chinese — agent should prefer CJK title forms when known. */
  preferCjkQueries: boolean;
  /** Seasons still uncovered when this search starts, lowest first. Empty for a movie. */
  missingSeasons: MissingSeason[];
  /** Packs the target already has, from this job's earlier rounds and from the archive
   * cache. Empty only when nothing has ever been fetched for this target. */
  alreadyFetched: FetchedPack[];
}

/** Primary-subtag check: zh, zh-Hans, zh-Hant, yue, … */
export function languageLooksChinese(lang: string): boolean {
  const primary = lang.toLowerCase().split('-')[0] ?? '';
  return primary === 'zh' || primary === 'yue' || primary === 'cmn';
}

/**
 * Pure builder. `alternates` is whatever the caller already knows (arr alternate titles);
 * this module does not invent Chinese titles without evidence — that stays the model's job
 * when `preferCjkQueries` is set.
 */
export function buildSearchHints(input: {
  title: string;
  languages: string[];
  preferredGroups?: string[];
  alternates?: string[];
  missingSeasons?: MissingSeason[];
  alreadyFetched?: FetchedPack[];
}): SearchHints {
  const title = input.title.trim();
  const seen = new Set<string>([title.toLowerCase()]);
  const alternateQueries: string[] = [];
  for (const raw of input.alternates ?? []) {
    const t = raw.trim();
    if (t.length === 0) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    alternateQueries.push(t);
  }
  const languages = input.languages.map((l) => l.trim()).filter(Boolean);
  const preferredGroups = (input.preferredGroups ?? []).map((g) => g.trim()).filter(Boolean);
  return {
    title,
    alternateQueries,
    languages,
    preferredGroups,
    preferCjkQueries: languages.some(languageLooksChinese),
    missingSeasons: [...(input.missingSeasons ?? [])].sort((a, b) => a.seasonNumber - b.seasonNumber),
    alreadyFetched: [...(input.alreadyFetched ?? [])],
  };
}

/** `newest aired 3 days ago` — the whole phrase, ready to sit beside the episode numbers. */
function describeAge(days: number): string {
  if (days <= 0) return 'newest aired today';
  return `newest aired ${days} day${days === 1 ? '' : 's'} ago`;
}

/** `Season 17 (episodes 41-45, newest aired 3 days ago, also known as "…")` — the gap's own
 * episode numbers, how fresh the newest of them is, and the season's own titles, which ride
 * along so the agent can search for the season under the name the indexes actually use. */
function describeMissingSeason(s: MissingSeason): string {
  const parts = [
    s.episodeNumbers.length > 0
      ? `episode${s.episodeNumbers.length === 1 ? '' : 's'} ${describeEpisodeNumbers(s.episodeNumbers)}`
      : '',
    s.newestAiredDaysAgo !== null ? describeAge(s.newestAiredDaysAgo) : '',
    s.titles.length > 0 ? `also known as ${s.titles.map((t) => `"${t}"`).join(', ')}` : '',
  ].filter(Boolean);
  return parts.length === 0 ? `Season ${s.seasonNumber}` : `Season ${s.seasonNumber} (${parts.join(', ')})`;
}

/** What `isFreshGap` needs of a target: when it aired, and whether it still needs anything. */
export interface FreshnessTarget {
  /** Epoch ms the episode aired, or null when the arr does not say (and for movies). */
  airedAt: number | null;
  covered: boolean;
}

/**
 * How long since it aired an episode counts as fresh. Inside this window an index has
 * usually published nothing at all, so an empty search says something about the calendar
 * rather than about the site. The one source for the gate, the prompt rule that tells the
 * agent about it, and the event that says the pass was scoped down.
 */
export const FRESH_DAYS = 7;

/**
 * True when every episode this run is still hunting for aired inside the last `freshDays` —
 * the "nothing exists yet" case. Subtitles for an episode that aired this week usually have
 * not been published at all, so a search that comes up empty is evidence about the calendar,
 * not about the site, and the run spends a fraction of its budget rather than three full
 * rounds per site.
 *
 * An unknown air date counts as not fresh: the expensive path is the safe default, and the
 * only thing a missing date proves is that we cannot tell. A run with nothing uncovered is
 * not a fresh gap either — it is not a gap at all.
 */
export function isFreshGap(targets: readonly FreshnessTarget[], now: number, freshDays = FRESH_DAYS): boolean {
  const uncovered = targets.filter((t) => !t.covered);
  if (uncovered.length === 0) return false;
  const cutoff = now - freshDays * 24 * 3_600_000;
  return uncovered.every((t) => t.airedAt !== null && t.airedAt >= cutoff);
}

/** Renders the search-hints block for the site-search system/user prompt. */
export function formatSearchHintsForPrompt(hints: SearchHints): string {
  const parts: string[] = [];
  if (hints.languages.length > 0) {
    parts.push(
      `Target subtitle languages, in order of preference (any one is enough; collect every one you can): ${hints.languages.join(', ')}.`,
    );
  }
  if (hints.preferredGroups.length > 0) {
    parts.push(
      `Preferred fansub/release groups (soft rank boost only — if none of these exist, pick the best other pack): ${hints.preferredGroups.join(', ')}.`,
    );
  }
  if (hints.alternateQueries.length > 0) {
    parts.push(`Also try these search terms if the primary title finds nothing: ${hints.alternateQueries.join(' | ')}.`);
  }
  if (hints.missingSeasons.length > 0) {
    parts.push(`Still missing: ${hints.missingSeasons.map(describeMissingSeason).join(', ')}.`);
    parts.push(
      'A pack covering only some of these seasons is still worth downloading; after it, keep searching for the remaining seasons under their own titles.',
    );
  }
  if (hints.alreadyFetched.length > 0) {
    const packs = hints.alreadyFetched.map((p) => (p.title ? `"${p.title}" ${p.url}` : p.url));
    parts.push(`Already downloaded for this title (do not fetch these again): ${packs.join(', ')}.`);
  }
  if (hints.preferCjkQueries) {
    parts.push(
      'Configured languages include Chinese: on CJK fansub indexes, prefer Chinese title forms when you know them; English/romaji often miss results. Multi-language indexes (OpenSubtitles-class) may still list many languages under an English UI — search for the show title, then pick the listing that matches the target languages.',
    );
  }
  return parts.join(' ');
}
