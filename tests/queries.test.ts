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

  it('defaults missingSeasons to an empty list', () => {
    expect(buildSearchHints({ title: 'Show', languages: ['en'] }).missingSeasons).toEqual([]);
  });

  it('defaults alreadyFetched to an empty list and carries it through when given', () => {
    expect(buildSearchHints({ title: 'Show', languages: ['en'] }).alreadyFetched).toEqual([]);
    const h = buildSearchHints({
      title: 'Show',
      languages: ['en'],
      alreadyFetched: [{ url: 'https://a.test/pack.zip', title: 'Season 1 pack' }],
    });
    expect(h.alreadyFetched).toEqual([{ url: 'https://a.test/pack.zip', title: 'Season 1 pack' }]);
  });

  it('keeps missingSeasons sorted by season with their per-season titles', () => {
    const h = buildSearchHints({
      title: 'Sword Art Online',
      languages: ['zh-Hans'],
      missingSeasons: [
        { seasonNumber: 3, episodes: 24, titles: ['Sword Art Online - Alicization'] },
        { seasonNumber: 1, episodes: 25, titles: [] },
      ],
    });
    expect(h.missingSeasons).toEqual([
      { seasonNumber: 1, episodes: 25, titles: [] },
      { seasonNumber: 3, episodes: 24, titles: ['Sword Art Online - Alicization'] },
    ]);
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

  it('lists the still-missing seasons with their episode counts and per-season titles', () => {
    const text = formatSearchHintsForPrompt(
      buildSearchHints({
        title: 'Sword Art Online',
        languages: ['zh-Hans'],
        missingSeasons: [
          { seasonNumber: 1, episodes: 25, titles: [] },
          { seasonNumber: 3, episodes: 24, titles: ['Sword Art Online - Alicization'] },
          { seasonNumber: 4, episodes: 23, titles: ['Sword Art Online - Alicization - War of Underworld'] },
        ],
      }),
    );
    expect(text).toContain(
      'Still missing: Season 1 (25 episodes), Season 3 (24 episodes, also known as "Sword Art Online - Alicization"), Season 4 (23 episodes, also known as "Sword Art Online - Alicization - War of Underworld").',
    );
    expect(text).toContain('A pack covering only some of these seasons is still worth downloading');
  });

  it('names the packs this run already fetched so a later round does not refetch them', () => {
    const text = formatSearchHintsForPrompt(
      buildSearchHints({
        title: 'X',
        languages: ['zh-Hans'],
        alreadyFetched: [{ url: 'https://a.test/s1.zip', title: 'Season 1 pack' }, { url: 'https://a.test/s2.zip' }],
      }),
    );
    expect(text).toContain(
      'Already downloaded this run (do not fetch these again): "Season 1 pack" https://a.test/s1.zip, https://a.test/s2.zip.',
    );
  });

  it('says nothing about already-fetched packs when none were passed', () => {
    const text = formatSearchHintsForPrompt(buildSearchHints({ title: 'X', languages: ['en'] }));
    expect(text).not.toContain('Already downloaded');
  });

  it('says nothing about seasons when none were passed', () => {
    const text = formatSearchHintsForPrompt(buildSearchHints({ title: 'X', languages: ['en'] }));
    expect(text).not.toContain('Still missing');
  });

  it('uses the singular for a one-episode season and joins several titles for one season', () => {
    const text = formatSearchHintsForPrompt(
      buildSearchHints({
        title: 'X',
        languages: ['en'],
        missingSeasons: [{ seasonNumber: 2, episodes: 1, titles: ['第二季', 'Second Season'] }],
      }),
    );
    expect(text).toContain('Season 2 (1 episode, also known as "第二季", "Second Season")');
  });
});
