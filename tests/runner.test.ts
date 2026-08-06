import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RescheduleError } from '../src/jobs/errors.js';
import { startRunner } from '../src/jobs/runner.js';
import { makeCtx } from './helpers.js';

const target = { pipeline: 'noop', targetKind: 'series' as const, targetId: 1, arrInstance: 'sonarr' };

describe('startRunner', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('dispatches a claimed job to its pipeline handler and completes it on success', async () => {
    const ctx = makeCtx();
    const { id } = ctx.queue.enqueue(target);
    const handler = vi.fn().mockResolvedValue(undefined);
    const stop = startRunner(ctx, { noop: handler }, { intervalMs: 10 });

    await vi.advanceTimersByTimeAsync(10);
    stop();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][1]).toMatchObject({ id, pipeline: 'noop' });
    expect(ctx.queue.get(id!)!.status).toBe('done');
  });

  it('fails the job and appends only a warn event when the failure will still be retried', async () => {
    const ctx = makeCtx();
    ctx.queue.enqueue(target);
    const handler = vi.fn().mockRejectedValue(new Error('kaboom'));
    const stop = startRunner(ctx, { noop: handler }, { intervalMs: 10 });

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
    const stop = startRunner(ctx, { noop: handler }, { intervalMs: 10 });

    await vi.advanceTimersByTimeAsync(10);
    stop();

    expect(ctx.events.list({ level: 'attention' })).toHaveLength(1);
    expect(ctx.queue.get(id!)!.status).toBe('failed');
  });

  it('fails a job immediately, with an attention-worthy message, when no handler is registered for its pipeline', async () => {
    const ctx = makeCtx();
    ctx.queue.enqueue({ ...target, pipeline: 'mystery' });
    const stop = startRunner(ctx, { noop: vi.fn() }, { intervalMs: 10 });

    await vi.advanceTimersByTimeAsync(10);
    stop();

    const warnEvents = ctx.events.list({ level: 'warn' });
    expect(warnEvents).toHaveLength(1);
    expect(warnEvents[0]!.message).toContain('mystery');
  });

  it('reschedules a job that throws RescheduleError: back to pending with a future not_before, attempts untouched, only a job.rescheduled info event', async () => {
    const ctx = makeCtx();
    const { id } = ctx.queue.enqueue(target);
    const handler = vi.fn().mockRejectedValue(new RescheduleError('waiting for settle', 5_000));
    const start = Date.now();
    const stop = startRunner(ctx, { noop: handler }, { intervalMs: 10 });

    await vi.advanceTimersByTimeAsync(10);
    stop();

    const job = ctx.queue.get(id!)!;
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(0);
    expect(job.not_before).toBeGreaterThanOrEqual(start + 5_000);

    expect(ctx.events.list({ level: 'warn' })).toHaveLength(0);
    expect(ctx.events.list({ level: 'attention' })).toHaveLength(0);
    const infoEvents = ctx.events.list().filter((e) => e.kind === 'job.rescheduled');
    expect(infoEvents).toHaveLength(1);
    expect(infoEvents[0]!.level).toBe('info');
    expect(infoEvents[0]!.message).toContain('waiting for settle');
    expect(infoEvents[0]!.message).toContain('5s');
  });

  it('a handler throwing a plain Error still takes the existing fail path, not reschedule', async () => {
    const ctx = makeCtx();
    const { id } = ctx.queue.enqueue(target);
    const handler = vi.fn().mockRejectedValue(new Error('kaboom'));
    const stop = startRunner(ctx, { noop: handler }, { intervalMs: 10 });

    await vi.advanceTimersByTimeAsync(10);
    stop();

    expect(ctx.queue.get(id!)!.attempts).toBe(1);
    expect(ctx.events.list().some((e) => e.kind === 'job.rescheduled')).toBe(false);
    expect(ctx.events.list({ level: 'warn' })).toHaveLength(1);
  });

  it('stop() halts further polling', async () => {
    const ctx = makeCtx();
    const handler = vi.fn().mockResolvedValue(undefined);
    const stop = startRunner(ctx, { noop: handler }, { intervalMs: 10 });
    stop();

    ctx.queue.enqueue(target);
    await vi.advanceTimersByTimeAsync(50);

    expect(handler).not.toHaveBeenCalled();
  });
});
