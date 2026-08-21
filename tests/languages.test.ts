import { describe, expect, it } from 'vitest';
import {
  LANGUAGE_TAGS,
  canonicalLanguageTag,
  filterLanguages,
  languageName,
} from '../web/src/lib/languages.js';

describe('LANGUAGE_TAGS', () => {
  it('is BCP-47 primary tags (ISO 639-1) plus the Chinese script variants the design writes on disk', () => {
    expect(LANGUAGE_TAGS).toContain('en');
    expect(LANGUAGE_TAGS).toContain('ja');
    expect(LANGUAGE_TAGS).toContain('zh');
    expect(LANGUAGE_TAGS).toContain('zh-Hans');
    expect(LANGUAGE_TAGS).toContain('zh-Hant');
    expect(LANGUAGE_TAGS).not.toContain('eng');
    expect(LANGUAGE_TAGS).not.toContain('jpn');
    expect(LANGUAGE_TAGS).not.toContain('zho');
    expect(LANGUAGE_TAGS).not.toContain('zh-CN');
    expect(LANGUAGE_TAGS).not.toContain('pt-BR');
    expect(new Set(LANGUAGE_TAGS).size).toBe(LANGUAGE_TAGS.length);
    expect(LANGUAGE_TAGS).toHaveLength(185);
  });

  it('does not accept fansub tokens or free-form strings as catalog members', () => {
    expect(LANGUAGE_TAGS).not.toContain('chs');
    expect(LANGUAGE_TAGS).not.toContain('简体');
    expect(LANGUAGE_TAGS).not.toContain('english');
  });
});

describe('canonicalLanguageTag', () => {
  it.each([
    ['zh-Hans', 'zh-Hans'],
    ['zh-hans', 'zh-Hans'],
    ['ZH-HANT', 'zh-Hant'],
    ['ja', 'ja'],
    ['JA', 'ja'],
    ['en', 'en'],
  ])('maps %s to the catalog tag %s', (input, expected) => {
    expect(canonicalLanguageTag(input)).toBe(expected);
  });

  it.each(['chs', 'zho', 'jpn', 'zh-CN', 'english', '', '  '])('rejects %j', (input) => {
    expect(canonicalLanguageTag(input)).toBeNull();
  });
});

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
    expect(rows.map((r) => r.tag).sort()).toEqual([...LANGUAGE_TAGS].sort());
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
