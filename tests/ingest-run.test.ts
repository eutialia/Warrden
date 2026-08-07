import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { PlacedFiles } from '../src/db/placedFiles.js';
import { RescheduleError } from '../src/jobs/errors.js';
import { runIngestJob, SETTLE_RETRY_MS, SETTLE_DEADLINE_MS, MOUNT_RETRY_MS } from '../src/pipelines/ingest/run.js';
import { AcceptDataSchema } from '../src/server/app.js';
import {
  bundleImportPayload,
  bundleResponse,
  ctxWithClient,
  enqueueAndClaim,
  episodeResource,
  fakeArrClient,
  FakeGenerator,
  findEvent,
  hasEvent,
  ingestFixture,
  makeCtx,
  manualImportItem,
  seriesResource,
  tmpDir,
  type IngestFixture,
} from './helpers.js';

function claimIngestJob(fx: IngestFixture) {
  return enqueueAndClaim(fx.ctx, {
    pipeline: 'ingest',
    targetKind: fx.targetKind,
    targetId: fx.targetId,
    arrInstance: fx.arrInstance,
  });
}

describe('runIngestJob — settle gate', () => {
  it('settle-wait: the target is importing -> RescheduleError(SETTLE_RETRY_MS), nothing swept', async () => {
    const fx = ingestFixture();
    fx.client.queue = [{ id: 1, seriesId: fx.targetId, status: 'completed', trackedDownloadState: 'importing', title: 'x' }];
    writeFileSync(join(fx.torrentDir, 'Show - 05 [JPSC].ass'), 'sub');
    const job = claimIngestJob(fx);

    const call = runIngestJob(fx.ctx, job);
    await expect(call).rejects.toThrow(RescheduleError);
    await expect(call).rejects.toMatchObject({ delayMs: SETTLE_RETRY_MS });

    expect(new PlacedFiles(fx.ctx.db).listByTarget(fx.arrInstance, fx.targetKind, fx.targetId)).toHaveLength(0);
    expect(hasEvent(fx.ctx.events.list(), 'ingest.placed')).toBe(false);
  });

  it('settle deadline: created_at older than SETTLE_DEADLINE_MS -> completes with an ingest.settle-timeout attention event, nothing swept', async () => {
    const fx = ingestFixture();
    fx.client.queue = [{ id: 1, seriesId: fx.targetId, status: 'completed', trackedDownloadState: 'importing', title: 'x' }];
    writeFileSync(join(fx.torrentDir, 'Show - 05 [JPSC].ass'), 'sub');
    const job = claimIngestJob(fx);
    fx.ctx.db.prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run(Date.now() - SETTLE_DEADLINE_MS - 1_000, job.id);
    const staleJob = fx.ctx.queue.get(job.id)!;

    await expect(runIngestJob(fx.ctx, staleJob)).resolves.toBeUndefined();

    expect(hasEvent(fx.ctx.events.list({ level: 'attention' }), 'ingest.settle-timeout')).toBe(true);
    expect(new PlacedFiles(fx.ctx.db).listByTarget(fx.arrInstance, fx.targetKind, fx.targetId)).toHaveLength(0);
  });

  it('mount missing: an absent mount marker -> RescheduleError(MOUNT_RETRY_MS) + ingest.mount-missing attention event', async () => {
    // A path that's guaranteed absent — a subpath of a real fixture dir that's never created.
    const fx = ingestFixture();
    const job = claimIngestJob(fx);
    fx.ctx.config.ingest.mountMarkers = [join(fx.downloadsDir, 'nas-mount-marker')];

    const call = runIngestJob(fx.ctx, job);
    await expect(call).rejects.toThrow(RescheduleError);
    await expect(call).rejects.toMatchObject({ delayMs: MOUNT_RETRY_MS });

    expect(hasEvent(fx.ctx.events.list({ level: 'attention' }), 'ingest.mount-missing')).toBe(true);
  });
});

