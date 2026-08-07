import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { reclaimAbandonedJobs, scheduleReconcile } from '../src/startup.js';
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
