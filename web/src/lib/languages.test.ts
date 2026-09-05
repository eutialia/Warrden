import { describe, expect, it } from 'vitest';
import { CATALOG } from '@/lib/languages.catalog';
import { filterLanguages, languageName } from '@/lib/languages';

describe('languageName', () => {
  it('names a tag the way a person would search for it', () => {
    expect(languageName('zh-Hans')).toBe('Simplified Chinese');
    expect(languageName('zh-Hant')).toBe('Traditional Chinese');
    expect(languageName('ja')).toBe('Japanese');
    expect(languageName('aa')).toBe('Afar');
    expect(languageName('tw')).toBe('Twi');
  });

  it('falls back to the raw tag when it is not in the catalog', () => {
    expect(languageName('not-a-tag')).toBe('not-a-tag');
  });
});

describe('filterLanguages', () => {
  it('returns the full catalog, ordered by English name, when the query is empty', () => {
    const rows = filterLanguages('');
    expect(rows.map((r) => r.tag).sort()).toEqual(CATALOG.map((row) => row.tag).sort());
    const names = rows.map((r) => r.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('matches the BCP-47 tag and the English name', () => {
    expect(filterLanguages('zh-Hans').map((r) => r.tag)).toEqual(['zh-Hans']);
    expect(filterLanguages('simplified').map((r) => r.tag)).toContain('zh-Hans');
    expect(filterLanguages('Japanese').map((r) => r.tag)).toContain('ja');
  });

  it('omits tags already selected', () => {
    expect(filterLanguages('Japanese', { exclude: ['ja'] })).toEqual([]);
    expect(filterLanguages('', { exclude: ['zh-Hans'] }).map((r) => r.tag)).not.toContain('zh-Hans');
  });
});