describe('runIngestJob — sidecar sweep and placement', () => {
  it('happy sidecar path: deterministically-matched sidecars are copied beside the video, sources untouched, provenance + ingest.placed recorded', async () => {
    const fx = ingestFixture();
    const assPath = join(fx.torrentDir, 'Show - 05 [JPSC].ass');
    const mkaPath = join(fx.torrentDir, 'Show - 05.mka');
    writeFileSync(assPath, 'subtitle-content');
    writeFileSync(mkaPath, 'audio-content');
    const job = claimIngestJob(fx);

    await runIngestJob(fx.ctx, job);

    const expectedAss = join(fx.libraryDir, 'Show - S01E05.zh-Hans.ass');
    const expectedMka = join(fx.libraryDir, 'Show - S01E05.mka');
    expect(readFileSync(expectedAss, 'utf-8')).toBe('subtitle-content');
    expect(readFileSync(expectedMka, 'utf-8')).toBe('audio-content');
    expect(existsSync(assPath)).toBe(true); // source untouched
    expect(existsSync(mkaPath)).toBe(true);

    const rows = new PlacedFiles(fx.ctx.db).listByTarget(fx.arrInstance, fx.targetKind, fx.targetId);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.job_id === job.id)).toBe(true);
    expect(rows.find((r) => r.source_path === assPath)).toMatchObject({ data: { lang: 'zh-Hans', matchedBy: 'deterministic' } });

    expect(fx.ctx.events.list().filter((e) => e.kind === 'ingest.placed')).toHaveLength(2);
  });

  it('LLM fallback: a cryptic name deterministic cannot place goes to one sidecar-match call; a matched id places it, a null answer raises ingest.unmatched and leaves it unplaced', async () => {
    const fx = ingestFixture();
    const matchedPath = join(fx.torrentDir, 'Random Title - XYZ.ass');
    const unmatchedPath = join(fx.torrentDir, 'Another Title - ABC.srt');
    writeFileSync(matchedPath, 'sub');
    writeFileSync(unmatchedPath, 'sub');
    const llm = new FakeGenerator([
      {
        // walkFiles sorts paths, so "Another..." (file #1) sorts before "Random..." (file #2).
        assignments: [
          { file: 1, episodeId: null },
          { file: 2, episodeId: 1 },
        ],
        reasoning: 'one clear, one not',
      },
    ]);
    fx.ctx.llm = llm;
    const job = claimIngestJob(fx);

    await runIngestJob(fx.ctx, job);

    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.callsite).toBe('sidecar-match');

    const placedTarget = join(fx.libraryDir, 'Show - S01E05.ass');
    expect(existsSync(placedTarget)).toBe(true);

    const rows = new PlacedFiles(fx.ctx.db).listByTarget(fx.arrInstance, fx.targetKind, fx.targetId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source_path: matchedPath, data: { matchedBy: 'llm' } });

    expect(hasEvent(fx.ctx.events.list({ level: 'attention' }), 'ingest.unmatched')).toBe(true);
  });

  it('foreign-file guard: the placement target already exists with no placed_files row -> ingest.skipped-foreign warn, content untouched', async () => {
    const fx = ingestFixture();
    writeFileSync(join(fx.torrentDir, 'Show - 05 [JPSC].ass'), 'new-content');
    const targetPath = join(fx.libraryDir, 'Show - S01E05.zh-Hans.ass');
    writeFileSync(targetPath, 'pre-existing-foreign-content');
    const job = claimIngestJob(fx);

    await runIngestJob(fx.ctx, job);

    expect(readFileSync(targetPath, 'utf-8')).toBe('pre-existing-foreign-content');
    expect(fx.ctx.events.list({ level: 'warn' }).filter((e) => e.kind === 'ingest.skipped-foreign')).toHaveLength(1);
    expect(new PlacedFiles(fx.ctx.db).listByTarget(fx.arrInstance, fx.targetKind, fx.targetId)).toHaveLength(0);
  });

  it('collision guard: two sidecars resolving to the same target path never clobber each other — the first stays, the second is skipped with a warn event', async () => {
    const fx = ingestFixture();
    const firstSource = join(fx.torrentDir, 'AAA - 05.srt'); // sorts first — walkFiles processes it first
    const secondSource = join(fx.torrentDir, 'ZZZ - 05.srt'); // same episode, same (lang-less) target name
    writeFileSync(firstSource, 'first-content');
    writeFileSync(secondSource, 'second-content');
    const job = claimIngestJob(fx);

    await runIngestJob(fx.ctx, job);

    const targetPath = join(fx.libraryDir, 'Show - S01E05.srt');
    expect(readFileSync(targetPath, 'utf-8')).toBe('first-content');

    const rows = new PlacedFiles(fx.ctx.db).listByTarget(fx.arrInstance, fx.targetKind, fx.targetId);
    const targetRows = rows.filter((r) => r.placed_path === targetPath);
    expect(targetRows).toHaveLength(1);
    expect(targetRows[0]).toMatchObject({ source_path: firstSource });

    expect(fx.ctx.events.list({ level: 'warn' }).filter((e) => e.kind === 'ingest.skipped-collision')).toHaveLength(1);
  });

  it('collision guard is conservative even once the old claimant source has vanished: a second sidecar targeting the same slot is still skipped, not allowed to overwrite it', async () => {
    const fx = ingestFixture();
    const placedFiles = new PlacedFiles(fx.ctx.db);
    const targetPath = join(fx.libraryDir, 'Show - S01E05.srt');
    const vanishedSource = join(fx.torrentDir, 'vanished-source.srt'); // deliberately never written to disk
    writeFileSync(targetPath, 'human-edited-or-prior-content');
    placedFiles.upsert({
      arrInstance: fx.arrInstance,
      targetKind: fx.targetKind,
      targetId: fx.targetId,
      kind: 'subtitle',
      placedPath: targetPath,
      videoPath: fx.videoPath,
      sourcePath: vanishedSource, // its own source no longer exists
    });

    const newSource = join(fx.torrentDir, 'New Source - 05.srt');
    writeFileSync(newSource, 'new-content');
    const job = claimIngestJob(fx);

    await runIngestJob(fx.ctx, job);

    // Nothing was overwritten, and the row still claims the old (now-vanished) source —
    // we can no longer re-derive what we'd be replacing, so we never touch the slot.
    expect(readFileSync(targetPath, 'utf-8')).toBe('human-edited-or-prior-content');
    expect(placedFiles.findByPlacedPath(targetPath)).toMatchObject({ source_path: vanishedSource });
    expect(fx.ctx.events.list({ level: 'warn' }).filter((e) => e.kind === 'ingest.skipped-collision')).toHaveLength(1);
  });

  it('restore: a placed file removed from the library (video intact) is restored from its recorded source WITHOUT re-matching — no second LLM call — and the row is refreshed', async () => {
    const fx = ingestFixture();
    // Deterministically-unmatchable on purpose: this must go through the LLM on the first
    // run, so a "restore" that's secretly falling through to full re-matching (instead of
    // genuinely restoring from the row) would need a SECOND LLM call — which the
    // single-response FakeGenerator below doesn't have, and would throw.
    const sourcePath = join(fx.torrentDir, 'Random Title - XYZ.ass');
    writeFileSync(sourcePath, 'subtitle-content');
    const llm = new FakeGenerator([{ assignments: [{ file: 1, episodeId: 1 }], reasoning: 'x' }]);
    fx.ctx.llm = llm;
    const job = claimIngestJob(fx);

    await runIngestJob(fx.ctx, job);
    expect(llm.calls).toHaveLength(1);
    const targetPath = join(fx.libraryDir, 'Show - S01E05.ass');
    expect(existsSync(targetPath)).toBe(true);
    const firstJobId = job.id;
    fx.ctx.queue.complete(job.id); // free the singleton slot so a second job can be claimed below

    // The placed file is removed by hand; its video and the provenance row are untouched.
    const before = new PlacedFiles(fx.ctx.db).findByPlacedPath(targetPath);
    expect(before).not.toBeNull();
    unlinkSync(targetPath);

    const job2 = claimIngestJob(fx); // a fresh job — proves the row's job_id gets refreshed too
    await runIngestJob(fx.ctx, job2);

    expect(llm.calls).toHaveLength(1); // still just the one call — restore never re-matched
    expect(existsSync(targetPath)).toBe(true);
    expect(readFileSync(targetPath, 'utf-8')).toBe('subtitle-content');
    expect(existsSync(sourcePath)).toBe(true); // source untouched by the restore

    const after = new PlacedFiles(fx.ctx.db).findByPlacedPath(targetPath);
    expect(after).not.toBeNull();
    expect(after!.job_id).toBe(job2.id);
    expect(after!.job_id).not.toBe(firstJobId);
  });

  it('idempotent re-run: placing twice records one row and makes no second LLM call (provenance short-circuit)', async () => {
    const fx = ingestFixture();
    const crypticPath = join(fx.torrentDir, 'Random Title - XYZ.ass');
    writeFileSync(crypticPath, 'sub');
    const llm = new FakeGenerator([{ assignments: [{ file: 1, episodeId: 1 }], reasoning: 'x' }]);
    fx.ctx.llm = llm;
    const job = claimIngestJob(fx);

    await runIngestJob(fx.ctx, job);
    await runIngestJob(fx.ctx, job); // re-run of the same job

    expect(llm.calls).toHaveLength(1); // the second run never re-invoked the LLM
    const rows = new PlacedFiles(fx.ctx.db).listByTarget(fx.arrInstance, fx.targetKind, fx.targetId);
    expect(rows).toHaveLength(1);
  });

  it('stale cleanup: a placed_files row whose video is gone has its file removed and row deleted; a row whose video still exists is untouched', async () => {
    const fx = ingestFixture();
    const placedFiles = new PlacedFiles(fx.ctx.db);

    const liveTarget = join(fx.libraryDir, 'Show - S01E05.zh-Hans.ass');
    writeFileSync(liveTarget, 'live');
    placedFiles.upsert({
      arrInstance: fx.arrInstance,
      targetKind: fx.targetKind,
      targetId: fx.targetId,
      kind: 'subtitle',
      placedPath: liveTarget,
      videoPath: fx.videoPath, // still exists
      sourcePath: join(fx.torrentDir, 'old-source.ass'),
    });

    const staleVideoPath = join(fx.libraryDir, 'Deleted Episode.mkv'); // never created
    const staleTarget = join(fx.libraryDir, 'Deleted Episode.ass');
    writeFileSync(staleTarget, 'stale');
    placedFiles.upsert({
      arrInstance: fx.arrInstance,
      targetKind: fx.targetKind,
      targetId: fx.targetId,
      kind: 'subtitle',
      placedPath: staleTarget,
      videoPath: staleVideoPath,
      sourcePath: join(fx.torrentDir, 'stale-source.ass'),
    });

    const job = claimIngestJob(fx);
    await runIngestJob(fx.ctx, job);

    expect(existsSync(liveTarget)).toBe(true);
    expect(placedFiles.findByPlacedPath(liveTarget)).not.toBeNull();

    expect(existsSync(staleTarget)).toBe(false);
    expect(placedFiles.findByPlacedPath(staleTarget)).toBeNull();

    expect(fx.ctx.events.list().filter((e) => e.kind === 'ingest.stale-cleaned')).toHaveLength(1);
  });

  it('stale cleanup mount discriminator: a video whose PARENT FOLDER is also missing (unmounted share) is deferred, not cleaned — the row and its placed file both survive', async () => {
    const fx = ingestFixture();
    const placedFiles = new PlacedFiles(fx.ctx.db);

    // The video's parent directory itself doesn't exist — indistinguishable from "the whole
    // NAS share isn't mounted right now" from cleanupStaleProvenance's point of view, so it
    // must never be read as "the video was deleted".
    const unmountedVideoPath = join(fx.libraryDir, 'unmounted-share', 'Ghost Episode.mkv');
    const placedUnderUnmounted = join(fx.libraryDir, 'unmounted-share', 'Ghost Episode.ass');
    placedFiles.upsert({
      arrInstance: fx.arrInstance,
      targetKind: fx.targetKind,
      targetId: fx.targetId,
      kind: 'subtitle',
      placedPath: placedUnderUnmounted,
      videoPath: unmountedVideoPath,
      sourcePath: join(fx.torrentDir, 'ghost-source.ass'),
    });

    const job = claimIngestJob(fx);
    await runIngestJob(fx.ctx, job);

    // Row survives untouched — nothing was deleted, nothing was even attempted.
    expect(placedFiles.findByPlacedPath(placedUnderUnmounted)).not.toBeNull();
    expect(fx.ctx.events.list().filter((e) => e.kind === 'ingest.stale-cleaned')).toHaveLength(0);
    expect(fx.ctx.events.list().filter((e) => e.kind === 'ingest.stale-clean-failed')).toHaveLength(0);

    const deferred = fx.ctx.events.list({ level: 'warn' }).filter((e) => e.kind === 'ingest.stale-clean-deferred');
    expect(deferred).toHaveLength(1);
    expect(deferred[0]!.data).toMatchObject({ instance: fx.arrInstance, targetKind: fx.targetKind, targetId: fx.targetId, count: 1 });
  });

  it('stale cleanup mount discriminator: several deferred rows in one run collapse into a single ingest.stale-clean-deferred event naming the count', async () => {
    const fx = ingestFixture();
    const placedFiles = new PlacedFiles(fx.ctx.db);

    for (let i = 0; i < 3; i++) {
      placedFiles.upsert({
        arrInstance: fx.arrInstance,
        targetKind: fx.targetKind,
        targetId: fx.targetId,
        kind: 'subtitle',
        placedPath: join(fx.libraryDir, 'unmounted-share', `Ghost ${i}.ass`),
        videoPath: join(fx.libraryDir, 'unmounted-share', `Ghost ${i}.mkv`),
        sourcePath: join(fx.torrentDir, `ghost-source-${i}.ass`),
      });
    }

    const job = claimIngestJob(fx);
    await runIngestJob(fx.ctx, job);

    const deferred = fx.ctx.events.list({ level: 'warn' }).filter((e) => e.kind === 'ingest.stale-clean-deferred');
    expect(deferred).toHaveLength(1);
    expect(deferred[0]!.data).toMatchObject({ count: 3 });
  });

  it('stale cleanup containment: one row failing to rmSync (EISDIR, not ENOENT) warns and keeps that row, but still cleans the next stale row', async () => {
    const fx = ingestFixture();
    const placedFiles = new PlacedFiles(fx.ctx.db);

    // Row 1: placed_path is actually a directory — rmSync throws EISDIR even with force:true
    // (force only suppresses a missing-path ENOENT, not a genuine "can't unlink this" error).
    const badPlacedPath = join(fx.libraryDir, 'not-actually-a-file');
    mkdirSync(badPlacedPath);
    placedFiles.upsert({
      arrInstance: fx.arrInstance,
      targetKind: fx.targetKind,
      targetId: fx.targetId,
      kind: 'subtitle',
      placedPath: badPlacedPath,
      videoPath: join(fx.libraryDir, 'Gone Episode 1.mkv'), // never created — stale
      sourcePath: join(fx.torrentDir, 'a.ass'),
    });

    // Row 2: an ordinary stale row — must still get cleaned up despite row 1's failure.
    const staleTarget2 = join(fx.libraryDir, 'Gone Episode 2.ass');
    writeFileSync(staleTarget2, 'stale');
    placedFiles.upsert({
      arrInstance: fx.arrInstance,
      targetKind: fx.targetKind,
      targetId: fx.targetId,
      kind: 'subtitle',
      placedPath: staleTarget2,
      videoPath: join(fx.libraryDir, 'Gone Episode 2.mkv'), // never created — stale
      sourcePath: join(fx.torrentDir, 'b.ass'),
    });

    const job = claimIngestJob(fx);
    await runIngestJob(fx.ctx, job);

    expect(fx.ctx.events.list({ level: 'warn' }).filter((e) => e.kind === 'ingest.stale-clean-failed')).toHaveLength(1);
    expect(placedFiles.findByPlacedPath(badPlacedPath)).not.toBeNull(); // kept for retry, not silently dropped

    expect(existsSync(staleTarget2)).toBe(false);
    expect(placedFiles.findByPlacedPath(staleTarget2)).toBeNull();
    expect(fx.ctx.events.list().filter((e) => e.kind === 'ingest.stale-cleaned')).toHaveLength(1);
  });

  it('ingest.place-failed containment: one placement failure (target dir missing) warns but does not stop the next sidecar from placing', async () => {
    const fx = ingestFixture();
    // A second episode whose file lives under a directory that's never created — atomicCopy
    // has nowhere to write, so placing anything matched to it must fail.
    const missingDirVideoPath = join(fx.libraryDir, 'nonexistent-subdir', 'Show - S01E06.mkv');
    fx.client.episodes.push(episodeResource({ id: 2, seriesId: fx.targetId, seasonNumber: 1, episodeNumber: 6, episodeFileId: 101, hasFile: true }));
    fx.client.episodeFiles.push({ id: 101, seriesId: fx.targetId, seasonNumber: 1, relativePath: 'Show - S01E06.mkv', path: missingDirVideoPath });

    writeFileSync(join(fx.torrentDir, 'Show - 06.ass'), 'sub-fail');
    writeFileSync(join(fx.torrentDir, 'Show - 05.ass'), 'sub-ok');
    const job = claimIngestJob(fx);

    await runIngestJob(fx.ctx, job);

    const warnEvents = fx.ctx.events.list({ level: 'warn' }).filter((e) => e.kind === 'ingest.place-failed');
    expect(warnEvents).toHaveLength(1);

    const succeededTarget = join(fx.libraryDir, 'Show - S01E05.ass');
    expect(existsSync(succeededTarget)).toBe(true);
    expect(readFileSync(succeededTarget, 'utf-8')).toBe('sub-ok');

    const rows = new PlacedFiles(fx.ctx.db).listByTarget(fx.arrInstance, fx.targetKind, fx.targetId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ placed_path: succeededTarget });
  });

  it('LLM contract: the sidecar-match prompt only ever includes hasFile:true episodes, never a hasFile:false one', async () => {
    const fx = ingestFixture({
      episodes: [
        episodeResource({ id: 1, seriesId: 42, seasonNumber: 1, episodeNumber: 5, episodeFileId: 100, hasFile: true }),
        episodeResource({ id: 2, seriesId: 42, seasonNumber: 1, episodeNumber: 6, episodeFileId: 0, hasFile: false }),
      ],
    });
    // No bare number at all -> deterministic can't place it against either episode list,
    // and it doesn't name a real (if fileless) episode either -> genuinely goes to the LLM.
    writeFileSync(join(fx.torrentDir, 'Random Title - XYZ.ass'), 'sub');
    const llm = new FakeGenerator([{ assignments: [{ file: 1, episodeId: 1 }], reasoning: 'x' }]);
    fx.ctx.llm = llm;
    const job = claimIngestJob(fx);

    await runIngestJob(fx.ctx, job);

    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.prompt).toContain('id=1 ');
    expect(llm.calls[0]!.prompt).not.toContain('id=2 ');
  });

  it('dedupes swept sidecar paths across nested source dirs — a parent dir and its own subdirectory both resolving as sweep roots must not double-place or double-list a file', async () => {
    const fx = ingestFixture();
    fx.ctx.config.ingest.downloadRoots = []; // force the no-configured-root dirname fallback for both entries below

    const nestedDir = join(fx.torrentDir, 'S1');
    mkdirSync(nestedDir, { recursive: true });
    const crypticPath = join(nestedDir, 'Random Title - XYZ.ass'); // deterministic-unmatchable -> LLM batch
    writeFileSync(crypticPath, 'sub');

    fx.client.seriesHistory = [
      {
        id: 1,
        seriesId: fx.targetId,
        eventType: 'downloadFolderImported',
        date: '',
        sourceTitle: 'x',
        data: { droppedPath: join(fx.torrentDir, 'e1.mkv') }, // dirname -> fx.torrentDir
      },
      {
        id: 2,
        seriesId: fx.targetId,
        eventType: 'downloadFolderImported',
        date: '',
        sourceTitle: 'x',
        data: { droppedPath: join(nestedDir, 'e2.mkv') }, // dirname -> nestedDir, INSIDE fx.torrentDir
      },
    ];

    const llm = new FakeGenerator([{ assignments: [{ file: 1, episodeId: 1 }], reasoning: 'x' }]);
    fx.ctx.llm = llm;
    const job = claimIngestJob(fx);

    await runIngestJob(fx.ctx, job);

    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.prompt).not.toContain('#2'); // one file listed, not the same file twice
    expect(fx.ctx.events.list().filter((e) => e.kind === 'ingest.placed')).toHaveLength(1);
    const rows = new PlacedFiles(fx.ctx.db).listByTarget(fx.arrInstance, fx.targetKind, fx.targetId);
    expect(rows).toHaveLength(1);
  });

  it('episode without file: a sidecar matches an episode with hasFile:false -> ingest.deferred info event, not placed, no LLM call', async () => {
    const fx = ingestFixture({
      episodes: [
        episodeResource({ id: 1, seriesId: 42, seasonNumber: 1, episodeNumber: 5, episodeFileId: 100, hasFile: true }),
        episodeResource({ id: 2, seriesId: 42, seasonNumber: 1, episodeNumber: 6, episodeFileId: 0, hasFile: false }),
      ],
    });
    writeFileSync(join(fx.torrentDir, 'Show - 06.ass'), 'sub');
    const llm = new FakeGenerator([]);
    fx.ctx.llm = llm;
    const job = claimIngestJob(fx);

    await runIngestJob(fx.ctx, job);

    expect(llm.calls).toHaveLength(0);
    expect(fx.ctx.events.list().filter((e) => e.kind === 'ingest.deferred')).toHaveLength(1);
    expect(new PlacedFiles(fx.ctx.db).listByTarget(fx.arrInstance, fx.targetKind, fx.targetId)).toHaveLength(0);
  });

  it('movie: sidecars map to the single listMovieFiles file with no episode matching and no LLM', async () => {
    const fx = ingestFixture({ targetKind: 'movie', targetId: 7, videoFileName: 'Movie.mkv' });
    writeFileSync(join(fx.torrentDir, 'Movie.zh-Hans.ass'), 'sub');
    const llm = new FakeGenerator([]);
    fx.ctx.llm = llm;
    const job = claimIngestJob(fx);

    await runIngestJob(fx.ctx, job);

    expect(llm.calls).toHaveLength(0);
    const expected = join(fx.libraryDir, 'Movie.zh-Hans.ass');
    expect(existsSync(expected)).toBe(true);
    const rows = new PlacedFiles(fx.ctx.db).listByTarget(fx.arrInstance, 'movie', 7);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ data: { matchedBy: 'deterministic' } });
  });
});

