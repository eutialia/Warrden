import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { PlacedFiles } from '../src/db/placedFiles.js';
import { RescheduleError } from '../src/jobs/errors.js';
import { runIngestJob, SETTLE_RETRY_MS, SETTLE_DEADLINE_MS, MOUNT_RETRY_MS } from '../src/pipelines/ingest/run.js';
import { enqueueAndClaim, episodeResource, FakeGenerator, ingestFixture, type IngestFixture } from './helpers.js';

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
    expect(fx.ctx.events.list().some((e) => e.kind === 'ingest.placed')).toBe(false);
  });

  it('settle deadline: created_at older than SETTLE_DEADLINE_MS -> completes with an ingest.settle-timeout attention event, nothing swept', async () => {
    const fx = ingestFixture();
    fx.client.queue = [{ id: 1, seriesId: fx.targetId, status: 'completed', trackedDownloadState: 'importing', title: 'x' }];
    writeFileSync(join(fx.torrentDir, 'Show - 05 [JPSC].ass'), 'sub');
    const job = claimIngestJob(fx);
    fx.ctx.db.prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run(Date.now() - SETTLE_DEADLINE_MS - 1_000, job.id);
    const staleJob = fx.ctx.queue.get(job.id)!;

    await expect(runIngestJob(fx.ctx, staleJob)).resolves.toBeUndefined();

    expect(fx.ctx.events.list({ level: 'attention' }).some((e) => e.kind === 'ingest.settle-timeout')).toBe(true);
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

    expect(fx.ctx.events.list({ level: 'attention' }).some((e) => e.kind === 'ingest.mount-missing')).toBe(true);
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

    expect(fx.ctx.events.list({ level: 'attention' }).some((e) => e.kind === 'ingest.unmatched')).toBe(true);
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
