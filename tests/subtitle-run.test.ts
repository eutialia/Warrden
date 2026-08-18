import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';
import { ArchiveCache } from '../src/db/archiveCache.js';
import { AttentionItems } from '../src/db/attention.js';
import { PlacedFiles } from '../src/db/placedFiles.js';
import { SiteProfiles } from '../src/db/siteProfiles.js';
import { TraceEntries } from '../src/db/traceEntries.js';
import { knowledgePath } from '../src/agent/siteKnowledge.js';
import { entriesForFiles } from '../src/pipelines/subtitle/archives.js';
import { runSubtitleJob } from '../src/pipelines/subtitle/run.js';
import type { MediaStream } from '../src/media/tools.js';
import { enqueueAndClaim, FakeGenerator, findEvent, hasEvent, seriesResource, subtitleFixture, tmpDir, type SubtitleFixture } from './helpers.js';

/** A video with one embedded ASS track (stream index 2) — the drift reference. The track's
 * language must NOT be a target language: reconcile treats an embedded zh-Hans track as
 * already covering the zh-Hans gap, so a reference the gate can use has to be a non-target
 * language (here 'ja') — the drift gate only cares about timings, not the reference's tongue. */
const VIDEO_STREAMS: MediaStream[] = [
  { index: 0, codecType: 'video', codecName: 'hevc', language: null },
  { index: 2, codecType: 'subtitle', codecName: 'ass', language: 'ja' },
];

/** An SRT cue table for the fixture's episode — shared by the reference extraction AND the
 * in-sync candidate so both parse to the same timings (drift sees them aligned). */
const SRT = `1
00:00:10,000 --> 00:00:12,000
one

2
00:00:30,000 --> 00:00:32,000
two

3
00:01:02,000 --> 00:01:04,000
three

4
00:01:35,000 --> 00:01:37,000
four

5
00:02:10,000 --> 00:02:12,000
five
`;

/** The same table shifted +5s — `assessDrift` recovers the offset, sees `drifted`. */
const SRT_SHIFTED = `1
00:00:15,000 --> 00:00:17,000
one

2
00:00:35,000 --> 00:00:37,000
two

3
00:01:07,000 --> 00:01:09,000
three

4
00:01:40,000 --> 00:01:42,000
four

5
00:02:15,000 --> 00:02:17,000
five
`;

/** Cues with no timing relationship to SRT at all — `assessDrift` scores every offset below
 * the quality threshold and returns `unscorable`. */
const SRT_UNRELATED = `1
00:00:07,000 --> 00:00:09,000
x

2
00:00:21,000 --> 00:00:23,000
y
`;

function makeZip(files: Record<string, string>, name = 'pack.zip'): string {
  const zip = new AdmZip();
  for (const [entry, content] of Object.entries(files)) zip.addFile(entry, Buffer.from(content));
  const path = join(tmpDir(), name);
  zip.writeZip(path);
  return path;
}

function claimSubtitleJob(fx: SubtitleFixture, opts?: { source?: string }) {
  return enqueueAndClaim(fx.ctx, {
    pipeline: 'subtitle',
    targetKind: fx.targetKind,
    targetId: fx.targetId,
    arrInstance: fx.arrInstance,
    payload: opts?.source ? { source: opts.source } : undefined,
  });
}

/** A `runSubtitleJob` `deps` stub: `searchSite` returns a downloaded zip pack built from
 * `files`, as a completed (`'downloaded'`) `SiteRunResult` with an empty transcript. */
function siteStub(files: Record<string, string>) {
  const zipPath = makeZip(files);
  return {
    searchSite: async () => ({ download: { filePath: zipPath, url: 'https://example.test/pack.zip' }, transcript: [], outcome: 'downloaded' as const }),
  };
}

/** A deps stub that fails the test if the runner ever calls the real site search. */
const NO_SITES = { searchSite: async () => { throw new Error('searchSite must not be called'); } };

/** A `reflectOnRun` stub that records every call's `verifiedSuccess` and returns a fixed
 * verdict — the reflection tests' spy. */
function reflectSpy(calls: Array<{ verifiedSuccess: boolean }>) {
  return async (input: { verifiedSuccess: boolean }) => {
    calls.push({ verifiedSuccess: input.verifiedSuccess });
    return { verdict: 'usable' as const, reason: 'ok' };
  };
}

