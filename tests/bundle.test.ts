import { describe, it, expect } from 'vitest';
import { planBundleImport } from '../src/pipelines/ingest/bundle.js';
import { episodeResource, manualImportItem, FakeGenerator } from './helpers.js';

const seriesTitle = 'Frieren';
const seriesId = 42;

describe('planBundleImport', () => {
  it('round-trips quality/languages/releaseGroup/folderName verbatim for arr-resolved items, stamps seriesId, no LLM call', async () => {
    const quality = { quality: { id: 9, name: 'WEBDL-1080p' } };
    const languages = [{ id: 2, name: 'English' }];
    const item = manualImportItem({
      path: '/downloads/Show/Show - S01E01.mkv',
      folderName: 'Show Folder',
      quality,
      languages,
      releaseGroup: 'SubsPlease',
      episodes: [{ id: 100 }],
      rejections: [],
    });
    const llm = new FakeGenerator([]);

    const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [item], episodes: [] });

    expect(plan).toEqual({
      files: [
        {
          path: '/downloads/Show/Show - S01E01.mkv',
          folderName: 'Show Folder',
          seriesId,
          episodeIds: [100],
          quality,
          languages,
          releaseGroup: 'SubsPlease',
        },
      ],
      confidence: 'high',
      reasoning: expect.any(String),
      skipped: [],
    });
    expect(llm.calls).toHaveLength(0);
  });

  it('an arr-resolved item that also carries a rejection is NOT passed straight through (falls to deterministic/LLM tiers instead)', async () => {
    const item = manualImportItem({
      path: '/downloads/Show/Show - S01E02.mkv',
      episodes: [{ id: 200 }],
      rejections: [{ reason: 'quality profile mismatch' }],
    });
    const episodes = [episodeResource({ id: 5, seasonNumber: 1, episodeNumber: 2 })];
    const llm = new FakeGenerator([]);

    const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [item], episodes });

    // Deterministic tier picks it up from the filename (S01E02), not from item.episodes.
    expect(plan?.files).toEqual([expect.objectContaining({ episodeIds: [5] })]);
    expect(llm.calls).toHaveLength(0);
  });

  it('maps an unresolved item deterministically via the SxxEyy filename, without calling the LLM; confidence stays high', async () => {
    const episodes = [episodeResource({ id: 7, seasonNumber: 2, episodeNumber: 3 })];
    const item = manualImportItem({ path: '/downloads/Show/Show - S02E03 [1080p].mkv', episodes: [] });
    const llm = new FakeGenerator([]);

    const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [item], episodes });

    expect(plan).not.toBeNull();
    expect(plan!.confidence).toBe('high');
    expect(plan!.files).toEqual([expect.objectContaining({ path: item.path, episodeIds: [7] })]);
    expect(llm.calls).toHaveLength(0);
  });

  it('sends everything deterministic mapping could not place to ONE LLM call and applies its per-file episodeIds', async () => {
    const episodes = [
      episodeResource({ id: 1, seasonNumber: 1, episodeNumber: 1 }),
      episodeResource({ id: 2, seasonNumber: 1, episodeNumber: 2 }),
    ];
    // Neither filename parses deterministically (no SxxEyy, no unique bare number rule
    // applies the same way — "Bundle" has no digits at all).
    const itemA = manualImportItem({ path: '/downloads/Bundle/Bundle - Ep A.mkv' });
    const itemB = manualImportItem({ path: '/downloads/Bundle/Bundle - Ep B.mkv' });
    const llm = new FakeGenerator([
      {
        mappings: [
          { file: 1, episodeIds: [1] },
          { file: 2, episodeIds: [2] },
        ],
        confidence: 'medium',
        reasoning: 'matched by absolute order',
      },
    ]);

    const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [itemA, itemB], episodes });

    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].callsite).toBe('bundle-map');
    expect(plan).toEqual({
      files: [
        expect.objectContaining({ path: itemA.path, episodeIds: [1] }),
        expect.objectContaining({ path: itemB.path, episodeIds: [2] }),
      ],
      confidence: 'medium',
      reasoning: 'matched by absolute order',
      skipped: [],
    });
  });

  it('an empty episodeIds from the LLM sends the file to skipped, pinned to its path', async () => {
    const episodes = [episodeResource({ id: 1 })];
    const item = manualImportItem({ path: '/downloads/Bundle/NCOP.mkv' });
    const llm = new FakeGenerator([
      { mappings: [{ file: 1, episodeIds: [] }], confidence: 'high', reasoning: 'not an episode' },
    ]);

    const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [item], episodes });

    expect(plan).toBeNull(); // the only item was unimportable
  });

  it('an empty episodeIds from the LLM lands only that file in skipped when other files DO import', async () => {
    const episodes = [episodeResource({ id: 1, seasonNumber: 1, episodeNumber: 1 })];
    const ncop = manualImportItem({ path: '/downloads/Bundle/NCOP.mkv' });
    const ep = manualImportItem({ path: '/downloads/Bundle/Ep One.mkv' });
    const llm = new FakeGenerator([
      {
        mappings: [
          { file: 1, episodeIds: [] },
          { file: 2, episodeIds: [1] },
        ],
        confidence: 'high',
        reasoning: 'one episode, one non-video extra',
      },
    ]);

    const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [ncop, ep], episodes });

    expect(plan!.skipped).toEqual(['/downloads/Bundle/NCOP.mkv']);
    expect(plan!.files).toEqual([expect.objectContaining({ path: '/downloads/Bundle/Ep One.mkv', episodeIds: [1] })]);
  });

  it("drops an LLM episodeId that isn't in the episode table; the file is skipped if none survive", async () => {
    const episodes = [episodeResource({ id: 1, seasonNumber: 1, episodeNumber: 1 })];
    const item = manualImportItem({ path: '/downloads/Bundle/Ep One.mkv' });
    const llm = new FakeGenerator([
      { mappings: [{ file: 1, episodeIds: [999] }], confidence: 'medium', reasoning: 'guess' },
    ]);

    const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [item], episodes });

    expect(plan).toBeNull();
  });

  it('drops only the invalid id out of a mixed episodeIds array, keeping the file importable with the survivors', async () => {
    const episodes = [
      episodeResource({ id: 1, seasonNumber: 1, episodeNumber: 1 }),
      episodeResource({ id: 2, seasonNumber: 1, episodeNumber: 2 }),
    ];
    const item = manualImportItem({ path: '/downloads/Bundle/Double Episode.mkv' });
    const llm = new FakeGenerator([
      { mappings: [{ file: 1, episodeIds: [1, 999, 2] }], confidence: 'low', reasoning: 'double episode file' },
    ]);

    const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [item], episodes });

    expect(plan!.files).toEqual([expect.objectContaining({ episodeIds: [1, 2] })]);
    expect(plan!.confidence).toBe('low');
  });

  it.each([
    { name: 'zero (files are 1-based)', fileNumber: 0 },
    { name: 'past the end of the list', fileNumber: 2 },
  ])('throws LlmError naming the number when the LLM maps an out-of-range file index ($name)', async ({ fileNumber }) => {
    const episodes = [episodeResource({ id: 1 })];
    const item = manualImportItem({ path: '/downloads/Bundle/Ep One.mkv' });
    const llm = new FakeGenerator([{ mappings: [{ file: fileNumber, episodeIds: [1] }], confidence: 'high', reasoning: '?' }]);

    await expect(planBundleImport({ llm, seriesTitle, seriesId, items: [item], episodes })).rejects.toThrow(String(fileNumber));
  });

  it('returns null when every item is unimportable (no arr resolution, no deterministic match, LLM finds nothing)', async () => {
    const episodes = [episodeResource({ id: 1, seasonNumber: 1, episodeNumber: 1 })];
    const sample = manualImportItem({ path: '/downloads/Bundle/sample.mkv' });
    const llm = new FakeGenerator([{ mappings: [{ file: 1, episodeIds: [] }], confidence: 'high', reasoning: 'sample file' }]);

    const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [sample], episodes });

    expect(plan).toBeNull();
  });

  it('returns null for an empty items list without calling the LLM', async () => {
    const llm = new FakeGenerator([]);
    const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [], episodes: [episodeResource()] });
    expect(plan).toBeNull();
    expect(llm.calls).toHaveLength(0);
  });

  it('renders season-0 rows with a hasFile flag and the numbered file list with size in GB in the LLM prompt', async () => {
    const episodes = [
      episodeResource({ id: 1, seasonNumber: 0, episodeNumber: 1, title: 'OVA', hasFile: false }),
      episodeResource({ id: 2, seasonNumber: 1, episodeNumber: 1, hasFile: true }),
    ];
    const item = manualImportItem({ path: '/downloads/Bundle/Extra.mkv', size: Math.round(0.7 * 1_073_741_824) });
    const llm = new FakeGenerator([{ mappings: [{ file: 1, episodeIds: [] }], confidence: 'high', reasoning: 'extra' }]);

    await planBundleImport({ llm, seriesTitle, seriesId, items: [item], episodes });

    const { prompt, system } = llm.calls[0];
    expect(prompt).toContain('id=1 S00E01 "OVA" hasFile=false');
    expect(prompt).toContain('id=2 S01E01 "" hasFile=true');
    expect(prompt).toContain('#1 Extra.mkv (0.7 GB)');
    expect(system).toContain('JSON');
  });
});
