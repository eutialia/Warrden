import { describe, it, expect } from 'vitest';
import { classifySeason } from '../src/pipelines/acquire/seasonMode.js';

describe('classifySeason', () => {
  it('is unknown when Sonarr did not attach season statistics, so a fixture or older payload still gets searched', () => {
    expect(classifySeason(undefined)).toBe('unknown');
    expect(classifySeason(null)).toBe('unknown');
  });

  it('is unaired when nothing in the season has aired yet', () => {
    expect(classifySeason({ episodeCount: 0, totalEpisodeCount: 1, nextAiring: '2026-10-01T14:45:00Z' })).toBe('unaired');
    expect(classifySeason({ episodeCount: 0, totalEpisodeCount: 0 })).toBe('unaired');
  });

  it('is complete when every listed episode has aired and nothing is scheduled next', () => {
    expect(classifySeason({ episodeCount: 14, totalEpisodeCount: 14 })).toBe('complete');
    expect(classifySeason({ episodeCount: 14, totalEpisodeCount: 14, nextAiring: null })).toBe('complete');
  });

  it('is airing when some episodes remain or a next airing is scheduled', () => {
    expect(classifySeason({ episodeCount: 5, totalEpisodeCount: 14 })).toBe('airing');
    expect(classifySeason({ episodeCount: 14, totalEpisodeCount: 14, nextAiring: '2026-08-20T14:45:00Z' })).toBe('airing');
  });

  it('is unknown when a stats object is present but the counts are not numbers', () => {
    expect(classifySeason({} as { episodeCount: number; totalEpisodeCount: number })).toBe('unknown');
    expect(classifySeason({ episodeCount: Number.NaN, totalEpisodeCount: 14 })).toBe('unknown');
  });
});
