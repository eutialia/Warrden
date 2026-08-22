import { describe, expect, it } from 'vitest';
import {
  buildSearchHints,
  formatSearchHintsForPrompt,
  isFreshGap,
  languageLooksChinese,
  type MissingSeason,
} from '../src/pipelines/subtitle/queries.js';

const DAY = 24 * 3_600_000;

/** A `MissingSeason` with the fields a case does not care about filled in. */
function season(
  seasonNumber: number,
  episodeNumbers: number[],
  extra: Partial<MissingSeason> = {},
): MissingSeason {
  return { seasonNumber, episodeNumbers, newestAiredDaysAgo: null, titles: [], ...extra };
}

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
        season(3, [1, 2, 3], { titles: ['Sword Art Online - Alicization'] }),
        season(1, [1, 2]),
      ],
    });
    expect(h.missingSeasons.map((s) => s.seasonNumber)).toEqual([1, 3]);
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

  it('tells the agent any one target language is enough, and to collect the rest anyway', () => {
    const text = formatSearchHintsForPrompt(buildSearchHints({ title: 'X', languages: ['zh-Hans', 'zh-Hant'] }));
    expect(text).toContain(
      'Target subtitle languages, in order of preference (any one is enough; collect every one you can): zh-Hans, zh-Hant.',
    );
  });

  it('lists the still-missing seasons with their episode counts and per-season titles', () => {
    const text = formatSearchHintsForPrompt(
      buildSearchHints({
        title: 'Sword Art Online',
        languages: ['zh-Hans'],
        missingSeasons: [
          season(1, [1, 2, 3]),
          season(3, [12], { titles: ['Sword Art Online - Alicization'] }),
          season(4, [1, 2, 4, 5], { titles: ['Sword Art Online - Alicization - War of Underworld'] }),
        ],
      }),
    );
    expect(text).toContain(
      'Still missing: Season 1 (episodes 1-3), Season 3 (episode 12, also known as "Sword Art Online - Alicization"), Season 4 (episodes 1-2, 4-5, also known as "Sword Art Online - Alicization - War of Underworld").',
    );
    expect(text).toContain('A pack covering only some of these seasons is still worth downloading');
  });

  it('names the packs already fetched for this title so no round refetches them', () => {
    const text = formatSearchHintsForPrompt(
      buildSearchHints({
        title: 'X',
        languages: ['zh-Hans'],
        alreadyFetched: [{ url: 'https://a.test/s1.zip', title: 'Season 1 pack' }, { url: 'https://a.test/s2.zip' }],
      }),
    );
    expect(text).toContain(
      'Already downloaded for this title (do not fetch these again): "Season 1 pack" https://a.test/s1.zip, https://a.test/s2.zip.',
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
        missingSeasons: [season(2, [7], { titles: ['第二季', 'Second Season'] })],
      }),
    );
    expect(text).toContain('Season 2 (episode 7, also known as "第二季", "Second Season")');
  });
});

describe('formatSearchHintsForPrompt — recency', () => {
  it.each([
    [0, 'newest aired today'],
    [1, 'newest aired 1 day ago'],
    [3, 'newest aired 3 days ago'],
  ])('renders newestAiredDaysAgo %i as "%s"', (days, phrase) => {
    const text = formatSearchHintsForPrompt(
      buildSearchHints({
        title: 'Bleach',
        languages: ['zh-Hans'],
        missingSeasons: [season(17, [41, 42, 43, 44, 45], { newestAiredDaysAgo: days, titles: ['Thousand-Year Blood War'] })],
      }),
    );
    expect(text).toContain(`Still missing: Season 17 (episodes 41-45, ${phrase}, also known as "Thousand-Year Blood War").`);
  });

  it('omits the age when it is unknown', () => {
    const text = formatSearchHintsForPrompt(
      buildSearchHints({ title: 'X', languages: ['en'], missingSeasons: [season(1, [1, 2])] }),
    );
    expect(text).toContain('Still missing: Season 1 (episodes 1-2).');
    expect(text).not.toContain('aired');
  });
});

describe('isFreshGap', () => {
  const now = 1_800_000_000_000;
  const fresh = { airedAt: now - 2 * DAY, covered: false };
  const old = { airedAt: now - 30 * DAY, covered: false };
  const unknown = { airedAt: null, covered: false };

  it.each([
    ['every uncovered episode aired this week', [fresh, { airedAt: now - 6 * DAY, covered: false }], true],
    ['one uncovered episode is older than the window', [fresh, old], false],
    ['an uncovered episode has no air date', [fresh, unknown], false],
    ['the only old episode is already covered', [fresh, { ...old, covered: true }], true],
    ['nothing is uncovered', [{ ...fresh, covered: true }], false],
    ['an episode airs in the future', [{ airedAt: now + DAY, covered: false }], true],
  ])('%s -> %s', (_name, targets, expected) => {
    expect(isFreshGap(targets, now)).toBe(expected);
  });

  it('takes the window in days', () => {
    const targets = [{ airedAt: now - 10 * DAY, covered: false }];
    expect(isFreshGap(targets, now)).toBe(false);
    expect(isFreshGap(targets, now, 14)).toBe(true);
  });
});
