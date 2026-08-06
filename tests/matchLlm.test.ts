import { describe, it, expect } from 'vitest';
import { matchSidecarsWithLlm } from '../src/pipelines/ingest/matchLlm.js';
import { episodeResource, FakeGenerator } from './helpers.js';

const seriesTitle = 'Frieren';

describe('matchSidecarsWithLlm', () => {
  it("maps the LLM's assignments back to files positionally, regardless of the order it answers in", async () => {
    const episodes = [episodeResource({ id: 10, episodeNumber: 1 }), episodeResource({ id: 11, episodeNumber: 2 })];
    const llm = new FakeGenerator([
      {
        assignments: [
          { file: 2, episodeId: 11 },
          { file: 1, episodeId: 10 },
        ],
        reasoning: 'matched by episode number',
      },
    ]);
    const result = await matchSidecarsWithLlm({ llm, seriesTitle, files: ['a.ass', 'b.ass'], episodes });
    expect(result).toEqual([10, 11]);
    expect(llm.calls[0].callsite).toBe('sidecar-match');
  });

  it('coerces an episodeId not present in episodes to null without sinking the rest of the batch', async () => {
    const episodes = [episodeResource({ id: 10, episodeNumber: 1 }), episodeResource({ id: 11, episodeNumber: 2 })];
    const llm = new FakeGenerator([
      {
        assignments: [
          { file: 1, episodeId: 999 }, // hallucinated id, not in `episodes`
          { file: 2, episodeId: 11 },
        ],
        reasoning: 'file 1 unmatchable',
      },
    ]);
    const result = await matchSidecarsWithLlm({ llm, seriesTitle, files: ['a.ass', 'b.ass'], episodes });
    // File 1's bad id resolves to null; file 2's good id is untouched by file 1's failure.
    expect(result).toEqual([null, 11]);
  });

  it.each([
    { name: 'zero (files are 1-based)', fileNumber: 0 },
    { name: 'past the end of the list', fileNumber: 2 },
  ])('throws LlmError naming the number when the LLM assigns an out-of-range file index ($name)', async ({ fileNumber }) => {
    const episodes = [episodeResource({ id: 10 })];
    const llm = new FakeGenerator([{ assignments: [{ file: fileNumber, episodeId: 10 }], reasoning: '?' }]);
    await expect(matchSidecarsWithLlm({ llm, seriesTitle, files: ['a.ass'], episodes })).rejects.toThrow(String(fileNumber));
  });

  it('a file the LLM omitted from assignments resolves to null', async () => {
    const episodes = [episodeResource({ id: 10, episodeNumber: 1 }), episodeResource({ id: 11, episodeNumber: 2 })];
    const llm = new FakeGenerator([{ assignments: [{ file: 1, episodeId: 10 }], reasoning: 'only file 1 matched' }]);
    const result = await matchSidecarsWithLlm({ llm, seriesTitle, files: ['a.ass', 'b.ass'], episodes });
    expect(result).toEqual([10, null]);
  });

  it('an explicit episodeId: null assignment (LLM declares genuinely unmatchable) resolves to null', async () => {
    const episodes = [episodeResource({ id: 10 })];
    const llm = new FakeGenerator([{ assignments: [{ file: 1, episodeId: null }], reasoning: 'no episode matches' }]);
    const result = await matchSidecarsWithLlm({ llm, seriesTitle, files: ['a.ass'], episodes });
    expect(result).toEqual([null]);
  });

  it('returns [] without calling the llm when there are no files', async () => {
    const llm = new FakeGenerator([]);
    const result = await matchSidecarsWithLlm({ llm, seriesTitle, files: [], episodes: [episodeResource()] });
    expect(result).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });

  it('returns an all-null array without calling the llm when there are files but no episodes', async () => {
    const llm = new FakeGenerator([]);
    const result = await matchSidecarsWithLlm({ llm, seriesTitle, files: ['a.ass', 'b.ass'], episodes: [] });
    expect(result).toEqual([null, null]);
    expect(llm.calls).toHaveLength(0);
  });

  it('builds a prompt with the series title, a padded episode table, and numbered sidecar files', async () => {
    const episodes = [
      episodeResource({ id: 10, seasonNumber: 1, episodeNumber: 5, absoluteEpisodeNumber: 17, title: "The Journey's End" }),
      episodeResource({ id: 11, seasonNumber: 1, episodeNumber: 6, title: 'No Absolute Number' }),
    ];
    const llm = new FakeGenerator([
      { assignments: [{ file: 1, episodeId: 10 }], reasoning: 'matched' },
    ]);
    await matchSidecarsWithLlm({ llm, seriesTitle, files: ['[Group] Frieren - 05.ass'], episodes });
    const { system, prompt } = llm.calls[0];
    expect(prompt).toContain('Series: Frieren');
    expect(prompt).toContain('id=10 S01E05 abs=17 "The Journey\'s End"');
    // no absoluteEpisodeNumber -> no "abs=" segment for that row
    expect(prompt).toContain('id=11 S01E06 "No Absolute Number"');
    expect(prompt).toContain('#1 [Group] Frieren - 05.ass');
    expect(system.length).toBeGreaterThan(0);
    expect(system).toContain('JSON');
  });
});
