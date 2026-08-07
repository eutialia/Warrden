import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RescheduleError } from '../src/jobs/errors.js';
import { startRunner } from '../src/jobs/runner.js';
import { makeCtx, hasEvent } from './helpers.js';

const target = { pipeline: 'acquire' as const, targetKind: 'series' as const, targetId: 1, arrInstance: 'sonarr' };

describe('startRunner', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('dispatches a claimed job to its pipeline handler and completes it on success', async () => {
    const ctx = makeCtx();
    const { id } = ctx.queue.enqueue(target);
    const handler = vi.fn().mockResolvedValue(undefined);
    const stop = startRunner(ctx, { acquire: handler }, { intervalMs: 10 });

    await vi.advanceTimersByTimeAsync(10);
    stop();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][1]).toMatchObject({ id, pipeline: 'acquire' });
    expect(ctx.queue.get(id!)!.status).toBe('done');
  });

  it('fails the job and appends only a warn event when the failure will still be retried', async () => {
    const ctx = makeCtx();
    ctx.queue.enqueue(target);
    const handler = vi.fn().mockRejectedValue(new Error('kaboom'));
    const stop = startRunner(ctx, { acquire: handler }, { intervalMs: 10 });

    await vi.advanceTimersByTimeAsync(10);
    stop();

    const warnEvents = ctx.events.list({ level: 'warn' });
    expect(warnEvents).toHaveLength(1);
    expect(warnEvents[0]!.message).toContain('kaboom');
    expect(ctx.events.list({ level: 'attention' })).toHaveLength(0);
  });

  it('appends an attention event once the failure is terminal (max attempts exhausted)', async () => {
    const ctx = makeCtx();
    const { id } = ctx.queue.enqueue(target);
    // Default maxAttempts is 3 — pre-seed attempts=2 so this run's failure is the final one.
    ctx.db.prepare('UPDATE jobs SET attempts = 2 WHERE id = ?').run(id);
    const handler = vi.fn().mockRejectedValue(new Error('kaboom'));
    const stop = startRunner(ctx, { acquire: handler }, { intervalMs: 10 });

    await vi.advanceTimersByTimeAsync(10);
    stop();

    const attentionEvents = ctx.events.list({ level: 'attention' });
    expect(attentionEvents).toHaveLength(1);
    // Joins the target-dedupe protocol (targetEventData) — a JobRow always carries the
    // triple, so a target whose job keeps failing permanently collapses into one open row.
    expect(attentionEvents[0]!.data).toMatchObject({
      instance: 'sonarr',
      targetKind: 'series',
      targetId: 1,
      pipeline: 'acquire',
    });
    expect(ctx.queue.get(id!)!.status).toBe('failed');
  });

  it('fails a job immediately, with an attention-worthy message, when no handler is registered for its pipeline', async () => {
    const ctx = makeCtx();
    // A real pipeline name ('ingest'), just one the handler map below doesn't cover — the
    // same drift a stale db row (from before a pipeline rename/removal) would produce.
    ctx.queue.enqueue({ ...target, pipeline: 'ingest' });
    const stop = startRunner(ctx, { acquire: vi.fn() }, { intervalMs: 10 });

    await vi.advanceTimersByTimeAsync(10);
    stop();

    const warnEvents = ctx.events.list({ level: 'warn' });
    expect(warnEvents).toHaveLength(1);
    expect(warnEvents[0]!.message).toContain('ingest');
  });

  it('reschedules a job that throws RescheduleError: back to pending with a future not_before, attempts untouched, only a job.rescheduled info event', async () => {
    vi.setSystemTime(0); // pin the fake clock so the expected not_before below is exact, not a bound
    const ctx = makeCtx();
    const { id } = ctx.queue.enqueue(target);
    const handler = vi.fn().mockRejectedValue(new RescheduleError('waiting for settle', 5_000));
    const stop = startRunner(ctx, { acquire: handler }, { intervalMs: 10 });

    await vi.advanceTimersByTimeAsync(10); // tick fires at t=10, which is when reschedule() reads Date.now()
    stop();

    const job = ctx.queue.get(id!)!;
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(0);
    expect(job.not_before).toBe(10 + 5_000); // exact: claim-time (10) + err.delayMs (5_000), not some larger constant

    expect(ctx.events.list({ level: 'warn' })).toHaveLength(0);
    expect(ctx.events.list({ level: 'attention' })).toHaveLength(0);
    const infoEvents = ctx.events.list().filter((e) => e.kind === 'job.rescheduled');
    expect(infoEvents).toHaveLength(1);
    expect(infoEvents[0]!.level).toBe('info');
    expect(infoEvents[0]!.message).toContain('waiting for settle');
    expect(infoEvents[0]!.message).toContain('5s');
    expect(infoEvents[0]!.data).toMatchObject({ pipeline: 'acquire', delayMs: 5_000 });
  });

  it('a handler throwing a plain Error still takes the existing fail path, not reschedule', async () => {
    const ctx = makeCtx();
    const { id } = ctx.queue.enqueue(target);
    const handler = vi.fn().mockRejectedValue(new Error('kaboom'));
    const stop = startRunner(ctx, { acquire: handler }, { intervalMs: 10 });

    await vi.advanceTimersByTimeAsync(10);
    stop();

    expect(ctx.queue.get(id!)!.attempts).toBe(1);
    expect(hasEvent(ctx.events.list(), 'job.rescheduled')).toBe(false);
    expect(ctx.events.list({ level: 'warn' })).toHaveLength(1);
  });

  it('stop() halts further polling', async () => {
    const ctx = makeCtx();
    const handler = vi.fn().mockResolvedValue(undefined);
    const stop = startRunner(ctx, { acquire: handler }, { intervalMs: 10 });
    stop();

    ctx.queue.enqueue(target);
    await vi.advanceTimersByTimeAsync(50);

    expect(handler).not.toHaveBeenCalled();
  });
});
