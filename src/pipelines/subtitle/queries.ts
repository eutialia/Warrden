/**
 * Builds the browse-agent search context from the arr title + operator subtitle prefs.
 * Does NOT assume "site UI language = subtitle language" (OpenSubtitles-class indexes are
 * multi-language); instead it biases query advice toward the languages the operator wants
 * on disk and soft-prefers known fansub groups.
 */

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
  };
}

/** Renders the search-hints block for the site-search system/user prompt. */
export function formatSearchHintsForPrompt(hints: SearchHints): string {
  const parts: string[] = [];
  if (hints.languages.length > 0) {
    parts.push(`Target subtitle languages (prefer packs that claim these): ${hints.languages.join(', ')}.`);
  }
  if (hints.preferredGroups.length > 0) {
    parts.push(
      `Preferred fansub/release groups (soft rank boost only — if none of these exist, pick the best other pack): ${hints.preferredGroups.join(', ')}.`,
    );
  }
  if (hints.alternateQueries.length > 0) {
    parts.push(`Also try these search terms if the primary title finds nothing: ${hints.alternateQueries.join(' | ')}.`);
  }
  if (hints.preferCjkQueries) {
    parts.push(
      'Configured languages include Chinese: on CJK fansub indexes, prefer Chinese title forms when you know them; English/romaji often miss results. Multi-language indexes (OpenSubtitles-class) may still list many languages under an English UI — search for the show title, then pick the listing that matches the target languages.',
    );
  }
  return parts.join(' ');
}