describe('runIngestJob — bundle & stuck-import rescue', () => {
  it('leftover bundle (series): two unresolved bundle videos resolve deterministically (confidence high) -> one copy-mode executeManualImport; ingest.rescued lists the mappings + reasoning + skipped', async () => {
    const fx = ingestFixture({
      episodes: [
        episodeResource({ id: 1, seriesId: 42, seasonNumber: 1, episodeNumber: 5, episodeFileId: 100, hasFile: true }),
        episodeResource({ id: 2, seriesId: 42, seasonNumber: 1, episodeNumber: 6, episodeFileId: 0, hasFile: false }),
        episodeResource({ id: 3, seriesId: 42, seasonNumber: 1, episodeNumber: 7, episodeFileId: 0, hasFile: false }),
      ],
    });
    // Bare-number filenames the sidecar sweep never touches (not a SIDECAR_EXTS
    // extension) — these are leftover episode VIDEOS the arr's manual-import queue is
    // still holding for this bundle folder.
    const item6 = manualImportItem({ path: '/downloads/Show/Show - 06.mkv', folderName: 'Show Torrent' });
    const item7 = manualImportItem({ path: '/downloads/Show/Show - 07.mkv', folderName: 'Show Torrent' });
    fx.client.manualImportByScope[`folder:${fx.torrentDir}`] = [item6, item7];
    const job = claimIngestJob(fx);

    await runIngestJob(fx.ctx, job);

    expect(fx.client.listManualImport).toHaveBeenCalledWith({ folder: fx.torrentDir, seriesId: fx.targetId, filterExistingFiles: true });
    expect(fx.client.executeManualImport).toHaveBeenCalledTimes(1);
    expect(fx.client.executeManualImport).toHaveBeenCalledWith(
      [
        expect.objectContaining({ path: item6.path, seriesId: fx.targetId, episodeIds: [2] }),
        expect.objectContaining({ path: item7.path, seriesId: fx.targetId, episodeIds: [3] }),
      ],
      'copy',
    );

    const rescued = findEvent(fx.ctx.events.list(), 'ingest.rescued');
    expect(rescued).toBeTruthy();
    expect(rescued!.data.skipped).toEqual([]);
    expect(rescued!.data.reasoning).toEqual(expect.any(String));
    expect(rescued!.data.files).toEqual([
      expect.objectContaining({ path: item6.path, episodeIds: [2] }),
      expect.objectContaining({ path: item7.path, episodeIds: [3] }),
    ]);
  });

  it('low confidence: an LLM confidence of low proposes an ingest.rescue-proposed attention item pinned to the bundle-import action payload; executeManualImport is never called; the job still completes', async () => {
    const fx = ingestFixture({
      episodes: [
        episodeResource({ id: 1, seriesId: 42, seasonNumber: 1, episodeNumber: 5, episodeFileId: 100, hasFile: true }),
        episodeResource({ id: 2, seriesId: 42, seasonNumber: 1, episodeNumber: 6, episodeFileId: 0, hasFile: false }),
      ],
    });
    const item = manualImportItem({ path: '/downloads/Show/Cryptic Name.mkv', folderName: 'Show Torrent' });
    fx.client.manualImportByScope[`folder:${fx.torrentDir}`] = [item];
    const llm = new FakeGenerator([bundleResponse({ mappings: [{ file: 1, episodeIds: [2] }], confidence: 'low', reasoning: 'guessing from context' })]);
    fx.ctx.llm = llm;
    const job = claimIngestJob(fx);

    await expect(runIngestJob(fx.ctx, job)).resolves.toBeUndefined();

    expect(fx.client.executeManualImport).not.toHaveBeenCalled();
    expect(hasEvent(fx.ctx.events.list(), 'ingest.rescued')).toBe(false);

    const proposed = fx.ctx.events.list({ level: 'attention' }).filter((e) => e.kind === 'ingest.rescue-proposed');
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.data).toEqual(
      bundleImportPayload({
        instance: fx.arrInstance,
        targetKind: fx.targetKind,
        targetId: fx.targetId,
        files: [expect.objectContaining({ path: item.path, episodeIds: [2] })],
        reasoning: 'guessing from context',
      }),
    );
  });

  it('stuck download (series): assessQueue -> stuck with a downloadId -> listManualImport({downloadId}) feeds the same planning path as a bundle folder', async () => {
    const fx = ingestFixture({
      episodes: [
        episodeResource({ id: 1, seriesId: 42, seasonNumber: 1, episodeNumber: 5, episodeFileId: 100, hasFile: true }),
        episodeResource({ id: 2, seriesId: 42, seasonNumber: 1, episodeNumber: 6, episodeFileId: 0, hasFile: false }),
      ],
    });
    fx.client.queue = [
      { id: 1, seriesId: fx.targetId, downloadId: 'dl-stuck-1', status: 'completed', trackedDownloadStatus: 'warning', title: 'x' },
    ];
    const item = manualImportItem({ path: '/downloads/Show/Show - 06.mkv', folderName: 'Show Torrent' });
    fx.client.manualImportByScope['downloadId:dl-stuck-1'] = [item];
    const job = claimIngestJob(fx);

    await runIngestJob(fx.ctx, job);

    expect(fx.client.listManualImport).toHaveBeenCalledWith({ downloadId: 'dl-stuck-1' });
    expect(fx.client.executeManualImport).toHaveBeenCalledWith([expect.objectContaining({ path: item.path, episodeIds: [2] })], 'copy');
    expect(hasEvent(fx.ctx.events.list(), 'ingest.rescued')).toBe(true);
  });

  it('dedupes manual-import items by path across the downloadId + folder scopes before planning: the same leftover file surfacing from both never double-imports', async () => {
    const fx = ingestFixture({
      episodes: [
        episodeResource({ id: 1, seriesId: 42, seasonNumber: 1, episodeNumber: 5, episodeFileId: 100, hasFile: true }),
        episodeResource({ id: 2, seriesId: 42, seasonNumber: 1, episodeNumber: 6, episodeFileId: 0, hasFile: false }),
      ],
    });
    fx.client.queue = [
      { id: 1, seriesId: fx.targetId, downloadId: 'dl-stuck-1', status: 'completed', trackedDownloadStatus: 'warning', title: 'x' },
    ];
    // The SAME physical file surfaces from both the stuck downloadId scope and the bundle
    // folder scope (the arr's own manual-import queue and a plain directory listing agree).
    const item = manualImportItem({ path: '/downloads/Show/Show - 06.mkv', folderName: 'Show Torrent' });
    fx.client.manualImportByScope['downloadId:dl-stuck-1'] = [item];
    fx.client.manualImportByScope[`folder:${fx.torrentDir}`] = [item];
    const job = claimIngestJob(fx);

    await runIngestJob(fx.ctx, job);

    expect(fx.client.executeManualImport).toHaveBeenCalledTimes(1);
    expect(fx.client.executeManualImport).toHaveBeenCalledWith([expect.objectContaining({ path: item.path, episodeIds: [2] })], 'copy');
  });

  it('folder-scope root gating: with no downloadRoots configured, the rescue stage never queries a folder scope (dirname-fallback dirs are excluded); the downloadId scope is still queried', async () => {
    const fx = ingestFixture({
      episodes: [
        episodeResource({ id: 1, seriesId: 42, seasonNumber: 1, episodeNumber: 5, episodeFileId: 100, hasFile: true }),
        episodeResource({ id: 2, seriesId: 42, seasonNumber: 1, episodeNumber: 6, episodeFileId: 0, hasFile: false }),
      ],
    });
    fx.ctx.config.ingest.downloadRoots = []; // forces the dirname() fallback for the sidecar sweep's own sourceDirsArr
    fx.client.queue = [
      { id: 1, seriesId: fx.targetId, downloadId: 'dl-stuck-1', status: 'completed', trackedDownloadStatus: 'warning', title: 'x' },
    ];
    const stuckItem = manualImportItem({ path: '/downloads/Show/Show - 06.mkv', folderName: 'Show Torrent' });
    fx.client.manualImportByScope['downloadId:dl-stuck-1'] = [stuckItem];
    // Seeded on a folder scope that must never be queried — if it were, this would ship too.
    fx.client.manualImportByScope[`folder:${fx.torrentDir}`] = [manualImportItem({ path: '/downloads/Show/Should Not Ship.mkv' })];
    const job = claimIngestJob(fx);

    await runIngestJob(fx.ctx, job);

    expect(fx.client.listManualImport).toHaveBeenCalledWith({ downloadId: 'dl-stuck-1' });
    expect(fx.client.listManualImport).not.toHaveBeenCalledWith(expect.objectContaining({ folder: expect.anything() }));
    expect(fx.client.executeManualImport).toHaveBeenCalledWith([expect.objectContaining({ path: stuckItem.path })], 'copy');
  });

  it('stuck download (movie): stuck items map 1:1 onto movieId with quality/languages/releaseGroup round-tripped, imported with no LLM call; a folder is never queried', async () => {
    // movieFiles: [] — an unoccupied movie, so the occupied-guard below doesn't intercept it.
    const fx = ingestFixture({ targetKind: 'movie', targetId: 7, videoFileName: 'Movie.mkv', movieFiles: [] });
    fx.client.queue = [{ id: 1, movieId: 7, downloadId: 'dl-movie-1', status: 'completed', trackedDownloadStatus: 'warning', title: 'x' }];
    const quality = { quality: { id: 3, name: 'Bluray-1080p' } };
    const languages = [{ id: 1, name: 'Japanese' }];
    const item = manualImportItem({
      path: '/downloads/Movie/Movie.mkv',
      folderName: 'Movie Torrent',
      quality,
      languages,
      releaseGroup: 'Group',
    });
    fx.client.manualImportByScope['downloadId:dl-movie-1'] = [item];
    const llm = new FakeGenerator([]);
    fx.ctx.llm = llm;
    const job = claimIngestJob(fx);

    await runIngestJob(fx.ctx, job);

    expect(llm.calls).toHaveLength(0);
    // Exactly one listManualImport call (the stuck downloadId) — a movie rescue never
    // queries a folder scope, so a leftover (non-stuck) movie-folder video can never
    // surface here at all.
    expect(fx.client.listManualImport).toHaveBeenCalledTimes(1);
    expect(fx.client.listManualImport).toHaveBeenCalledWith({ downloadId: 'dl-movie-1' });
    expect(fx.client.executeManualImport).toHaveBeenCalledWith(
      [{ path: item.path, folderName: item.folderName, movieId: 7, quality, languages, releaseGroup: item.releaseGroup }],
      'copy',
    );

    // Uniform event shape across branches: title in the message, skipped + reasoning in data.
    const rescued = findEvent(fx.ctx.events.list(), 'ingest.rescued');
    expect(rescued).toBeTruthy();
    expect(rescued!.message).toContain('Frieren'); // ingestFixture's default movie title
    expect(rescued!.data.skipped).toEqual([]);
    expect(rescued!.data.reasoning).toEqual(expect.any(String));
  });

  it('movie rescue filter: an item carrying a rejection is dropped, so the command carries only the clean file — and the drop is recorded in ingest.rescued\'s skipped', async () => {
    const fx = ingestFixture({ targetKind: 'movie', targetId: 7, videoFileName: 'Movie.mkv', movieFiles: [] });
    fx.client.queue = [{ id: 1, movieId: 7, downloadId: 'dl-movie-1', status: 'completed', trackedDownloadStatus: 'warning', title: 'x' }];
    const clean = manualImportItem({ path: '/downloads/Movie/Movie.mkv', folderName: 'Movie Torrent' });
    const rejected = manualImportItem({
      path: '/downloads/Movie/Sample.mkv',
      folderName: 'Movie Torrent',
      rejections: [{ reason: 'sample file' }],
    });
    fx.client.manualImportByScope['downloadId:dl-movie-1'] = [clean, rejected];
    const job = claimIngestJob(fx);

    await runIngestJob(fx.ctx, job);

    expect(fx.client.executeManualImport).toHaveBeenCalledTimes(1);
    expect(fx.client.executeManualImport).toHaveBeenCalledWith([expect.objectContaining({ path: clean.path })], 'copy');

    const rescued = findEvent(fx.ctx.events.list(), 'ingest.rescued');
    expect(rescued!.data.skipped).toEqual([rejected.path]);
  });

  it('movie rescue filter: an item whose item.movie names a DIFFERENT movie than the job target is dropped — and recorded in ingest.rescued\'s skipped', async () => {
    const fx = ingestFixture({ targetKind: 'movie', targetId: 7, videoFileName: 'Movie.mkv', movieFiles: [] });
    fx.client.queue = [{ id: 1, movieId: 7, downloadId: 'dl-movie-1', status: 'completed', trackedDownloadStatus: 'warning', title: 'x' }];
    const clean = manualImportItem({ path: '/downloads/Movie/Movie.mkv', folderName: 'Movie Torrent' });
    const otherMovie = manualImportItem({ path: '/downloads/Movie/Featurette.mkv', folderName: 'Movie Torrent', movie: { id: 999 } });
    fx.client.manualImportByScope['downloadId:dl-movie-1'] = [clean, otherMovie];
    const job = claimIngestJob(fx);

    await runIngestJob(fx.ctx, job);

    expect(fx.client.executeManualImport).toHaveBeenCalledTimes(1);
    expect(fx.client.executeManualImport).toHaveBeenCalledWith([expect.objectContaining({ path: clean.path })], 'copy');

    const rescued = findEvent(fx.ctx.events.list(), 'ingest.rescued');
    expect(rescued!.data.skipped).toEqual([otherMovie.path]);
  });

  it('movie rescue filter: when EVERY item is filtered out, an info ingest.rescue-skipped event names the dropped paths instead of the stage going silent', async () => {
    const fx = ingestFixture({ targetKind: 'movie', targetId: 7, videoFileName: 'Movie.mkv', movieFiles: [] });
    fx.client.queue = [{ id: 1, movieId: 7, downloadId: 'dl-movie-1', status: 'completed', trackedDownloadStatus: 'warning', title: 'x' }];
    const rejected = manualImportItem({
      path: '/downloads/Movie/Sample.mkv',
      folderName: 'Movie Torrent',
      rejections: [{ reason: 'sample file' }],
    });
    const otherMovie = manualImportItem({ path: '/downloads/Movie/Featurette.mkv', folderName: 'Movie Torrent', movie: { id: 999 } });
    fx.client.manualImportByScope['downloadId:dl-movie-1'] = [rejected, otherMovie];
    const job = claimIngestJob(fx);

    await runIngestJob(fx.ctx, job);

    expect(fx.client.executeManualImport).not.toHaveBeenCalled();
    expect(hasEvent(fx.ctx.events.list(), 'ingest.rescued')).toBe(false);
    expect(hasEvent(fx.ctx.events.list({ level: 'attention' }), 'ingest.rescue-proposed')).toBe(false);

    const skippedEvents = fx.ctx.events.list().filter((e) => e.kind === 'ingest.rescue-skipped');
    expect(skippedEvents).toHaveLength(1);
    expect(skippedEvents[0]!.level).toBe('info');
    expect(skippedEvents[0]!.data.skipped).toEqual(expect.arrayContaining([rejected.path, otherMovie.path]));
    expect((skippedEvents[0]!.data.skipped as string[]).length).toBe(2);
  });

  it('movie rescue multi-survivor guard: more than one item survives filtering -> proposes an ingest.rescue-proposed attention item instead of executing any of them', async () => {
    const fx = ingestFixture({ targetKind: 'movie', targetId: 7, videoFileName: 'Movie.mkv', movieFiles: [] });
    fx.client.queue = [{ id: 1, movieId: 7, downloadId: 'dl-movie-1', status: 'completed', trackedDownloadStatus: 'warning', title: 'x' }];
    const itemA = manualImportItem({ path: '/downloads/Movie/Movie.mkv', folderName: 'Movie Torrent' });
    const itemB = manualImportItem({ path: '/downloads/Movie/Movie.Alt.mkv', folderName: 'Movie Torrent' });
    fx.client.manualImportByScope['downloadId:dl-movie-1'] = [itemA, itemB];
    const job = claimIngestJob(fx);

    await runIngestJob(fx.ctx, job);

    expect(fx.client.executeManualImport).not.toHaveBeenCalled();
    expect(hasEvent(fx.ctx.events.list(), 'ingest.rescued')).toBe(false);

    const proposed = fx.ctx.events.list({ level: 'attention' }).filter((e) => e.kind === 'ingest.rescue-proposed');
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.data).toEqual(
      bundleImportPayload({
        instance: fx.arrInstance,
        files: [
          expect.objectContaining({ path: itemA.path }),
          expect.objectContaining({ path: itemB.path }),
        ],
        reasoning: expect.any(String),
      }),
    );
  });

  it("the producer's actual ingest.rescue-proposed payload parses through AcceptDataSchema — the two shapes can never silently drift apart", async () => {
    // Same fixture as app.test.ts's own accept-route tests (bundleImportPayload) guards
    // against the two sides drifting in the fixture itself; this test goes one step
    // further and feeds runIngestJob's REAL emitted event.data through the REAL schema
    // the accept route validates against, so a genuine shape mismatch fails here even if
    // both test files' fixtures happened to still agree with each other.
    const fx = ingestFixture({ targetKind: 'movie', targetId: 7, videoFileName: 'Movie.mkv', movieFiles: [] });
    fx.client.queue = [{ id: 1, movieId: 7, downloadId: 'dl-movie-1', status: 'completed', trackedDownloadStatus: 'warning', title: 'x' }];
    const itemA = manualImportItem({ path: '/downloads/Movie/Movie.mkv', folderName: 'Movie Torrent' });
    const itemB = manualImportItem({ path: '/downloads/Movie/Movie.Alt.mkv', folderName: 'Movie Torrent' });
    fx.client.manualImportByScope['downloadId:dl-movie-1'] = [itemA, itemB];
    const job = claimIngestJob(fx);

    await runIngestJob(fx.ctx, job);

    const proposed = findEvent(fx.ctx.events.list({ level: 'attention' }), 'ingest.rescue-proposed');
    const result = AcceptDataSchema.safeParse(proposed!.data);
    expect(result.success).toBe(true);
  });

  it('movie occupied-guard: a movie that already has a file on disk proposes an attention item instead of executing', async () => {
    // ingestFixture's default movieFiles seeds one entry — occupied.
    const fx = ingestFixture({ targetKind: 'movie', targetId: 7, videoFileName: 'Movie.mkv' });
    fx.client.queue = [{ id: 1, movieId: 7, downloadId: 'dl-movie-1', status: 'completed', trackedDownloadStatus: 'warning', title: 'x' }];
    const item = manualImportItem({ path: '/downloads/Movie/Movie.mkv', folderName: 'Movie Torrent' });
    fx.client.manualImportByScope['downloadId:dl-movie-1'] = [item];
    const job = claimIngestJob(fx);

    await runIngestJob(fx.ctx, job);

    expect(fx.client.executeManualImport).not.toHaveBeenCalled();
    const proposed = fx.ctx.events.list({ level: 'attention' }).filter((e) => e.kind === 'ingest.rescue-proposed');
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.data).toEqual(
      bundleImportPayload({
        instance: fx.arrInstance,
        files: [expect.objectContaining({ path: item.path })],
        reasoning: expect.any(String),
      }),
    );
  });

  it('movie occupied-guard breaks the re-execution loop: once the movie has a file (post-import), a lingering stuck record proposes instead of re-executing', async () => {
    const fx = ingestFixture({ targetKind: 'movie', targetId: 7, videoFileName: 'Movie.mkv', movieFiles: [] });
    fx.client.queue = [{ id: 1, movieId: 7, downloadId: 'dl-movie-1', status: 'completed', trackedDownloadStatus: 'warning', title: 'x' }];
    const item = manualImportItem({ path: '/downloads/Movie/Movie.mkv', folderName: 'Movie Torrent' });
    fx.client.manualImportByScope['downloadId:dl-movie-1'] = [item];

    const job1 = claimIngestJob(fx);
    await runIngestJob(fx.ctx, job1);
    expect(fx.client.executeManualImport).toHaveBeenCalledTimes(1); // unoccupied -> executed
    fx.ctx.queue.complete(job1.id); // free the singleton slot so a second job can be claimed below

    // The import landed: the movie now has a file. The arr's queue record for the same
    // download lingers (it hasn't cleared it yet), so the next run sees it as stuck again.
    fx.client.movieFiles.push({ id: 200, movieId: 7, relativePath: 'Movie.mkv', path: fx.videoPath });
    const job2 = claimIngestJob(fx);
    await runIngestJob(fx.ctx, job2);

    expect(fx.client.executeManualImport).toHaveBeenCalledTimes(1); // NOT re-executed
    const proposed = fx.ctx.events.list({ level: 'attention' }).filter((e) => e.kind === 'ingest.rescue-proposed');
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.data).toMatchObject({ action: 'bundle-import', instance: fx.arrInstance, targetKind: 'movie', targetId: 7 });
  });

  it('nothing leftover: listManualImport returns nothing for every scope -> no manual-import command, no attention, no rescue event noise', async () => {
    const fx = ingestFixture();
    const llm = new FakeGenerator([]);
    fx.ctx.llm = llm;
    const job = claimIngestJob(fx);

    await runIngestJob(fx.ctx, job);

    expect(llm.calls).toHaveLength(0);
    expect(fx.client.executeManualImport).not.toHaveBeenCalled();
    expect(fx.ctx.events.list().some((e) => e.kind.startsWith('ingest.rescue'))).toBe(false);
  });

  it('rescue failure containment: executeManualImport rejecting raises an ingest.rescue-failed warn event; sidecar placements from the same run survive, and the job completes', async () => {
    const fx = ingestFixture({
      episodes: [
        episodeResource({ id: 1, seriesId: 42, seasonNumber: 1, episodeNumber: 5, episodeFileId: 100, hasFile: true }),
        episodeResource({ id: 2, seriesId: 42, seasonNumber: 1, episodeNumber: 6, episodeFileId: 0, hasFile: false }),
      ],
    });
    // A sidecar for the ALREADY-imported episode — placed by the sweep stage, before the
    // rescue stage (which fails below) ever runs.
    writeFileSync(join(fx.torrentDir, 'Show - 05 [JPSC].ass'), 'subtitle-content');
    const item = manualImportItem({ path: '/downloads/Show/Show - 06.mkv', folderName: 'Show Torrent' });
    fx.client.manualImportByScope[`folder:${fx.torrentDir}`] = [item];
    fx.client.executeManualImport = vi.fn().mockRejectedValue(new Error('arr rejected the import'));
    const job = claimIngestJob(fx);

    await expect(runIngestJob(fx.ctx, job)).resolves.toBeUndefined();

    const warnEvents = fx.ctx.events.list({ level: 'warn' }).filter((e) => e.kind === 'ingest.rescue-failed');
    expect(warnEvents).toHaveLength(1);
    expect(hasEvent(fx.ctx.events.list(), 'ingest.rescued')).toBe(false);

    const placedTarget = join(fx.libraryDir, 'Show - S01E05.zh-Hans.ass');
    expect(existsSync(placedTarget)).toBe(true);
    const rows = new PlacedFiles(fx.ctx.db).listByTarget(fx.arrInstance, fx.targetKind, fx.targetId);
    expect(rows).toHaveLength(1);
  });
});

