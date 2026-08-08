import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleWebhook } from '../src/arr/webhooks.js';
import { PlacedFiles } from '../src/db/placedFiles.js';
import { startRunner } from '../src/jobs/runner.js';
import { runAcquireJob } from '../src/pipelines/acquire/run.js';
import { runIngestJob } from '../src/pipelines/ingest/run.js';
import { runSubtitleJob } from '../src/pipelines/subtitle/run.js';
import { FakeMediaTools, ingestFixture } from './helpers.js';

// Same handler map shape src/index.ts wires the real runner with — a unit test against
// runIngestJob directly (as every other ingest-run.test.ts case does) can't catch a
// wiring bug in that map itself (a typo'd pipeline key, the wrong function bound to it);
// only exercising the actual handler-map shape end to end can.
const REAL_HANDLERS = { acquire: runAcquireJob, ingest: runIngestJob, subtitle: runSubtitleJob };

describe('end-to-end: webhook -> queue -> runner -> ingest', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a Download webhook enqueues an ingest job that the real runner (real handler map) picks up and runs, placing a sidecar', async () => {
    const fx = ingestFixture();
    // A real context always has MediaTools wired; the subtitle follow-on job this ingest
    // enqueues needs it (its reconcile probes the video for embedded tracks). Without it the
    // runner would fail the subtitle job the moment it runs.
    fx.ctx.media = new FakeMediaTools();
    // The sidecar the ingest sweep will find and place.
    writeFileSync(join(fx.torrentDir, 'Show - 05 [JPSC].ass'), 'subtitle-content');

    const result = handleWebhook(fx.ctx, fx.arrInstance, {
      eventType: 'Download',
      series: { id: fx.targetId, title: 'Frieren' },
      isUpgrade: false,
      downloadId: 'dl-1',
    });
    expect(result.handled).toBe(true);
    expect(fx.ctx.queue.list()).toMatchObject([{ pipeline: 'ingest', target_kind: 'series', target_id: fx.targetId, status: 'pending' }]);

    const stop = startRunner(fx.ctx, REAL_HANDLERS, { intervalMs: 10 });
    try {
      await vi.advanceTimersByTimeAsync(20);
    } finally {
      stop();
    }

    // The ingest job runs to done, then its series follow-on subtitle job runs too — the
    // subtitle runner finds nothing missing (the sidecar sweep already placed zh-Hans) and
    // completes as a no-op. Two jobs, both done.
    expect(fx.ctx.queue.list()).toMatchObject([{ status: 'done' }, { status: 'done' }]);
    const rows = new PlacedFiles(fx.ctx.db).listByTarget(fx.arrInstance, fx.targetKind, fx.targetId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ placed_path: join(fx.libraryDir, 'Show - S01E05.zh-Hans.ass') });
  });
});
