import { CATALOG } from './languages.catalog.js';

const NAME_BY_TAG = new Map(CATALOG.map((row) => [row.tag, row.name]));
const CANONICAL_BY_LOWER = new Map(CATALOG.map((row) => [row.tag.toLowerCase(), row.tag]));

const displayNames = new Intl.DisplayNames(['en'], { type: 'language' });

export function languageName(tag: string): string {
  const canonical = CANONICAL_BY_LOWER.get(tag.trim().toLowerCase());
  if (canonical) return NAME_BY_TAG.get(canonical) ?? canonical;
  try {
    return displayNames.of(tag) ?? tag;
  } catch {
    return tag;
  }
}

export interface LanguageOption {
  tag: string;
  name: string;
}

const ALL_OPTIONS: LanguageOption[] = CATALOG.map((row) => ({ tag: row.tag, name: row.name })).sort(
  (a, b) => a.name.localeCompare(b.name) || a.tag.localeCompare(b.tag),
);

export function filterLanguages(
  query: string,
  opts?: { exclude?: readonly string[] },
): LanguageOption[] {
  const exclude = new Set((opts?.exclude ?? []).map((tag) => tag.toLowerCase()));
  const needle = query.trim().toLowerCase();
  return ALL_OPTIONS.filter((row) => {
    if (exclude.has(row.tag.toLowerCase())) return false;
    if (needle === '') return true;
    return row.tag.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle);
  });
}
