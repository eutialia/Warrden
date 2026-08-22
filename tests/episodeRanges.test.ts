import { describe, expect, it } from 'vitest';
import { describeEpisodeNumbers, describeEpisodeRanges } from '../src/pipelines/subtitle/episodeRanges.js';

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

  it.each([
    // Eight groups is the cap, so eight render in full with nothing appended.
    [8, 'S1E1, S1E3, S1E5, S1E7, S1E9, S1E11, S1E13, S1E15'],
    // The ninth group and everything after it collapse into a count of the episodes lost.
    [9, 'S1E1, S1E3, S1E5, S1E7, S1E9, S1E11, S1E13, S1E15, +1 more episodes'],
    [12, 'S1E1, S1E3, S1E5, S1E7, S1E9, S1E11, S1E13, S1E15, +4 more episodes'],
  ])('%i isolated episodes -> at most eight groups', (count, expected) => {
    const episodes = Array.from({ length: count }, (_, i) => ({ seasonNumber: 1, episodeNumber: i * 2 + 1 }));
    expect(describeEpisodeRanges(episodes)).toBe(expected);
  });

  it('counts every episode behind the cap, not every group', () => {
    // Nine groups: eight singles, then a run of five that must count as five episodes.
    const episodes = [
      ...Array.from({ length: 8 }, (_, i) => ({ seasonNumber: 1, episodeNumber: i * 2 + 1 })),
      ...Array.from({ length: 5 }, (_, i) => ({ seasonNumber: 2, episodeNumber: i + 1 })),
    ];
    expect(describeEpisodeRanges(episodes)).toBe(
      'S1E1, S1E3, S1E5, S1E7, S1E9, S1E11, S1E13, S1E15, +5 more episodes',
    );
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

describe('describeEpisodeNumbers', () => {
  it.each([
    [[], ''],
    [[41, 42, 43, 44, 45], '41-45'],
    [[1, 2, 4, 5], '1-2, 4-5'],
    [[5, 1, 2, 2], '1-2, 5'],
  ])('renders %j as "%s"', (numbers, expected) => {
    expect(describeEpisodeNumbers(numbers)).toBe(expected);
  });

  // Same cap as describeEpisodeRanges, and for the same reason: a season with 40 scattered
  // gaps is a paragraph nobody reads, and this one goes into a prompt paid for per token.
  it('collapses the tail past the group cap, counting episodes', () => {
    const scattered = Array.from({ length: 9 }, (_, i) => i * 2 + 1);
    expect(describeEpisodeNumbers(scattered)).toBe('1, 3, 5, 7, 9, 11, 13, 15, +1 more episodes');
  });
});
