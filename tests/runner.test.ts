import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AcquireRecords } from '../src/db/acquireRecords.js';
import { AttentionItems } from '../src/db/attention.js';
import { RescheduleError } from '../src/jobs/errors.js';
import { parseFailure } from './llmFixtures.js';
import { startRunner } from '../src/jobs/runner.js';
import { makeCtx, findEvent, hasEvent } from './helpers.js';

const target = { pipeline: 'acquire' as const, targetKind: 'series' as const, targetId: 1, arrInstance: 'sonarr' };

describe('startRunner', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('closes a clean run with one terminal event carrying its verdict and counts', async () => {
    const ctx = makeCtx();
    const { id } = ctx.queue.enqueue({ ...target, pipeline: 'subtitle' });
    const stop = startRunner(ctx, { subtitle: vi.fn().mockResolvedValue(undefined) }, { intervalMs: 10 });

    await vi.advanceTimersByTimeAsync(10);
    stop();

    const finished = ctx.events.list().filter((e) => e.kind === 'run.finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ job_id: id, level: 'info' });
    expect(finished[0]!.data).toMatchObject({
      scope: 'run',
      action: 'finished',
      // Nothing placed is not a failure and not a success: a quiet run gets no colour.
      facts: { pipeline: 'subtitle', counts: { placed: 0 } },
      verdict: { tone: 'neutral' },
    });
  });

  it('counts what an acquire run grabbed, from the rows the run itself wrote', async () => {
    const ctx = makeCtx();
    const { id } = ctx.queue.enqueue(target);
    const handler = vi.fn(async (c: typeof ctx, job: { created_at: number }) => {
      new AcquireRecords(c.db).insert({
        arrInstance: 'sonarr',
        targetKind: 'series',
        targetId: 1,
        source: 'webhook',
        status: 'grabbed',
        candidates: {},
      });
      expect(job.created_at).toBeTypeOf('number');
    });
    const stop = startRunner(ctx, { acquire: handler as never }, { intervalMs: 10 });

    await vi.advanceTimersByTimeAsync(10);
    stop();

    expect(findEvent(ctx.events.list(), 'run.finished')!.data).toMatchObject({
      facts: { pipeline: 'acquire', counts: { grabbed: 1 }, reason: 'grabbed' },
      verdict: { tone: 'success' },
    });
    expect(ctx.queue.get(id!)!.status).toBe('done');
  });

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

  it.each([
    { pipeline: 'subtitle' as const, debounced: true },
    { pipeline: 'acquire' as const, debounced: false },
  ])(
    '$pipeline: a twin that arrived mid-run is requeued debounced=$debounced — only the subtitle pipeline parks its requeue on the trailing edge',
    async ({ pipeline, debounced }) => {
      const ctx = makeCtx();
      const debounceMs = ctx.config.subtitle.debounceMinutes * 60_000;
      expect(debounceMs).toBeGreaterThan(0); // schema default; a 0 here would make this test vacuous
      const first = ctx.queue.enqueue({ ...target, pipeline });
      // A duplicate trigger landing while the run is in flight is what sets `dirty`.
      const handler = vi.fn(async () => {
        ctx.queue.enqueue({ ...target, pipeline });
      });
      const stop = startRunner(ctx, { [pipeline]: handler }, { intervalMs: 10 });

      await vi.advanceTimersByTimeAsync(10);
      stop();

      expect(ctx.queue.get(first.id!)!.status).toBe('done');
      const requeued = ctx.queue.list().find((j) => j.status === 'pending')!;
      expect(requeued).toBeDefined();
      expect(requeued.not_before).toBe(debounced ? Date.now() + debounceMs : 0);
    },
  );

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

  it('two different pipelines failing permanently for the SAME target open two separate attention rows, not one collapsed row (job.attention\'s kind is constant across pipelines, so dedupeKey has to scope by pipeline)', async () => {
    const ctx = makeCtx();
    const { id: acquireId } = ctx.queue.enqueue(target);
    ctx.db.prepare('UPDATE jobs SET attempts = 2 WHERE id = ?').run(acquireId);
    const { id: ingestId } = ctx.queue.enqueue({ ...target, pipeline: 'ingest' });
    ctx.db.prepare('UPDATE jobs SET attempts = 2 WHERE id = ?').run(ingestId);

    const handler = vi.fn().mockRejectedValue(new Error('kaboom'));
    const stop = startRunner(ctx, { acquire: handler, ingest: handler }, { intervalMs: 10 });

    await vi.advanceTimersByTimeAsync(20); // two ticks — one job claimed per tick
    stop();

    const attentionEvents = ctx.events.list({ level: 'attention' });
    expect(attentionEvents).toHaveLength(2);

    const openRows = new AttentionItems(ctx.db).list({ status: 'open' }).filter((r) => r.kind === 'job.attention');
    expect(openRows).toHaveLength(2);
    expect(ctx.queue.get(acquireId!)!.status).toBe('failed');
    expect(ctx.queue.get(ingestId!)!.status).toBe('failed');
  });

  it('fails a permanently-marked error terminally on the first attempt, without burning the remaining retries', async () => {
    const ctx = makeCtx();
    const { id } = ctx.queue.enqueue(target);
    // Duck-typed marker, exactly how `LlmError` carries it: the runner must not need to
    // know which layer produced the error to honour it.
    const handler = vi.fn().mockRejectedValue(Object.assign(new Error('invalid request'), { permanent: true }));
    const stop = startRunner(ctx, { acquire: handler }, { intervalMs: 10 });

    await vi.advanceTimersByTimeAsync(10);
    stop();

    const job = ctx.queue.get(id!)!;
    expect(job.status).toBe('failed');
    expect(job.attempts).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
    const attentionEvents = ctx.events.list({ level: 'attention' });
    expect(attentionEvents).toHaveLength(1);
    expect(findEvent(ctx.events.list({ level: 'warn' }), 'run.finished')!.data).toMatchObject({
      scope: 'run',
      action: 'finished',
      facts: { permanent: true, retried: false, error: 'invalid request' },
      verdict: { tone: 'danger' },
    });
  });

  // The single-shot call-sites (archive-map, sidecar-match, bundle-map, release-pick) throw
  // rather than returning a stop, so the runner is where their ending gets its words — and
  // they have to be the same words the agent's own rounds use.
  it('phrases a job failure with the stop vocabulary rather than the raw SDK error', async () => {
    const ctx = makeCtx();
    const { id } = ctx.queue.enqueue(target);
    const handler = vi.fn().mockRejectedValue(parseFailure());
    const stop = startRunner(ctx, { acquire: handler }, { intervalMs: 10 });

    await vi.advanceTimersByTimeAsync(10);
    stop();

    expect(findEvent(ctx.events.list({ level: 'warn' }), 'run.finished')!.message).toBe(
      `Job #${id} (acquire) failed: 1 reply was not valid JSON`,
    );
    expect(ctx.queue.get(id!)!.error).toBe('1 reply was not valid JSON');
  });

  it('keeps retrying an unmarked error, tagging the warn event as not permanent', async () => {
    const ctx = makeCtx();
    const { id } = ctx.queue.enqueue(target);
    const handler = vi.fn().mockRejectedValue(new Error('kaboom'));
    const stop = startRunner(ctx, { acquire: handler }, { intervalMs: 10 });

    await vi.advanceTimersByTimeAsync(10);
    stop();

    expect(ctx.queue.get(id!)!.status).toBe('pending');
    expect(findEvent(ctx.events.list({ level: 'warn' }), 'run.finished')!.data).toMatchObject({
      facts: { permanent: false, retried: true },
    });
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
    expect(infoEvents[0]!.data).toMatchObject({
      scope: 'run',
      action: 'rescheduled',
      facts: { pipeline: 'acquire', delayMs: 5_000, reason: 'waiting for settle', coalesceKey: `waits:${id}` },
    });
    // A reschedule is not an ending: the run has not concluded anything yet.
    expect(ctx.events.list().filter((e) => e.kind === 'run.finished')).toHaveLength(0);
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
