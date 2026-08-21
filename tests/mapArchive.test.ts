import { describe, expect, it } from 'vitest';
import { MAP_BATCH_SIZE, mapArchiveWithLlm } from '../src/pipelines/subtitle/mapArchive.js';
import { LlmError } from '../src/llm/generator.js';
import { episodeResource, FakeGenerator } from './helpers.js';

const EPISODES = [
  episodeResource({ id: 11, episodeNumber: 1 }),
  episodeResource({ id: 12, episodeNumber: 2 }),
];

const FILES = [
  { path: '/c/S1/01.ass', lang: null, episodeRef: { season: null, episode: 1 } },
  { path: '/c/S1/02.ass', lang: 'zh-Hans', episodeRef: { season: null, episode: 2 } },
];

const ROOT = '/c';

describe('mapArchiveWithLlm', () => {
  it('returns episode ids positionally', async () => {
    const llm = new FakeGenerator([{ assignments: [{ file: 1, episodeId: 11 }, { file: 2, episodeId: 12 }], reasoning: 'ok' }]);
    expect(await mapArchiveWithLlm({ llm, seriesTitle: 'Frieren', files: FILES, episodes: EPISODES, rootDir: ROOT })).toEqual([11, 12]);
    expect(llm.calls[0]!.callsite).toBe('archive-map');
  });

  it('coerces an unknown episode id to null', async () => {
    const llm = new FakeGenerator([{ assignments: [{ file: 1, episodeId: 999 }, { file: 2, episodeId: 12 }], reasoning: 'ok' }]);
    expect(await mapArchiveWithLlm({ llm, seriesTitle: 'Frieren', files: FILES, episodes: EPISODES, rootDir: ROOT })).toEqual([null, 12]);
  });

  it('throws LlmError for an out-of-range file number', async () => {
    const llm = new FakeGenerator([{ assignments: [{ file: 9, episodeId: 11 }], reasoning: 'ok' }]);
    await expect(mapArchiveWithLlm({ llm, seriesTitle: 'Frieren', files: FILES, episodes: EPISODES, rootDir: ROOT })).rejects.toBeInstanceOf(LlmError);
  });

  it('shows each file as its path under the pack root, since the directory carries the season', async () => {
    const llm = new FakeGenerator([{ assignments: [], reasoning: 'ok' }]);
    await mapArchiveWithLlm({ llm, seriesTitle: 'Frieren', files: FILES, episodes: EPISODES, rootDir: ROOT });
    expect(llm.calls[0]!.prompt).toContain('S1/01.ass');
  });

  it('splits a large pack into one generate call per batch, keeping results aligned', async () => {
    const count = 250;
    const files = Array.from({ length: count }, (_, i) => ({
      path: `/c/S1/${String(i + 1).padStart(3, '0')}.ass`,
      lang: null,
      episodeRef: null,
    }));
    // Every batch answers "file 1 -> episode 11", so alignment shows as episode 11 landing
    // at exactly the first index of each batch and nowhere else.
    const llm = new FakeGenerator([1, 2, 3].map(() => ({ assignments: [{ file: 1, episodeId: 11 }], reasoning: 'ok' })));

    const ids = await mapArchiveWithLlm({ llm, seriesTitle: 'Frieren', files, episodes: EPISODES, rootDir: ROOT });

    expect(llm.calls).toHaveLength(3);
    expect(ids).toHaveLength(count);
    expect(ids.map((id, i) => (id === 11 ? i : -1)).filter((i) => i >= 0)).toEqual([0, MAP_BATCH_SIZE, MAP_BATCH_SIZE * 2]);
  });

  it('short-circuits to all-null with no episodes, without calling the LLM', async () => {
    const llm = new FakeGenerator([]);
    expect(await mapArchiveWithLlm({ llm, seriesTitle: 'Frieren', files: FILES, episodes: [], rootDir: ROOT })).toEqual([null, null]);
    expect(llm.calls).toHaveLength(0);
  });
});