describe('runIngestJob — mapArrPath boundary', () => {
  // Deliberately NOT using ingestFixture() here: its pathMappings are identity
  // (from === to), so a bug that skipped mapArrPath entirely would still pass every other
  // test in this file. This test uses genuinely distinct arr-side vs. local roots so the
  // sidecar can only land in the real library dir if both mapArrPath call sites — the
  // dropped-path -> source-dir translation, and the episode-file -> video-path translation
  // — actually run.
  it('sweeps and places using real, distinct arr-side/local path mappings, not identity ones', async () => {
    const downloadsDir = tmpDir();
    const libraryDir = tmpDir();
    const torrentDir = join(downloadsDir, 'Show Torrent');
    mkdirSync(torrentDir, { recursive: true });

    const videoFileName = 'Show - S01E05.mkv';
    writeFileSync(join(libraryDir, videoFileName), 'video');
    writeFileSync(join(torrentDir, 'Show - 05 [JPSC].ass'), 'subtitle-content');

    // Arr-side paths — under roots that don't exist locally at all; only the configured
    // pathMappings below can bridge them to downloadsDir/libraryDir.
    const arrDroppedPath = '/data/dl/Show Torrent/Show - S01E05.mkv';
    const arrVideoPath = '/data/tv/Show - S01E05.mkv'; // directly under /data/tv, matching the local video's own placement directly under libraryDir

    const client = fakeArrClient({
      series: [seriesResource({ id: 42, title: 'Frieren' })],
      seriesHistory: [
        { id: 1, seriesId: 42, eventType: 'downloadFolderImported', date: '', sourceTitle: 'Show Torrent', data: { droppedPath: arrDroppedPath } },
      ],
      episodes: [episodeResource({ id: 1, seriesId: 42, seasonNumber: 1, episodeNumber: 5, episodeFileId: 100, hasFile: true })],
      episodeFiles: [{ id: 100, seriesId: 42, seasonNumber: 1, relativePath: videoFileName, path: arrVideoPath }],
    });

    const ctx = ctxWithClient('sonarr', client, { config: ConfigSchema.parse({
        pathMappings: [
          { from: '/data/dl', to: downloadsDir },
          { from: '/data/tv', to: libraryDir },
        ],
        ingest: { downloadRoots: ['/data/dl'] },
      }) });

    const job = enqueueAndClaim(ctx, { pipeline: 'ingest', targetKind: 'series', targetId: 42, arrInstance: 'sonarr' });
    await runIngestJob(ctx, job);

    const expected = join(libraryDir, 'Show - S01E05.zh-Hans.ass');
    expect(existsSync(expected)).toBe(true);
    expect(readFileSync(expected, 'utf-8')).toBe('subtitle-content');

    const rows = new PlacedFiles(ctx.db).listByTarget('sonarr', 'series', 42);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ video_path: join(libraryDir, videoFileName) });
  });
});
