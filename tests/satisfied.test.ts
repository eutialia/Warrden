import { describe, it, expect } from 'vitest';
import { anyDropSatisfied, isSatisfiedRejection, seasonSatisfaction } from '../src/pipelines/acquire/satisfied.js';

describe('seasonSatisfaction', () => {
  it('is unknown when the arr attached no statistics at all', () => {
    expect(seasonSatisfaction(undefined)).toBe('unknown');
    expect(seasonSatisfaction(null)).toBe('unknown');
  });

  it('is unknown when the arr reported no file count, so the text fallback may run', () => {
    expect(seasonSatisfaction({ episodeCount: 12, totalEpisodeCount: 12 })).toBe('unknown');
  });

  it('is satisfied when files cover every aired episode', () => {
    expect(seasonSatisfaction({ episodeCount: 12, totalEpisodeCount: 12, episodeFileCount: 12 })).toBe('satisfied');
  });

  it('is satisfied when files exceed the aired count, which happens mid-season after a pack lands', () => {
    expect(seasonSatisfaction({ episodeCount: 6, totalEpisodeCount: 12, episodeFileCount: 12 })).toBe('satisfied');
  });

  it('is unsatisfied when even one aired episode has no file', () => {
    expect(seasonSatisfaction({ episodeCount: 12, totalEpisodeCount: 12, episodeFileCount: 11 })).toBe('unsatisfied');
  });

  it('is unknown for an unaired season, so the existing unaired skip decides instead', () => {
    expect(seasonSatisfaction({ episodeCount: 0, totalEpisodeCount: 12, episodeFileCount: 0 })).toBe('unknown');
  });

  it('is unknown when the counts are present but not numbers', () => {
    expect(seasonSatisfaction({ episodeCount: Number.NaN, totalEpisodeCount: 12, episodeFileCount: 12 })).toBe('unknown');
  });
});

describe('isSatisfiedRejection', () => {
  it('matches the cutoff rejection Sonarr actually sends', () => {
    expect(isSatisfiedRejection('Existing file meets cutoff: SDTV')).toBe(true);
  });

  it('matches when the arr joined several reasons into one line', () => {
    expect(isSatisfiedRejection('Does not contain one of the required terms: Trix, Existing file meets cutoff: SDTV')).toBe(true);
  });

  it('matches the upgrade-refused wording', () => {
    expect(isSatisfiedRejection('Not an upgrade for existing episode file(s)')).toBe(true);
  });

  it('ignores case, because the wording is free text', () => {
    expect(isSatisfiedRejection('EXISTING FILE MEETS CUTOFF: WEBDL-1080p')).toBe(true);
  });

  it('does not match a rejection about the release itself', () => {
    expect(isSatisfiedRejection('Does not contain one of the required terms: Trix')).toBe(false);
    expect(isSatisfiedRejection('seeders 1 below floor 3')).toBe(false);
    expect(isSatisfiedRejection('')).toBe(false);
  });
});

describe('anyDropSatisfied', () => {
  it('is true when at least one drop names an existing file', () => {
    expect(
      anyDropSatisfied([{ reason: 'seeders 1 below floor 3' }, { reason: 'rejected by arr: Existing file meets cutoff: SDTV' }]),
    ).toBe(true);
  });

  it('is false when nothing was dropped', () => {
    expect(anyDropSatisfied([])).toBe(false);
  });

  it('is false when every drop is about the releases, not our library', () => {
    expect(anyDropSatisfied([{ reason: 'seeders 1 below floor 3' }, { reason: 'rejected by arr: Unknown series' }])).toBe(false);
  });
});
