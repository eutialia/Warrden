import { describe, expect, it } from 'vitest';
import { mapArchiveWithLlm } from '../src/pipelines/subtitle/mapArchive.js';
import { LlmError } from '../src/llm/generator.js';
import { episodeResource, FakeGenerator } from './helpers.js';

const EPISODES = [
  episodeResource({ id: 11, episodeNumber: 1 }),
  episodeResource({ id: 12, episodeNumber: 2 }),
];

const FILES = [
  { path: '/c/0-01.ass', lang: null, episodeRef: { season: null, episode: 1 } },
  { path: '/c/1-02.ass', lang: 'zh-Hans', episodeRef: { season: null, episode: 2 } },
];

describe('mapArchiveWithLlm', () => {
  it('returns episode ids positionally', async () => {
    const llm = new FakeGenerator([{ assignments: [{ file: 1, episodeId: 11 }, { file: 2, episodeId: 12 }], reasoning: 'ok' }]);
    expect(await mapArchiveWithLlm({ llm, seriesTitle: 'Frieren', files: FILES, episodes: EPISODES })).toEqual([11, 12]);
    expect(llm.calls[0]!.callsite).toBe('archive-map');
  });

  it('coerces an unknown episode id to null', async () => {
    const llm = new FakeGenerator([{ assignments: [{ file: 1, episodeId: 999 }, { file: 2, episodeId: 12 }], reasoning: 'ok' }]);
    expect(await mapArchiveWithLlm({ llm, seriesTitle: 'Frieren', files: FILES, episodes: EPISODES })).toEqual([null, 12]);
  });

  it('throws LlmError for an out-of-range file number', async () => {
    const llm = new FakeGenerator([{ assignments: [{ file: 9, episodeId: 11 }], reasoning: 'ok' }]);
    await expect(mapArchiveWithLlm({ llm, seriesTitle: 'Frieren', files: FILES, episodes: EPISODES })).rejects.toBeInstanceOf(LlmError);
  });

  it('short-circuits to all-null with no episodes, without calling the LLM', async () => {
    const llm = new FakeGenerator([]);
    expect(await mapArchiveWithLlm({ llm, seriesTitle: 'Frieren', files: FILES, episodes: [] })).toEqual([null, null]);
    expect(llm.calls).toHaveLength(0);
  });
});
