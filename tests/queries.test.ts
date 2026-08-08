import { describe, expect, it } from 'vitest';
import {
  buildSearchHints,
  formatSearchHintsForPrompt,
  languageLooksChinese,
} from '../src/pipelines/subtitle/queries.js';

describe('languageLooksChinese', () => {
  it.each([
    ['zh-Hans', true],
    ['zh-Hant', true],
    ['zh', true],
    ['yue', true],
    ['en', false],
    ['ja', false],
  ])('%s -> %s', (lang, expected) => expect(languageLooksChinese(lang)).toBe(expected));
});

describe('buildSearchHints', () => {
  it('dedupes alternates against the primary title', () => {
    const h = buildSearchHints({
      title: 'Frieren',
      languages: ['zh-Hans'],
      preferredGroups: ['Airota'],
      alternates: ['Frieren', '  葬送的芙莉莲  ', 'Sousou no Frieren'],
    });
    expect(h.title).toBe('Frieren');
    expect(h.alternateQueries).toEqual(['葬送的芙莉莲', 'Sousou no Frieren']);
    expect(h.preferCjkQueries).toBe(true);
    expect(h.preferredGroups).toEqual(['Airota']);
  });

  it('does not set preferCjkQueries for English-only languages', () => {
    const h = buildSearchHints({ title: 'Show', languages: ['en'] });
    expect(h.preferCjkQueries).toBe(false);
  });
});

describe('formatSearchHintsForPrompt', () => {
  it('mentions soft preferred groups and CJK advice when relevant', () => {
    const text = formatSearchHintsForPrompt(
      buildSearchHints({
        title: 'X',
        languages: ['zh-Hans'],
        preferredGroups: ['VCB-Studio'],
        alternates: ['中文名'],
      }),
    );
    expect(text).toContain('zh-Hans');
    expect(text).toContain('VCB-Studio');
    expect(text).toContain('soft');
    expect(text).toContain('中文名');
    expect(text).toMatch(/Chinese/i);
  });
});
