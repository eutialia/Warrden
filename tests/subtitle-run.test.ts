import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';
import { ArchiveCache } from '../src/db/archiveCache.js';
import { PlacedFiles } from '../src/db/placedFiles.js';
import { entriesForFiles } from '../src/pipelines/subtitle/archives.js';
import { runSubtitleJob } from '../src/pipelines/subtitle/run.js';
import type { MediaStream } from '../src/media/tools.js';
import { enqueueAndClaim, FakeGenerator, findEvent, hasEvent, subtitleFixture, tmpDir, type SubtitleFixture } from './helpers.js';

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

function makeZip(files: Record<string, string>): string {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content));
  const path = join(tmpDir(), 'pack.zip');
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
});
