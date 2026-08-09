import { describe, it, expect } from 'vitest';
import { LlmError } from '../src/llm/generator.js';
import { planBundleImport } from '../src/pipelines/ingest/bundle.js';
import { episodeResource, manualImportItem, FakeGenerator, bundleResponse } from './helpers.js';

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
    const episodes = [episodeResource({ id: 100, seasonNumber: 1, episodeNumber: 1, hasFile: false })];
    const llm = new FakeGenerator([]);

    const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [item], episodes });

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
    const episodes = [episodeResource({ id: 5, seasonNumber: 1, episodeNumber: 2, hasFile: false })];
    const llm = new FakeGenerator([]);

    const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [item], episodes });

    // Deterministic tier picks it up from the filename (S01E02), not from item.episodes
    // (id 200 isn't even in the episode table).
    expect(plan?.files).toEqual([expect.objectContaining({ episodeIds: [5] })]);
    expect(llm.calls).toHaveLength(0);
  });

  it("drops a tier-1 episode id the caller's episode table does not recognize; the item falls through to tier 2/3 instead of importing with a bogus id", async () => {
    const episodes = [episodeResource({ id: 5, seasonNumber: 1, episodeNumber: 1, hasFile: false })];
    // item.episodes names id 999, which isn't in `episodes` at all — but the filename
    // itself parses deterministically onto the real episode 5.
    const item = manualImportItem({
      path: '/downloads/Show/Show - S01E01.mkv',
      episodes: [{ id: 999 }],
      rejections: [],
    });
    const llm = new FakeGenerator([]);

    const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [item], episodes });

    expect(plan?.files).toEqual([expect.objectContaining({ episodeIds: [5] })]);
    expect(llm.calls).toHaveLength(0);
  });

  it('a tier-1 item with a partially-valid episode id list keeps only the surviving ids', async () => {
    const episodes = [
      episodeResource({ id: 1, seasonNumber: 1, episodeNumber: 1, hasFile: false }),
      episodeResource({ id: 2, seasonNumber: 1, episodeNumber: 2, hasFile: false }),
    ];
    const item = manualImportItem({
      path: '/downloads/Show/Double Episode.mkv',
      episodes: [{ id: 1 }, { id: 999 }, { id: 2 }],
      rejections: [],
    });
    const llm = new FakeGenerator([]);

    const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [item], episodes });

    expect(plan?.files).toEqual([expect.objectContaining({ episodeIds: [1, 2] })]);
  });

  it('maps an unresolved item deterministically via the SxxEyy filename onto a missing episode, without calling the LLM; confidence stays high', async () => {
    const episodes = [episodeResource({ id: 7, seasonNumber: 2, episodeNumber: 3, hasFile: false })];
    const item = manualImportItem({ path: '/downloads/Show/Show - S02E03 [1080p].mkv', episodes: [] });
    const llm = new FakeGenerator([]);

    const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [item], episodes });

    expect(plan).not.toBeNull();
    expect(plan!.confidence).toBe('high');
    expect(plan!.files).toEqual([expect.objectContaining({ path: item.path, episodeIds: [7] })]);
    expect(llm.calls).toHaveLength(0);
  });

  it('tier 2 never maps onto an episode that already has a file — falls through to the LLM tier instead', async () => {
    // S02E03 already has a file: a bundle rescue must not silently displace it.
    const episodes = [episodeResource({ id: 7, seasonNumber: 2, episodeNumber: 3, hasFile: true })];
    const item = manualImportItem({ path: '/downloads/Show/Show - S02E03 [1080p].mkv', episodes: [] });
    const llm = new FakeGenerator([bundleResponse({ mappings: [{ file: 1, episodeIds: [] }], confidence: 'high', reasoning: 'already has a file' })]);

    const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [item], episodes });

    expect(llm.calls).toHaveLength(1); // deterministic tier bailed, LLM tier ran
    expect(plan).toBeNull(); // LLM judged it not importable (empty episodeIds)
  });

  it('CRITICAL: a missing season must not collapse the single-regular-season heuristic into a false-confident wrong match', async () => {
    // S01 is complete (hasFile:true, abs 1-5); S02 is entirely missing (hasFile:false,
    // abs 6-10). Filtering `episodes` to hasFile:false BEFORE calling
    // matchSidecarDeterministic would make S02 look like "the series' only regular
    // season", wrongly resolving a bare "05" onto S02E05 (unoccupied, so the
    // occupied-episode cap can't catch it either) at 'high' confidence instead of
    // falling through to the LLM. Matching against the FULL list first correctly finds
    // the unique absolute-number hit is S01E05 — which already has a file — and rejects it.
    const episodes = [
      episodeResource({ id: 1, seasonNumber: 1, episodeNumber: 1, absoluteEpisodeNumber: 1, hasFile: true }),
      episodeResource({ id: 2, seasonNumber: 1, episodeNumber: 2, absoluteEpisodeNumber: 2, hasFile: true }),
      episodeResource({ id: 3, seasonNumber: 1, episodeNumber: 3, absoluteEpisodeNumber: 3, hasFile: true }),
      episodeResource({ id: 4, seasonNumber: 1, episodeNumber: 4, absoluteEpisodeNumber: 4, hasFile: true }),
      episodeResource({ id: 5, seasonNumber: 1, episodeNumber: 5, absoluteEpisodeNumber: 5, hasFile: true }),
      episodeResource({ id: 6, seasonNumber: 2, episodeNumber: 1, absoluteEpisodeNumber: 6, hasFile: false }),
      episodeResource({ id: 7, seasonNumber: 2, episodeNumber: 2, absoluteEpisodeNumber: 7, hasFile: false }),
      episodeResource({ id: 8, seasonNumber: 2, episodeNumber: 3, absoluteEpisodeNumber: 8, hasFile: false }),
      episodeResource({ id: 9, seasonNumber: 2, episodeNumber: 4, absoluteEpisodeNumber: 9, hasFile: false }),
      episodeResource({ id: 10, seasonNumber: 2, episodeNumber: 5, absoluteEpisodeNumber: 10, hasFile: false }),
    ];
    const item = manualImportItem({ path: '/downloads/Bundle/Show - 05.mkv', episodes: [] });
    const llm = new FakeGenerator([
      bundleResponse({ mappings: [{ file: 1, episodeIds: [] }], confidence: 'medium', reasoning: 'genuinely ambiguous between seasons' }),
    ]);

    const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [item], episodes });

    // Falls through to the LLM tier — NOT resolved deterministically onto S02E05 (id 10).
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].prompt).toContain('Show - 05.mkv');
    expect(plan).toBeNull(); // the LLM's own (ambiguous) answer leaves nothing importable
  });

  it('sends everything deterministic mapping could not place to ONE LLM call and applies its per-file episodeIds', async () => {
    const episodes = [
      episodeResource({ id: 1, seasonNumber: 1, episodeNumber: 1, hasFile: false }),
      episodeResource({ id: 2, seasonNumber: 1, episodeNumber: 2, hasFile: false }),
    ];
    // Neither filename parses deterministically (no SxxEyy, no unique bare number rule
    // applies the same way — "Bundle" has no digits at all).
    const itemA = manualImportItem({ path: '/downloads/Bundle/Bundle - Ep A.mkv' });
    const itemB = manualImportItem({ path: '/downloads/Bundle/Bundle - Ep B.mkv' });
    const llm = new FakeGenerator([
      bundleResponse({
        mappings: [
          { file: 1, episodeIds: [1] },
          { file: 2, episodeIds: [2] },
        ],
        confidence: 'medium',
        reasoning: 'matched by absolute order',
      }),
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
    const episodes = [episodeResource({ id: 1, hasFile: false })];
    const item = manualImportItem({ path: '/downloads/Bundle/NCOP.mkv' });
    const llm = new FakeGenerator([
      bundleResponse({ mappings: [{ file: 1, episodeIds: [] }], confidence: 'high', reasoning: 'not an episode' }),
    ]);

    const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [item], episodes });

    expect(plan).toBeNull(); // the only item was unimportable
  });

  it('an empty episodeIds from the LLM lands only that file in skipped when other files DO import', async () => {
    const episodes = [episodeResource({ id: 1, seasonNumber: 1, episodeNumber: 1, hasFile: false })];
    const ncop = manualImportItem({ path: '/downloads/Bundle/NCOP.mkv' });
    const ep = manualImportItem({ path: '/downloads/Bundle/Ep One.mkv' });
    const llm = new FakeGenerator([
      bundleResponse({
        mappings: [
          { file: 1, episodeIds: [] },
          { file: 2, episodeIds: [1] },
        ],
        confidence: 'high',
        reasoning: 'one episode, one non-video extra',
      }),
    ]);

    const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [ncop, ep], episodes });

    expect(plan!.skipped).toEqual(['/downloads/Bundle/NCOP.mkv']);
    expect(plan!.files).toEqual([expect.objectContaining({ path: '/downloads/Bundle/Ep One.mkv', episodeIds: [1] })]);
  });

  it('a file the LLM omits entirely from mappings resolves to skipped, same as an explicit empty episodeIds', async () => {
    const episodes = [episodeResource({ id: 1, seasonNumber: 1, episodeNumber: 1, hasFile: false })];
    const ep = manualImportItem({ path: '/downloads/Bundle/Ep One.mkv' });
    const menu = manualImportItem({ path: '/downloads/Bundle/Menu.mkv' });
    const llm = new FakeGenerator([
      // Only file 1 (Ep One) is mentioned; file 2 (Menu) never appears in `mappings` at all.
      bundleResponse({ mappings: [{ file: 1, episodeIds: [1] }], confidence: 'high', reasoning: 'only one real episode' }),
    ]);

    const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [ep, menu], episodes });

    expect(plan!.files).toEqual([expect.objectContaining({ path: ep.path, episodeIds: [1] })]);
    expect(plan!.skipped).toEqual([menu.path]);
  });

  it("drops an LLM episodeId that isn't in the episode table; the file is skipped if none survive", async () => {
    const episodes = [episodeResource({ id: 1, seasonNumber: 1, episodeNumber: 1, hasFile: false })];
    const item = manualImportItem({ path: '/downloads/Bundle/Ep One.mkv' });
    const llm = new FakeGenerator([
      bundleResponse({ mappings: [{ file: 1, episodeIds: [999] }], confidence: 'medium', reasoning: 'guess' }),
    ]);

    const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [item], episodes });

    expect(plan).toBeNull();
  });

  it('drops only the invalid id out of a mixed episodeIds array, keeping the file importable with the survivors', async () => {
    const episodes = [
      episodeResource({ id: 1, seasonNumber: 1, episodeNumber: 1, hasFile: false }),
      episodeResource({ id: 2, seasonNumber: 1, episodeNumber: 2, hasFile: false }),
    ];
    const item = manualImportItem({ path: '/downloads/Bundle/Double Episode.mkv' });
    const llm = new FakeGenerator([
      bundleResponse({ mappings: [{ file: 1, episodeIds: [1, 999, 2] }], confidence: 'low', reasoning: 'double episode file' }),
    ]);

    const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [item], episodes });

    expect(plan!.files).toEqual([expect.objectContaining({ episodeIds: [1, 2] })]);
    expect(plan!.confidence).toBe('low');
  });

  it.each([
    { name: 'zero (files are 1-based)', fileNumber: 0 },
    { name: 'past the end of the list', fileNumber: 2 },
  ])('throws LlmError naming the number when the LLM maps an out-of-range file index ($name)', async ({ fileNumber }) => {
    const episodes = [episodeResource({ id: 1, hasFile: false })];
    const item = manualImportItem({ path: '/downloads/Bundle/Ep One.mkv' });
    const llm = new FakeGenerator([bundleResponse({ mappings: [{ file: fileNumber, episodeIds: [1] }], confidence: 'high', reasoning: '?' })]);

    const call = planBundleImport({ llm, seriesTitle, seriesId, items: [item], episodes });
    await expect(call).rejects.toThrow(LlmError);
    await expect(call).rejects.toThrow(String(fileNumber));
  });

  it('returns null when every item is unimportable (no arr resolution, no deterministic match, LLM finds nothing)', async () => {
    const episodes = [episodeResource({ id: 1, seasonNumber: 1, episodeNumber: 1, hasFile: false })];
    const sample = manualImportItem({ path: '/downloads/Bundle/sample.mkv' });
    const llm = new FakeGenerator([bundleResponse({ mappings: [{ file: 1, episodeIds: [] }], confidence: 'high', reasoning: 'sample file' })]);

    const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [sample], episodes });

    expect(plan).toBeNull();
  });

  it('returns null for an empty items list without calling the LLM', async () => {
    const llm = new FakeGenerator([]);
    const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [], episodes: [episodeResource()] });
    expect(plan).toBeNull();
    expect(llm.calls).toHaveLength(0);
  });

  it('skips unresolved items and never calls the LLM when the episode table is empty', async () => {
    const item = manualImportItem({ path: '/downloads/Bundle/Ep One.mkv' });
    const llm = new FakeGenerator([]);

    const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [item], episodes: [] });

    expect(plan).toBeNull();
    expect(llm.calls).toHaveLength(0);
  });

  it('renders season-0 rows with a hasFile flag and the numbered file list with size in GB in the LLM prompt', async () => {
    const episodes = [
      episodeResource({ id: 1, seasonNumber: 0, episodeNumber: 1, title: 'OVA', hasFile: false }),
      episodeResource({ id: 2, seasonNumber: 1, episodeNumber: 1, hasFile: true }),
    ];
    const item = manualImportItem({ path: '/downloads/Bundle/Extra.mkv', size: Math.round(0.7 * 1_073_741_824) });
    const llm = new FakeGenerator([bundleResponse({ mappings: [{ file: 1, episodeIds: [] }], confidence: 'high', reasoning: 'extra' })]);

    await planBundleImport({ llm, seriesTitle, seriesId, items: [item], episodes });

    const { prompt, system } = llm.calls[0];
    expect(prompt).toContain('id=1 S00E01 "OVA" hasFile=false');
    expect(prompt).toContain('id=2 S01E01 "" hasFile=true');
    expect(prompt).toContain('#1 Extra.mkv (0.7 GB)');
    expect(system).toContain('JSON');
  });

  describe('duplicate-target guard', () => {
    it('two files resolving (via tier 2) to the same episode are BOTH skipped, not silently deduped to one', async () => {
      const episodes = [episodeResource({ id: 5, seasonNumber: 1, episodeNumber: 5, hasFile: false })];
      const itemA = manualImportItem({ path: '/downloads/Bundle/Show - 05.mkv' });
      const itemB = manualImportItem({ path: '/downloads/Bundle/Show - 05v2.mkv' });
      const llm = new FakeGenerator([]);

      const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [itemA, itemB], episodes });

      expect(plan).toBeNull(); // both were the only candidates and both got pulled
      expect(llm.calls).toHaveLength(0); // both resolved deterministically before the guard ran
    });

    it('pulls only the duplicate pair, leaving an unrelated valid file importable', async () => {
      const episodes = [
        episodeResource({ id: 5, seasonNumber: 1, episodeNumber: 5, hasFile: false }),
        episodeResource({ id: 6, seasonNumber: 1, episodeNumber: 6, hasFile: false }),
      ];
      const dupA = manualImportItem({ path: '/downloads/Bundle/Show - 05.mkv' });
      const dupB = manualImportItem({ path: '/downloads/Bundle/Show - 05v2.mkv' });
      const clean = manualImportItem({ path: '/downloads/Bundle/Show - 06.mkv' });
      const llm = new FakeGenerator([]);

      const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [dupA, dupB, clean], episodes });

      expect(plan!.files).toEqual([expect.objectContaining({ path: clean.path, episodeIds: [6] })]);
      expect(plan!.skipped.sort()).toEqual([dupA.path, dupB.path].sort());
      expect(plan!.reasoning).toContain('duplicate');
    });
  });

  describe('already-imported skip (incremental only)', () => {
    it('a tier-1 item resolved onto an occupied episode is dropped; plan is null when nothing else remains', async () => {
      const episodes = [episodeResource({ id: 10, seasonNumber: 1, episodeNumber: 1, hasFile: true })];
      const item = manualImportItem({
        path: '/downloads/Show/Show - S01E01.mkv',
        episodes: [{ id: 10 }],
        rejections: [],
      });
      const llm = new FakeGenerator([]);

      const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [item], episodes });

      expect(plan).toBeNull();
      expect(llm.calls).toHaveLength(0);
    });

    it('an LLM-resolved file targeting only an occupied episode is skipped; plan is null when nothing free remains', async () => {
      const episodes = [episodeResource({ id: 10, seasonNumber: 1, episodeNumber: 1, hasFile: true })];
      const item = manualImportItem({ path: '/downloads/Bundle/Weird Name.mkv' });
      const llm = new FakeGenerator([
        bundleResponse({ mappings: [{ file: 1, episodeIds: [10] }], confidence: 'high', reasoning: 'certain match, replaces existing file' }),
      ]);

      const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [item], episodes });

      expect(plan).toBeNull();
    });

    it('keeps free-episode files and skips occupied ones in the same plan', async () => {
      const episodes = [
        episodeResource({ id: 10, seasonNumber: 1, episodeNumber: 1, hasFile: true }),
        episodeResource({ id: 11, seasonNumber: 1, episodeNumber: 2, hasFile: false }),
      ];
      const occupied = manualImportItem({
        path: '/downloads/Show/Show - S01E01.mkv',
        episodes: [{ id: 10 }],
        rejections: [],
      });
      const free = manualImportItem({
        path: '/downloads/Show/Show - S01E02.mkv',
        episodes: [{ id: 11 }],
        rejections: [],
      });
      const llm = new FakeGenerator([]);

      const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [occupied, free], episodes });

      expect(plan!.files).toEqual([expect.objectContaining({ path: free.path, episodeIds: [11] })]);
      expect(plan!.skipped).toContain(occupied.path);
      expect(plan!.confidence).toBe('high');
      expect(plan!.reasoning).toContain('already imported');
    });

    it('a plan with only free targets keeps the LLM-reported confidence as-is', async () => {
      const episodes = [episodeResource({ id: 10, seasonNumber: 1, episodeNumber: 1, hasFile: false })];
      const item = manualImportItem({ path: '/downloads/Bundle/Weird Name.mkv' });
      const llm = new FakeGenerator([bundleResponse({ mappings: [{ file: 1, episodeIds: [10] }], confidence: 'medium', reasoning: 'inferred' })]);

      const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [item], episodes });

      expect(plan!.confidence).toBe('medium');
    });
  });

  it('mixed-tier plan: tier-1, tier-2, and LLM files coexist; files keep [tier-1/2 in item order, then LLM] ordering; confidence = the LLM confidence', async () => {
    const episodes = [
      episodeResource({ id: 1, seasonNumber: 1, episodeNumber: 1, hasFile: false }), // tier 1 target
      episodeResource({ id: 2, seasonNumber: 1, episodeNumber: 2, hasFile: false }), // tier 2 target (deterministic)
      episodeResource({ id: 3, seasonNumber: 1, episodeNumber: 3, hasFile: false }), // LLM target
    ];
    const tier1Item = manualImportItem({ path: '/downloads/Bundle/A.mkv', episodes: [{ id: 1 }], rejections: [] });
    const llmItem = manualImportItem({ path: '/downloads/Bundle/Cryptic Name.mkv' }); // needs the LLM
    const tier2Item = manualImportItem({ path: '/downloads/Bundle/Show - S01E02.mkv' }); // deterministic -> id 2

    const llm = new FakeGenerator([
      bundleResponse({ mappings: [{ file: 1, episodeIds: [3] }], confidence: 'medium', reasoning: 'inferred from absolute order' }),
    ]);

    const plan = await planBundleImport({
      llm,
      seriesTitle,
      seriesId,
      items: [tier1Item, llmItem, tier2Item],
      episodes,
    });

    // First loop pass (over `items` in order) resolves tier1Item then tier2Item
    // straight into `files`; llmItem is deferred to `remaining` and only appended once
    // the single LLM call comes back.
    expect(plan!.files).toEqual([
      expect.objectContaining({ path: tier1Item.path, episodeIds: [1] }),
      expect.objectContaining({ path: tier2Item.path, episodeIds: [2] }),
      expect.objectContaining({ path: llmItem.path, episodeIds: [3] }),
    ]);
    expect(plan!.confidence).toBe('medium');
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].prompt).toContain('Cryptic Name.mkv');
  });

  describe('per-file episodeIds dedup', () => {
    it('deduplicates a repeated id the LLM answered with ([1, 1]) so the file imports once and the duplicate-target guard does not falsely fire', async () => {
      const episodes = [episodeResource({ id: 1, seasonNumber: 1, episodeNumber: 1, hasFile: false })];
      const item = manualImportItem({ path: '/downloads/Bundle/Ep One.mkv' });
      const llm = new FakeGenerator([
        bundleResponse({ mappings: [{ file: 1, episodeIds: [1, 1] }], confidence: 'high', reasoning: 'dup id from the LLM' }),
      ]);

      const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [item], episodes });

      expect(plan!.files).toEqual([expect.objectContaining({ episodeIds: [1] })]);
      expect(plan!.skipped).toEqual([]); // must not be flagged as a cross-file duplicate
    });

    it('deduplicates repeated ids in a tier-1 item.episodes list too', async () => {
      const episodes = [episodeResource({ id: 1, seasonNumber: 1, episodeNumber: 1, hasFile: false })];
      const item = manualImportItem({
        path: '/downloads/Show/Show.mkv',
        episodes: [{ id: 1 }, { id: 1 }],
        rejections: [],
      });
      const llm = new FakeGenerator([]);

      const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [item], episodes });

      expect(plan!.files).toEqual([expect.objectContaining({ episodeIds: [1] })]);
    });

    it('a genuine double-episode file ([1, 2], two distinct ids) is unaffected by the dedup', async () => {
      const episodes = [
        episodeResource({ id: 1, seasonNumber: 1, episodeNumber: 1, hasFile: false }),
        episodeResource({ id: 2, seasonNumber: 1, episodeNumber: 2, hasFile: false }),
      ];
      const item = manualImportItem({ path: '/downloads/Bundle/Double Episode.mkv' });
      const llm = new FakeGenerator([
        bundleResponse({ mappings: [{ file: 1, episodeIds: [1, 2] }], confidence: 'high', reasoning: 'double episode' }),
      ]);

      const plan = await planBundleImport({ llm, seriesTitle, seriesId, items: [item], episodes });

      expect(plan!.files).toEqual([expect.objectContaining({ episodeIds: [1, 2] })]);
    });
  });
});
