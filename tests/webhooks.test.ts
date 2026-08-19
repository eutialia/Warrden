import { describe, it, expect, vi } from 'vitest';
import { handleWebhook, INGEST_DEBOUNCE_MS } from '../src/arr/webhooks.js';
import { makeCtx, configWithArrs, fakeArrClient, withFakeTime } from './helpers.js';
import type { ArrApi } from '../src/arr/types.js';
import { TraceEntries } from '../src/db/traceEntries.js';

const seriesAdd = { eventType: 'SeriesAdd', series: { id: 42, title: 'Frieren', year: 2023, tvdbId: 424536 } };
const movieAdded = { eventType: 'MovieAdded', movie: { id: 7, title: 'Perfect Blue', year: 1997, tmdbId: 573 } };
const seriesDownload = { eventType: 'Download', series: { id: 42, title: 'Frieren' }, isUpgrade: false, downloadId: 'abc' };
const movieDownload = { eventType: 'Download', movie: { id: 7, title: 'Perfect Blue' }, isUpgrade: true, downloadId: 'def' };
// `downloadId` above is on the INCOMING payload, mimicking a real Sonarr/Radarr webhook
// body — it's parsed and then deliberately dropped: nothing reads it (see handleWebhook's
// own comment), so it must never end up on the job payload down below.

function knownArrsCtx() {
  return makeCtx({
    config: configWithArrs('sonarr', 'radarr'),
    clients: new Map<string, ArrApi>([
      ['sonarr', fakeArrClient()],
      ['radarr', fakeArrClient()],
    ]),
  });
}

