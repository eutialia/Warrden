import { describe, expect, it } from 'vitest';
import { describeEpisodeRanges } from '../src/pipelines/subtitle/episodeRanges.js';

describe('describeEpisodeRanges', () => {
  it.each([
    ['nothing', [], ''],
    ['a single episode', [[1, 5]], 'S1E5'],
    ['a run of three', [[1, 1], [1, 2], [1, 3]], 'S1E1-E3'],
    ['a pair', [[1, 1], [1, 2]], 'S1E1-E2'],
    ['two runs in one season', [[1, 1], [1, 2], [1, 3], [1, 7], [1, 8]], 'S1E1-E3, S1E7-E8'],
    ['isolated episodes', [[2, 4], [2, 12], [2, 21]], 'S2E4, S2E12, S2E21'],
    [
      'mixed seasons',
      [[2, 4], [2, 12], [3, 1], [3, 2], [3, 3], [4, 1]],
      'S2E4, S2E12, S3E1-E3, S4E1',
    ],
    ['unsorted input', [[3, 2], [1, 9], [3, 1]], 'S1E9, S3E1-E2'],
    ['duplicates collapsed', [[1, 1], [1, 1], [1, 2]], 'S1E1-E2'],
  ])('%s', (_label, pairs, expected) => {
    const episodes = (pairs as number[][]).map(([seasonNumber, episodeNumber]) => ({
      seasonNumber: seasonNumber!,
      episodeNumber: episodeNumber!,
    }));
    expect(describeEpisodeRanges(episodes)).toBe(expected);
  });

  it('does not join across a season boundary even when the numbers are consecutive', () => {
    expect(
      describeEpisodeRanges([
        { seasonNumber: 1, episodeNumber: 12 },
        { seasonNumber: 2, episodeNumber: 13 },
      ]),
    ).toBe('S1E12, S2E13');
  });
});
