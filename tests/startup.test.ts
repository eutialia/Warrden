import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { reclaimAbandonedJobs, scheduleEventPrune, scheduleReconcile } from '../src/startup.js';
import { TraceEntries } from '../src/db/traceEntries.js';
import { makeCtx, configWithArrs, fakeArrClient, ctxWithClient, hasEvent } from './helpers.js';

describe('reclaimAbandonedJobs', () => {
  it('reclaim called on boot makes a wedged running job claimable again, and reports it via an event', () => {
    const ctx = makeCtx();
    ctx.queue.enqueue({ pipeline: 'acquire', targetKind: 'series', targetId: 1, arrInstance: 'sonarr' });
    ctx.queue.claim(); // -> running; simulate a crash: nothing ever calls complete()/fail()
    expect(ctx.queue.claim()).toBeNull(); // wedged: no pending job left to claim

    reclaimAbandonedJobs(ctx);

    expect(ctx.queue.claim()).not.toBeNull(); // claimable again after reclaim
    expect(hasEvent(ctx.events.list(), 'jobs.reclaimed')).toBe(true);
  });

  it('is silent (no event) when nothing needed reclaiming', () => {
    const ctx = makeCtx();
    reclaimAbandonedJobs(ctx);
    expect(ctx.events.list()).toHaveLength(0);
  });
});

describe('scheduleEventPrune', () => {
  it('also prunes traces past retention and reports it via an event', () => {
    const ctx = makeCtx();
    new TraceEntries(ctx.db).append({
      jobId: 1,
      kind: 'a',
      summary: 'old',
      tsStart: Date.now() - 8 * 24 * 3600 * 1000,
    });

    const stop = scheduleEventPrune(ctx);
    stop();

    expect(new TraceEntries(ctx.db).listByJob(1)).toHaveLength(0);
    expect(hasEvent(ctx.events.list(), 'traces.pruned')).toBe(true);
  });
});

describe('scheduleReconcile', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs once immediately, then on the configured interval', async () => {
    const client = fakeArrClient({ series: [] });
    client.listSeries = vi.fn(async () => []);
    const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });
    ctx.config.reconcileIntervalMinutes = 1;

    const stop = scheduleReconcile(ctx);
    await vi.advanceTimersByTimeAsync(0); // let the immediate call's promise chain settle
    expect(client.listSeries).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.listSeries).toHaveBeenCalledTimes(2);

    stop();
  });

  it('picks up a new interval from a live config save — the next tick is armed off the current value, not the one it started with', async () => {
    const client = fakeArrClient({ series: [] });
    client.listSeries = vi.fn(async () => []);
    const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });
    ctx.config.reconcileIntervalMinutes = 1;

    const stop = scheduleReconcile(ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.listSeries).toHaveBeenCalledTimes(1);

    // Exactly what a config PUT does: swaps ctx.config wholesale (see applyConfig).
    ctx.config = { ...ctx.config, reconcileIntervalMinutes: 5 };

    await vi.advanceTimersByTimeAsync(60_000); // the tick already armed at the old 1min still fires
    expect(client.listSeries).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60_000); // ...but the next one is armed at 5min now
    expect(client.listSeries).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(client.listSeries).toHaveBeenCalledTimes(3);

    stop();
  });

  it('skips an overlapping tick while the previous pass is still running (mirrors startRunner\'s ticking guard)', async () => {
    let releaseFirstPass: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirstPass = resolve;
    });
    let calls = 0;
    const client = fakeArrClient();
    client.listSeries = vi.fn(async () => {
      calls++;
      if (calls === 1) await gate; // the first pass hangs until released
      return [];
    });
    const ctx = ctxWithClient('sonarr', client, { config: configWithArrs('sonarr') });
    ctx.config.reconcileIntervalMinutes = 1;

    const stop = scheduleReconcile(ctx);
    await vi.advanceTimersByTimeAsync(0); // kicks off the first (hanging) pass
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000); // a scheduled tick fires while the first is still in flight
    expect(calls).toBe(1); // guard skipped it — still 1, not 2

    releaseFirstPass();
    await vi.advanceTimersByTimeAsync(0); // let the first pass actually finish
    await vi.advanceTimersByTimeAsync(60_000); // now the next real tick runs
    expect(calls).toBe(2);

    stop();
  });
});