describe('handleWebhook', () => {
  it.each([
    { name: 'sonarr SeriesAdd', instance: 'sonarr', payload: seriesAdd, targetKind: 'series', targetId: 42 },
    { name: 'radarr MovieAdded', instance: 'radarr', payload: movieAdded, targetKind: 'movie', targetId: 7 },
  ])('$name enqueues acquire', ({ instance, payload, targetKind, targetId }) => {
    const ctx = knownArrsCtx();
    expect(handleWebhook(ctx, instance, payload).handled).toBe(true);
    const job = ctx.queue.claim()!;
    expect(job).toMatchObject({ pipeline: 'acquire', target_kind: targetKind, target_id: targetId, arr_instance: instance });
  });

  it.each([
    { name: 'sonarr Download (new)', instance: 'sonarr', payload: seriesDownload, targetKind: 'series', targetId: 42, isUpgrade: false },
    { name: 'radarr Download (upgrade)', instance: 'radarr', payload: movieDownload, targetKind: 'movie', targetId: 7, isUpgrade: true },
  ])('$name enqueues ingest', ({ instance, payload, targetKind, targetId, isUpgrade }) => {
    const ctx = knownArrsCtx();
    const target = 'series' in payload ? payload.series : payload.movie;
    expect(handleWebhook(ctx, instance, payload).handled).toBe(true);
    // Not `claim()`: a Download enqueue's `not_before` is debounced INGEST_DEBOUNCE_MS into
    // the future (see below), so it isn't claimable yet; read the pending row back directly.
    const job = ctx.queue.list().find((j) => j.pipeline === 'ingest')!;
    expect(job).toMatchObject({ pipeline: 'ingest', target_kind: targetKind, target_id: targetId, arr_instance: instance, status: 'pending' });
    // No `downloadId` — the payload above carries one (mimicking a real webhook body), but
    // it's never read, so it must not survive onto the job payload. `isUpgrade` DOES ride
    // along: the subtitle pipeline reads it to decide whether an upgrade re-triggers sub
    // reconciliation, so it's part of the payload contract, not a webhook-only detail.
    expect(job.payload).toEqual({ title: target.title, isUpgrade });
    const events = ctx.events.list();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'webhook.received', job_id: job.id });
    expect(events[0]!.data).toMatchObject({ isUpgrade });
  });

  it('debounces a Download webhook\'s ingest enqueue by INGEST_DEBOUNCE_MS', () => {
    const ctx = knownArrsCtx();
    const now = Date.now();
    handleWebhook(ctx, 'sonarr', seriesDownload);
    const job = ctx.queue.list().find((j) => j.pipeline === 'ingest')!;
    expect(job.not_before).toBeGreaterThanOrEqual(now + INGEST_DEBOUNCE_MS - 1000);
  });

  it('coalesces a second Download webhook and pushes not_before forward, one run after the storm', () => {
    withFakeTime(() => {
      vi.setSystemTime(1_000);
      const ctx = knownArrsCtx();
      handleWebhook(ctx, 'sonarr', seriesDownload);
      const firstJob = ctx.queue.list().find((j) => j.pipeline === 'ingest')!;
      expect(firstJob.not_before).toBe(1_000 + INGEST_DEBOUNCE_MS);

      vi.setSystemTime(1_000 + 10_000); // a second Download webhook, 10 simulated seconds later
      expect(handleWebhook(ctx, 'sonarr', seriesDownload).handled).toBe(true);

      // events.list() is newest-first, so the second webhook's event is events[0].
      expect(ctx.events.list()[0]!.data).toMatchObject({ outcome: 'coalesced' });
      expect(ctx.queue.get(firstJob.id)!.not_before).toBe(1_000 + 10_000 + INGEST_DEBOUNCE_MS);
      expect(ctx.queue.list().filter((j) => j.pipeline === 'ingest')).toHaveLength(1);
    });
  });

  it('keeps not_before = 0 for a SeriesAdd acquire enqueue (no debounce outside Download)', () => {
    const ctx = knownArrsCtx();
    handleWebhook(ctx, 'sonarr', seriesAdd);
    const job = ctx.queue.list().find((j) => j.pipeline === 'acquire')!;
    expect(job.not_before).toBe(0);
  });

  it('ignores a Download event with neither series nor movie', () => {
    const ctx = knownArrsCtx();
    expect(handleWebhook(ctx, 'sonarr', { eventType: 'Download', isUpgrade: false })).toEqual({ handled: false, reason: 'ignored' });
    expect(ctx.queue.claim()).toBeNull();
  });

  it('acknowledges Test events without enqueueing', () => {
    const ctx = knownArrsCtx();
    expect(handleWebhook(ctx, 'sonarr', { eventType: 'Test' }).handled).toBe(true);
    expect(ctx.queue.claim()).toBeNull();
  });

  it('ignores unknown events and garbage payloads', () => {
    const ctx = knownArrsCtx();
    expect(handleWebhook(ctx, 'sonarr', { eventType: 'Rename' })).toEqual({ handled: false, reason: 'ignored' });
    expect(handleWebhook(ctx, 'sonarr', { nonsense: true })).toEqual({ handled: false, reason: 'ignored' });
    expect(ctx.queue.claim()).toBeNull();
  });

  it('rejects an instance with no registered client, even by default (no config, no clients)', () => {
    const ctx = makeCtx(); // default config: arrs: [], clients: {}
    expect(handleWebhook(ctx, 'sonarr', seriesAdd)).toEqual({ handled: false, reason: 'unknown instance' });
    expect(ctx.queue.claim()).toBeNull();
  });

  it('rejects an instance that is in config.arrs but has no ctx.clients entry — clients, not config, is authoritative (it is what the runner resolves against)', () => {
    const ctx = makeCtx({ config: configWithArrs('sonarr') }); // configured, but no client registered
    expect(handleWebhook(ctx, 'sonarr', seriesAdd)).toEqual({ handled: false, reason: 'unknown instance' });
    expect(ctx.queue.claim()).toBeNull();
  });

  it('carries the target title through as the acquire prompt hint', () => {
    const ctx = knownArrsCtx();
    handleWebhook(ctx, 'sonarr', seriesAdd);
    expect(ctx.queue.claim()!.payload).toEqual({ title: 'Frieren' });
  });

  it('appends an event carrying the job id and enqueue outcome', () => {
    const ctx = knownArrsCtx();
    handleWebhook(ctx, 'sonarr', seriesAdd);
    const job = ctx.queue.claim()!;
    const events = ctx.events.list();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'webhook.received', job_id: job.id });
    expect(events[0]!.data).toMatchObject({ outcome: 'enqueued' });
  });

  it('captures the webhook body as a trigger.webhook trace entry', () => {
    const ctx = knownArrsCtx();
    handleWebhook(ctx, 'sonarr', seriesAdd);
    const job = ctx.queue.claim()!;
    const rows = new TraceEntries(ctx.db).listByJob(job.id);
    expect(rows[0]).toMatchObject({ kind: 'trigger.webhook' });
    expect(JSON.parse(rows[0]!.payload ?? '')).toEqual(seriesAdd);
  });

  it('appends a second trigger entry to the coalesced job trace', () => {
    const ctx = knownArrsCtx();
    handleWebhook(ctx, 'sonarr', seriesAdd);
    handleWebhook(ctx, 'sonarr', seriesAdd);
    const job = ctx.queue.claim()!;
    const rows = new TraceEntries(ctx.db).listByJob(job.id);
    const triggerRows = rows.filter((r) => r.kind === 'trigger.webhook');
    expect(triggerRows).toHaveLength(2);
    expect(triggerRows[1]!.summary).toBe('SeriesAdd webhook (sonarr) (coalesced)');
  });

  it('writes no trigger entry when the enqueue only dirties a running twin', () => {
    const ctx = knownArrsCtx();
    handleWebhook(ctx, 'sonarr', seriesAdd);
    const job = ctx.queue.claim()!; // now running, so the second webhook can only mark it dirty
    const before = new TraceEntries(ctx.db).listByJob(job.id).length;

    handleWebhook(ctx, 'sonarr', seriesAdd);

    // The trigger will be served by the job `complete()` requeues later, which has no id
    // yet, so the running job's trace must not claim it.
    expect(new TraceEntries(ctx.db).listByJob(job.id)).toHaveLength(before);
  });
});