// The fixture's library holds one video (S01E05), so a candidate named `Show - S01E05.ass`
// parses to { season: null, episode: 5 } and deterministically matches it via the
// single-regular-season rule in matchSidecarDeterministic — no LLM involved.
const PACK = { 'Show - S01E05.ass': SRT };

describe('runSubtitleJob', () => {
  it('movie target: missing langs -> site pack places beside the movie file', async () => {
    const fx = subtitleFixture({ targetKind: 'movie', targetId: 7 });
    const llm = new FakeGenerator([]);
    fx.ctx.llm = llm;

    const job = claimSubtitleJob(fx);
    await runSubtitleJob(fx.ctx, job, siteStub({ 'Perfect Blue.zh-Hans.ass': SRT }));

    expect(llm.calls).toHaveLength(0);
    expect(hasEvent(fx.ctx.events.list(), 'subtitle.placed')).toBe(true);
    const expected = join(fx.libraryDir, 'Perfect Blue (1997).zh-Hans.ass');
    expect(existsSync(expected)).toBe(true);
    const rows = new PlacedFiles(fx.ctx.db).listByTarget(fx.arrInstance, 'movie', 7);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      target_kind: 'movie',
      data: { lang: 'zh-Hans', matchedBy: 'pipeline', drift: 'unverified' },
    });
  });

  it('nothing missing -> subtitle.complete, no site search', async () => {
    // The video already has an embedded track in the TARGET language, so reconcile finds no
    // gaps (contrast with VIDEO_STREAMS above, whose track is non-target so it can serve as
    // a drift reference while the episode still counts as missing the target language).
    const fx = subtitleFixture();
    fx.media.setStreams(fx.videoPath, [
      { index: 0, codecType: 'video', codecName: 'hevc', language: null },
      { index: 2, codecType: 'subtitle', codecName: 'ass', language: 'zh-Hans' },
    ]);

    const job = claimSubtitleJob(fx);
    await runSubtitleJob(fx.ctx, job, NO_SITES);

    expect(findEvent(fx.ctx.events.list(), 'subtitle.complete')).toBeTruthy();
    expect(hasEvent(fx.ctx.events.list(), 'subtitle.missing')).toBe(false);
  });

  it('cache hit: an archive_cache row with an entry matching the missing episode -> placed with provenance + subtitle.cache-hit + subtitle.placed, no LLM/site calls', async () => {
    const fx = subtitleFixture();
    // No embedded ref -> the candidate places unverified, no drift gate, no extraction.
    const extractDir = tmpDir();
    const filePath = join(extractDir, '0-Show - S01E05.ass');
    writeFileSync(filePath, SRT);
    new ArchiveCache(fx.ctx.db).upsert({
      arrInstance: fx.arrInstance,
      targetKind: 'series',
      targetId: fx.targetId,
      sourceUrl: 'https://example.test/pack.zip',
      path: extractDir,
      files: entriesForFiles([filePath]),
    });
    const llm = new FakeGenerator([]);
    fx.ctx.llm = llm;

    const job = claimSubtitleJob(fx);
    await runSubtitleJob(fx.ctx, job, NO_SITES);

    expect(llm.calls).toHaveLength(0);
    expect(hasEvent(fx.ctx.events.list(), 'subtitle.cache-hit')).toBe(true);
    expect(hasEvent(fx.ctx.events.list(), 'subtitle.placed')).toBe(true);

    const expected = join(fx.libraryDir, 'Show - S01E05.zh-Hans.ass');
    expect(existsSync(expected)).toBe(true);
    const rows = new PlacedFiles(fx.ctx.db).listByTarget(fx.arrInstance, 'series', fx.targetId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source_path: filePath,
      data: { lang: 'zh-Hans', matchedBy: 'pipeline', drift: 'unverified' },
    });
  });

  /** A deps stub that hands back a fresh zip each call under the given url, named the way the
   * agent loop names a download: run-scoped and timestamped, so the SAME url yields a DIFFERENT
   * local basename every run. That difference is the whole point: cache identity has to come
   * from the url, not the transient file. The pack holds only "Bonus.ass", which the LLM
   * remainder maps to nothing (see NO_MATCH), so the episode stays missing and the second run
   * reaches the site search again instead of stopping on coverage; caching happens before
   * matching either way. */
  function repeatSiteStub(url: string) {
    let n = 0;
    return {
      searchSite: async () => {
        n += 1;
        return { download: { filePath: makeZip({ 'Bonus.ass': SRT }, `acg.rip-${Date.now()}-${n}-pack.zip`), url }, transcript: [], outcome: 'downloaded' as const };
      },
    };
  }

  type SiteStub = ReturnType<typeof repeatSiteStub>;

  /** The LLM remainder verdict for a pack that matches nothing. Queued generously: each run
   * asks once per cached row it revisits plus once for the fresh download. */
  const NO_MATCH = { assignments: [{ file: 1, episodeId: null }], reasoning: 'no episode matches' };
  const noMatches = (): FakeGenerator => new FakeGenerator(Array.from({ length: 6 }, () => NO_MATCH));
  const cacheDirs = (fx: SubtitleFixture): string[] => readdirSync(join(fx.ctx.dataDir, 'subtitle', 'cache'));

  /** Two separate runs against the same target. Each job is completed before the next is
   * claimed, since the queue keeps one job per target in flight. */
  async function runTwice(fx: SubtitleFixture, first: SiteStub, second: SiteStub): Promise<void> {
    for (const deps of [first, second]) {
      const job = claimSubtitleJob(fx);
      await runSubtitleJob(fx.ctx, job, deps);
      fx.ctx.queue.complete(job.id);
    }
  }

  it('same pack url downloaded on two runs -> one archive_cache row and one cache dir', async () => {
    const fx = subtitleFixture();
    fx.ctx.llm = noMatches();
    const deps = repeatSiteStub('https://acg.rip/files/Frieren%20[Group].zip');

    await runTwice(fx, deps, deps);

    const rows = new ArchiveCache(fx.ctx.db).forTarget(fx.arrInstance, 'series', fx.targetId);
    expect(rows).toHaveLength(1);
    expect(cacheDirs(fx)).toHaveLength(1);
    expect(existsSync(join(rows[0]!.path, '0-Bonus.ass'))).toBe(true);
  });

  it('two different pack filenames -> distinct cache rows and dirs', async () => {
    const fx = subtitleFixture();
    fx.ctx.llm = noMatches();

    await runTwice(fx, repeatSiteStub('https://acg.rip/files/pack-a.zip'), repeatSiteStub('https://acg.rip/files/pack-b.zip'));

    expect(new ArchiveCache(fx.ctx.db).forTarget(fx.arrInstance, 'series', fx.targetId)).toHaveLength(2);
    expect(cacheDirs(fx)).toHaveLength(2);
  });

  it('site flow: a missing episode -> searchSite returns a zip -> extract -> deterministic map -> drift in-sync -> placed with correct name + provenance', async () => {
    // The video's embedded track extracts to SRT (the reference); the candidate's content is
    // the same SRT (in-sync). Drift uses the REAL parseSubtitleCues/assessDrift — the fake is
    // MediaTools only.
    const fx = subtitleFixture();
    fx.media.setStreams(fx.videoPath, VIDEO_STREAMS);
    fx.media.setExtraction(`${fx.videoPath}:2`, SRT);
    const llm = new FakeGenerator([]);
    fx.ctx.llm = llm;

    const job = claimSubtitleJob(fx);
    await runSubtitleJob(fx.ctx, job, siteStub(PACK));

    // LLM only ever runs for the unmatched remainder — this pack matched deterministically.
    expect(llm.calls).toHaveLength(0);
    expect(fx.media.extractCalls).toHaveLength(1); // the reference extracted once
    expect(hasEvent(fx.ctx.events.list(), 'subtitle.placed')).toBe(true);

    const expected = join(fx.libraryDir, 'Show - S01E05.zh-Hans.ass');
    expect(existsSync(expected)).toBe(true);
    expect(hasEvent(fx.ctx.events.list({ level: 'attention' }), 'subtitle.unresolved')).toBe(false);

    const rows = new PlacedFiles(fx.ctx.db).listByTarget(fx.arrInstance, 'series', fx.targetId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      data: { matchedBy: 'pipeline', drift: 'in-sync', site: 'acg.rip', sourceFile: expect.stringContaining('Show - S01E05.ass') },
    });
  });

  it('traces the arr calls and one side-effecting entry per placement', async () => {
    const fx = subtitleFixture();
    fx.media.setStreams(fx.videoPath, VIDEO_STREAMS);
    fx.media.setExtraction(`${fx.videoPath}:2`, SRT);

    const job = claimSubtitleJob(fx);
    await runSubtitleJob(fx.ctx, job, siteStub(PACK));

    const rows = new TraceEntries(fx.ctx.db).listByJob(job.id);
    expect(rows.map((r) => r.kind)).toContain('arr.request');
    const placed = rows.filter((r) => r.kind === 'pipeline.place');
    expect(placed).toHaveLength(1);
    expect(placed[0]!.side_effect).toBe(1);
  });

  it('drifted candidate -> resyncAlass called -> re-assessed in-sync -> placed with subtitle.resynced', async () => {
    // The candidate content is SRT_SHIFTED — assessDrift sees it as drifted against SRT.
    // The extracted candidate's path isn't known until the runner picks it at runtime, so
    // the fake's alass is told (via the wildcard seam) to produce the aligned table — that's
    // exactly what a real alass run against the reference would write, and the REAL
    // parseSubtitleCues/assessDrift then re-assesses that output as in-sync.
    const fx = subtitleFixture();
    fx.media.setStreams(fx.videoPath, VIDEO_STREAMS);
    fx.media.setExtraction(`${fx.videoPath}:2`, SRT);
    fx.media.setAlassResult(SRT);

    const job = claimSubtitleJob(fx);
    await runSubtitleJob(fx.ctx, job, siteStub({ 'Show - S01E05.ass': SRT_SHIFTED }));

    expect(fx.media.alassCalls).toHaveLength(1); // the drifted path entered resync
    expect(fx.media.ffsubsyncCalls).toHaveLength(0); // alass landed in-sync — no fallback needed
    expect(hasEvent(fx.ctx.events.list(), 'subtitle.resynced')).toBe(true);
    const expected = join(fx.libraryDir, 'Show - S01E05.zh-Hans.ass');
    expect(existsSync(expected)).toBe(true);
  });

  it('unscorable candidate -> quarantined + subtitle.quarantined attention; episode -> subtitle.unresolved', async () => {
    const fx = subtitleFixture();
    fx.media.setStreams(fx.videoPath, VIDEO_STREAMS);
    fx.media.setExtraction(`${fx.videoPath}:2`, SRT);

    const job = claimSubtitleJob(fx);
    await runSubtitleJob(fx.ctx, job, siteStub({ 'Show - S01E05.ass': SRT_UNRELATED }));

    expect(hasEvent(fx.ctx.events.list({ level: 'attention' }), 'subtitle.quarantined')).toBe(true);
    expect(hasEvent(fx.ctx.events.list({ level: 'attention' }), 'subtitle.unresolved')).toBe(true);
    expect(new PlacedFiles(fx.ctx.db).listByTarget(fx.arrInstance, 'series', fx.targetId)).toHaveLength(0);
  });

  it('no sites configured -> subtitle.unresolved attention for the missing episode', async () => {
    const fx = subtitleFixture({ sites: [] });
    const job = claimSubtitleJob(fx);
    await runSubtitleJob(fx.ctx, job);

    const unresolved = findEvent(fx.ctx.events.list({ level: 'attention' }), 'subtitle.unresolved');
    expect(unresolved).toBeTruthy();
    expect(unresolved!.data).toMatchObject({ episodeId: 1, dedupeKey: '1' });
  });

  it('foreign file at target path -> skipped (warn event), no overwrite', async () => {
    // A blocker AT the placement target for the missing language would count as reconcile
    // coverage (a `Show - S01E05.zh-Hans.ass` sibling IS the zh-Hans coverage), which would
    // pre-empt the run before placement — so the foreign-file guard can only fire when the
    // candidate's OWN lang tag points the target at a path reconcile doesn't count as
    // covering the missing language. A ja-tagged candidate targets `.ja.ass`, which reconcile
    // ignores for the missing zh-Hans: the episode is still "missing zh-Hans", placement aims
    // at `.ja.ass`, and the foreign file sitting there blocks it.
    const fx = subtitleFixture();
    const targetPath = join(fx.libraryDir, 'Show - S01E05.ja.ass');
    writeFileSync(targetPath, 'foreign-content');
    const job = claimSubtitleJob(fx);

    await runSubtitleJob(fx.ctx, job, siteStub({ 'Show - S01E05.ja.ass': SRT }));

    expect(readFileSync(targetPath, 'utf-8')).toBe('foreign-content');
    expect(findEvent(fx.ctx.events.list({ level: 'warn' }), 'subtitle.skipped-foreign')).toBeTruthy();
    expect(new PlacedFiles(fx.ctx.db).listByTarget(fx.arrInstance, 'series', fx.targetId)).toHaveLength(0);
    expect(hasEvent(fx.ctx.events.list({ level: 'attention' }), 'subtitle.unresolved')).toBe(true);
  });

  it('alass unavailable -> skips alass, ffsubsync fallback lands in-sync -> placed via ffsubsync', async () => {
    const fx = subtitleFixture();
    fx.media.setStreams(fx.videoPath, VIDEO_STREAMS);
    fx.media.setExtraction(`${fx.videoPath}:2`, SRT);
    fx.media.setAvailability({ alass: false }); // container missing alass
    fx.media.setFfsubsyncResult(SRT); // ffsubsync output lands aligned

    const job = claimSubtitleJob(fx);
    await runSubtitleJob(fx.ctx, job, siteStub({ 'Show - S01E05.ass': SRT_SHIFTED }));

    expect(fx.media.alassCalls).toHaveLength(0); // never attempted
    expect(fx.media.ffsubsyncCalls).toHaveLength(1); // the fallback carried it
    expect(hasEvent(fx.ctx.events.list(), 'subtitle.resynced')).toBe(true);
    const expected = join(fx.libraryDir, 'Show - S01E05.zh-Hans.ass');
    expect(existsSync(expected)).toBe(true);
  });

  it('both resync binaries unavailable -> quarantined + unresolved, candidate moved, no throw', async () => {
    const fx = subtitleFixture();
    fx.media.setStreams(fx.videoPath, VIDEO_STREAMS);
    fx.media.setExtraction(`${fx.videoPath}:2`, SRT);
    fx.media.setAvailability({ alass: false, ffsubsync: false });

    const job = claimSubtitleJob(fx);
    await expect(runSubtitleJob(fx.ctx, job, siteStub({ 'Show - S01E05.ass': SRT_SHIFTED }))).resolves.toBeUndefined();

    // Neither binary may even be attempted — a real missing binary would throw ENOENT here.
    expect(fx.media.alassCalls).toHaveLength(0);
    expect(fx.media.ffsubsyncCalls).toHaveLength(0);
    const quarantined = findEvent(fx.ctx.events.list({ level: 'attention' }), 'subtitle.quarantined');
    expect(quarantined).toBeTruthy();
    expect(hasEvent(fx.ctx.events.list({ level: 'attention' }), 'subtitle.unresolved')).toBe(true);
    const quarantinedPath = (quarantined!.data as { quarantinedPath: string }).quarantinedPath;
    expect(existsSync(quarantinedPath)).toBe(true); // the candidate moved to the quarantine dir
    expect(new PlacedFiles(fx.ctx.db).listByTarget(fx.arrInstance, 'series', fx.targetId)).toHaveLength(0);
  });

  it('movie target respects the mount guard like series (missing marker reschedules)', async () => {
    const fx = subtitleFixture({ targetKind: 'movie', targetId: 7 });
    fx.ctx.config.ingest.mountMarkers = [join(fx.libraryDir, 'nas-mount-marker')];

    const job = claimSubtitleJob(fx);
    await expect(runSubtitleJob(fx.ctx, job)).rejects.toMatchObject({
      name: 'RescheduleError',
      delayMs: 300_000,
    });
    expect(hasEvent(fx.ctx.events.list({ level: 'attention' }), 'subtitle.mount-missing')).toBe(true);
  });

  it('places one of two target languages without treating the episode as fully resolved', async () => {
    // Config wants both zh-Hans and zh-Hant. The pack only carries a zh-Hans-tagged file:
    // that language must land, but the episode stays in the working set (and raises
    // subtitle.unresolved) because zh-Hant is still missing. Pre-fix this collapsed the
    // whole episode after any single placement.
    const fx = subtitleFixture({ languages: ['zh-Hans', 'zh-Hant'] });
    // No embedded ref -> place unverified (avoids needing cue content for the gate).
    const job = claimSubtitleJob(fx);
    await runSubtitleJob(fx.ctx, job, siteStub({ 'Show - S01E05.zh-Hans.ass': SRT }));

    const hansPath = join(fx.libraryDir, 'Show - S01E05.zh-Hans.ass');
    const hantPath = join(fx.libraryDir, 'Show - S01E05.zh-Hant.ass');
    expect(existsSync(hansPath)).toBe(true);
    expect(existsSync(hantPath)).toBe(false);
    expect(hasEvent(fx.ctx.events.list(), 'subtitle.placed')).toBe(true);
    // Still unresolved: zh-Hant was never filled.
    expect(hasEvent(fx.ctx.events.list({ level: 'attention' }), 'subtitle.unresolved')).toBe(true);

    const rows = new PlacedFiles(fx.ctx.db).listByTarget(fx.arrInstance, 'series', fx.targetId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).toMatchObject({ lang: 'zh-Hans' });
  });

  it('fully resolves an episode only after every target language is placed', async () => {
    const fx = subtitleFixture({ languages: ['zh-Hans', 'zh-Hant'] });
    const job = claimSubtitleJob(fx);
    await runSubtitleJob(
      fx.ctx,
      job,
      siteStub({
        'Show - S01E05.zh-Hans.ass': SRT,
        'Show - S01E05.zh-Hant.ass': SRT,
      }),
    );

    expect(existsSync(join(fx.libraryDir, 'Show - S01E05.zh-Hans.ass'))).toBe(true);
    expect(existsSync(join(fx.libraryDir, 'Show - S01E05.zh-Hant.ass'))).toBe(true);
    expect(hasEvent(fx.ctx.events.list({ level: 'attention' }), 'subtitle.unresolved')).toBe(false);
    expect(new PlacedFiles(fx.ctx.db).listByTarget(fx.arrInstance, 'series', fx.targetId)).toHaveLength(2);
  });

  it('reflects with a verified success only when the archive placed something', async () => {
    const calls: Array<{ verifiedSuccess: boolean }> = [];
    const fx = subtitleFixture();
    const job = claimSubtitleJob(fx);
    await runSubtitleJob(fx.ctx, job, {
      ...siteStub(PACK), // deterministically matches the fixture's only missing episode
      reflectOnRun: reflectSpy(calls),
    });

    expect(calls).toEqual([{ verifiedSuccess: true }]);
  });

  it('reflects with an unverified outcome when the archive placed nothing', async () => {
    const calls: Array<{ verifiedSuccess: boolean }> = [];
    const fx = subtitleFixture();
    fx.ctx.llm = new FakeGenerator([{ assignments: [{ file: 1, episodeId: null }], reasoning: 'no episode matches' }]);
    const job = claimSubtitleJob(fx);
    // "Bonus.ass" carries no season/episode marker, so it never matches deterministically —
    // it falls to the LLM remainder pass, which (per the fixture above) maps it to nothing.
    // A real archive that extracts and reaches matching, not just a null download.
    await runSubtitleJob(fx.ctx, job, {
      ...siteStub({ 'Bonus.ass': SRT }),
      reflectOnRun: reflectSpy(calls),
    });

    expect(calls).toEqual([{ verifiedSuccess: false }]);
  });

  it('skips reflection entirely when the site was on cooldown', async () => {
    let called = false;
    const fx = subtitleFixture();
    const job = claimSubtitleJob(fx);
    await runSubtitleJob(fx.ctx, job, {
      searchSite: async () => ({ download: null, transcript: [], outcome: 'cooldown' as const }),
      reflectOnRun: async () => {
        called = true;
        return null;
      },
    });

    expect(called).toBe(false);
  });

  it('a reflection failure for one site does not stop the job or swallow later sites/attention items', async () => {
    // Real reflectOnRun (no stub) and self-learning switched on, so this exercises the
    // actual failure path rather than a mock of it — the reviewer's exact probe.
    const fx = subtitleFixture({
      sites: [
        { name: 'a', baseUrl: 'https://a.test' },
        { name: 'b', baseUrl: 'https://b.test' },
      ],
    });
    fx.ctx.config.llm.model = { provider: 'openrouter', model: 'test-model' };
    // Only site b's reflection reaches the model — site a's fails before any generate call.
    fx.ctx.llm = new FakeGenerator([{ verdict: 'usable', reason: 'ok', ops: [] }]);
    // A directory sitting where site a's notes file belongs: loadKnowledge's readFileSync
    // throws EISDIR, the real filesystem condition the review reproduced.
    mkdirSync(knowledgePath(fx.ctx.dataDir, 'https://a.test'), { recursive: true });

    const searched: string[] = [];
    const job = claimSubtitleJob(fx);
    await runSubtitleJob(fx.ctx, job, {
      searchSite: async (_ctx, _job, site) => {
        searched.push(site.baseUrl);
        return { download: null, transcript: [], outcome: 'gave-up' as const };
      },
    });

    expect(searched).toEqual(['https://a.test', 'https://b.test']);
    expect(findEvent(fx.ctx.events.list({}), 'subtitle.knowledge-failed')?.level).toBe('warn');
    expect(hasEvent(fx.ctx.events.list({ level: 'attention' }), 'subtitle.unresolved')).toBe(true);
  });

  it('reflects a verified success when one of two configured languages actually placed', async () => {
    // The spec's oracle is "placed something," not "fully resolved the episode" — a single-
    // language pack against a two-language config must still verify true.
    const calls: Array<{ verifiedSuccess: boolean }> = [];
    const fx = subtitleFixture({ languages: ['zh-Hans', 'zh-Hant'] });
    const job = claimSubtitleJob(fx);
    await runSubtitleJob(fx.ctx, job, {
      ...siteStub({ 'Show - S01E05.zh-Hans.ass': SRT }),
      reflectOnRun: reflectSpy(calls),
    });

    expect(calls).toEqual([{ verifiedSuccess: true }]);
  });

  it('reflects with verifiedSuccess: false, then still propagates, when extraction fails hard', async () => {
    // Not UnsupportedArchiveError: a genuinely corrupt zip that AdmZip's constructor throws
    // a plain Error for. extractAndMatch only swallows UnsupportedArchiveError; anything
    // else must reflect first and then keep propagating (job fails, runner retries).
    const calls: Array<{ verifiedSuccess: boolean }> = [];
    const zipPath = join(tmpDir(), 'corrupt.zip');
    writeFileSync(zipPath, 'not actually a zip file');
    const fx = subtitleFixture();
    const job = claimSubtitleJob(fx);

    await expect(
      runSubtitleJob(fx.ctx, job, {
        searchSite: async () => ({
          download: { filePath: zipPath, url: 'https://example.test/corrupt.zip' },
          transcript: [],
          outcome: 'downloaded' as const,
        }),
        reflectOnRun: reflectSpy(calls),
      }),
    ).rejects.toThrow();

    expect(calls).toEqual([{ verifiedSuccess: false }]);
  });

  it('raises one deduped attention item carrying the reason and evidence', async () => {
    const fx = subtitleFixture();
    const job = claimSubtitleJob(fx);
    const transcript = [{ ts: 1, tier: 'chromium' as const, action: 'open', detail: 'HTTP 403 bot wall' }];
    const deps = {
      searchSite: async () => ({ download: null, transcript, outcome: 'exhausted' as const }),
      reflectOnRun: async () => ({ verdict: 'unusable' as const, reason: 'Cloudflare wall survives every tier' }),
    };
    await runSubtitleJob(fx.ctx, job, deps);
    await runSubtitleJob(fx.ctx, job, deps);

    const items = new AttentionItems(fx.ctx.db).list({ status: 'open' }).filter((i) => i.kind === 'subtitle.site-unusable');
    expect(items).toHaveLength(1);
    expect(items[0]!.data.reason).toContain('Cloudflare');
    expect(JSON.stringify(items[0]!.data)).toContain('403');
  });

  // G4: the model's own reason sentence is unbounded input (its own prompt only asks for
  // "one sentence", not a length), and used to flow uncapped into the event message, the
  // attention item's data, and disabled_reason on accept — while the evidence lines beside
  // it were already capped at 300. Same cap, same style, checked at the boundary.
  it('caps the unusable reason at EVIDENCE_DETAIL_CAP (300 chars), same as evidence detail', async () => {
    const fx = subtitleFixture();
    const job = claimSubtitleJob(fx);
    const transcript = [{ ts: 1, tier: 'chromium' as const, action: 'open', detail: 'HTTP 403 bot wall' }];
    const longReason = `Cloudflare wall survives every tier. ${'x'.repeat(400)}`;
    const deps = {
      searchSite: async () => ({ download: null, transcript, outcome: 'exhausted' as const }),
      reflectOnRun: async () => ({ verdict: 'unusable' as const, reason: longReason }),
    };
    await runSubtitleJob(fx.ctx, job, deps);
    await runSubtitleJob(fx.ctx, job, deps);

    const items = new AttentionItems(fx.ctx.db).list({ status: 'open' }).filter((i) => i.kind === 'subtitle.site-unusable');
    expect(items).toHaveLength(1);
    const reason = items[0]!.data.reason as string;
    expect(reason.length).toBe(300);
    expect(reason).toBe(longReason.slice(0, 300));
    expect((items[0]!.message as string).length).toBeLessThan(longReason.length);
  });

  it('dedupes the unusable-site item per SITE, not per target: two different jobs against two different series that hit the same site still collapse into one open item', async () => {
    // Regression guard for the deliberate deviation from targetEventData's per-target
    // dedupe grain (see raiseUnusable's doc comment in src/pipelines/subtitle/run.ts):
    // the verdict is a fact about the SITE, so a second series hitting the same wall must
    // not spam a second card. Two distinct claimed jobs against two distinct series ids
    // sharing this fixture's one configured site (https://acg.rip).
    const fx = subtitleFixture();
    fx.client.series.push(seriesResource({ id: 99, title: 'Second Show' }));
    const jobA = claimSubtitleJob(fx);
    const jobB = enqueueAndClaim(fx.ctx, {
      pipeline: 'subtitle',
      targetKind: 'series',
      targetId: 99,
      arrInstance: fx.arrInstance,
    });
    const transcript = [{ ts: 1, tier: 'chromium' as const, action: 'open', detail: 'HTTP 403 bot wall' }];
    const deps = {
      searchSite: async () => ({ download: null, transcript, outcome: 'exhausted' as const }),
      reflectOnRun: async () => ({ verdict: 'unusable' as const, reason: 'Cloudflare wall survives every tier' }),
    };

    await runSubtitleJob(fx.ctx, jobA, deps);
    await runSubtitleJob(fx.ctx, jobB, deps);

    const items = new AttentionItems(fx.ctx.db).list({ status: 'open' }).filter((i) => i.kind === 'subtitle.site-unusable');
    expect(items).toHaveLength(1);
  });

  it('skips a disabled site without spending a run', async () => {
    const fx = subtitleFixture();
    new SiteProfiles(fx.ctx.db).upsert({ baseUrl: 'https://acg.rip' });
    new SiteProfiles(fx.ctx.db).update('https://acg.rip', { disabledAt: Date.now(), disabledReason: 'bot wall' });
    const job = claimSubtitleJob(fx);
    let ran = false;
    await runSubtitleJob(fx.ctx, job, {
      searchSite: async () => {
        ran = true;
        return { download: null, transcript: [], outcome: 'gave-up' as const };
      },
    });
    expect(ran).toBe(false);
  });

  it('falls through to the normal unresolved resolution, with no extra event spam, when every configured site is disabled', async () => {
    const fx = subtitleFixture();
    new SiteProfiles(fx.ctx.db).upsert({ baseUrl: 'https://acg.rip' });
    new SiteProfiles(fx.ctx.db).update('https://acg.rip', { disabledAt: Date.now(), disabledReason: 'bot wall' });
    const job = claimSubtitleJob(fx);
    await runSubtitleJob(fx.ctx, job, NO_SITES);

    const attentionEvents = fx.ctx.events.list({ level: 'attention' });
    expect(hasEvent(attentionEvents, 'subtitle.unresolved')).toBe(true);
    expect(hasEvent(attentionEvents, 'subtitle.site-unusable')).toBe(false);
  });
});
