import { describe, expect, it } from 'vitest';
import { MAP_BATCH_SIZE, mapArchiveWithLlm } from '../src/pipelines/subtitle/mapArchive.js';
import { LlmError } from '../src/llm/generator.js';
import { episodeResource, FakeGenerator } from './helpers.js';

/** Every episode the show has a video for. 13 is on disk and already subtitled, so the run
 * wants nothing for it — it is in the table only so a season-1 file has somewhere true to go
 * instead of being forced onto a season-2 episode that shares its number. */
const EPISODES = [
  episodeResource({ id: 11, seasonNumber: 2, episodeNumber: 1 }),
  episodeResource({ id: 12, seasonNumber: 2, episodeNumber: 2 }),
  episodeResource({ id: 13, seasonNumber: 1, episodeNumber: 6 }),
];

const WANTED = new Set([11, 12]);

const FILES = [
  { path: '/c/S1/01.ass', lang: null, episodeRef: { season: null, episode: 1 } },
  { path: '/c/S1/02.ass', lang: 'zh-Hans', episodeRef: { season: null, episode: 2 } },
];

const ROOT = '/c';

type MapInput = Parameters<typeof mapArchiveWithLlm>[0];

function map(input: Partial<MapInput> & Pick<MapInput, 'llm'>) {
  return mapArchiveWithLlm({
    seriesTitle: 'Frieren',
    rootDir: ROOT,
    files: FILES,
    episodes: EPISODES,
    wanted: WANTED,
    ...input,
  });
}

describe('mapArchiveWithLlm', () => {
  it('returns episode ids positionally', async () => {
    const llm = new FakeGenerator([{ assignments: [{ file: 1, episodeId: 11 }, { file: 2, episodeId: 12 }], reasoning: 'ok' }]);
    expect(await map({ llm })).toEqual([11, 12]);
    expect(llm.calls[0]!.callsite).toBe('archive-map');
  });

  it.each([
    ['a wanted episode', 11, 11, []],
    ['an episode in the table that is not wanted', 13, null, [1]],
    ['an episode that is not in the table at all', 999, null, []],
  ])('assignment to %s', async (_label, assigned, expected, offTarget) => {
    const llm = new FakeGenerator([{ assignments: [{ file: 1, episodeId: assigned }], reasoning: 'ok' }]);
    const dropped: number[] = [];

    expect(await map({ llm, onOffTarget: (n) => dropped.push(n) })).toEqual([expected, null]);
    expect(dropped).toEqual(offTarget);
  });

  it('throws LlmError for an out-of-range file number', async () => {
    const llm = new FakeGenerator([{ assignments: [{ file: 9, episodeId: 11 }], reasoning: 'ok' }]);
    await expect(map({ llm })).rejects.toBeInstanceOf(LlmError);
  });

  it.each([
    ['marks a wanted episode', 'id=11 S02E01 "" (wanted)'],
    ['lists an episode nothing is wanted for, unmarked', 'id=13 S01E06 ""\n'],
  ])('the episode table %s', async (_label, line) => {
    const llm = new FakeGenerator([{ assignments: [], reasoning: 'ok' }]);
    await map({ llm });
    expect(llm.calls[0]!.prompt).toContain(line);
  });

  it('shows each file as its path under the pack root, since the directory carries the season', async () => {
    const llm = new FakeGenerator([{ assignments: [], reasoning: 'ok' }]);
    await map({ llm });
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

    const ids = await map({ llm, files });

    expect(llm.calls).toHaveLength(3);
    expect(ids).toHaveLength(count);
    expect(ids.map((id, i) => (id === 11 ? i : -1)).filter((i) => i >= 0)).toEqual([0, MAP_BATCH_SIZE, MAP_BATCH_SIZE * 2]);
  });

  it('reports off-target drops once per batch', async () => {
    const files = Array.from({ length: MAP_BATCH_SIZE + 1 }, (_, i) => ({ path: `/c/S1/${i}.ass`, lang: null, episodeRef: null }));
    const llm = new FakeGenerator([1, 2].map(() => ({ assignments: [{ file: 1, episodeId: 13 }], reasoning: 'ok' })));
    const dropped: number[] = [];

    await map({ llm, files, onOffTarget: (n) => dropped.push(n) });

    expect(dropped).toEqual([1, 1]);
  });

  it('short-circuits to all-null with no episodes, without calling the LLM', async () => {
    const llm = new FakeGenerator([]);
    expect(await map({ llm, episodes: [], wanted: new Set() })).toEqual([null, null]);
    expect(llm.calls).toHaveLength(0);
  });
});
