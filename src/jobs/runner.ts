import type { AppContext } from '../context.js';
import { errorMessage } from '../util/errors.js';
import type { JobRow } from './queue.js';

export type JobHandler = (ctx: AppContext, job: JobRow) => Promise<void>;

const DEFAULT_INTERVAL_MS = 1000;

/**
 * Polls the job queue on an interval, claiming one pending job per tick and dispatching it
 * to the handler registered for its `pipeline`. A handler that resolves completes the job
 * via `queue.complete` — if that requeues a dirty twin, the queue already handled it, there's
 * nothing more for the runner to do. A handler that throws (or an unregistered pipeline) is
 * reported via `queue.fail`, which itself decides retry vs terminal failure: every failure
 * appends a `warn` event, and a terminal (non-retried) one additionally raises an `attention`
 * event so it surfaces on the dashboard instead of silently parking. Returns a stop function
 * that clears the interval.
 */
export function startRunner(ctx: AppContext, handlers: Record<string, JobHandler>, opts?: { intervalMs?: number }): () => void {
  let ticking = false;

  const tick = async (): Promise<void> => {
    if (ticking) return; // don't overlap ticks if a job outlives one interval
    ticking = true;
    try {
      const job = ctx.queue.claim();
      if (!job) return;

      const handler = handlers[job.pipeline];
      if (!handler) {
        failJob(ctx, job, `No handler registered for pipeline "${job.pipeline}"`);
        return;
      }

      try {
        await handler(ctx, job);
        ctx.queue.complete(job.id);
      } catch (err) {
        failJob(ctx, job, errorMessage(err));
      }
    } finally {
      ticking = false;
    }
  };

  const interval = setInterval(() => {
    // tick() only throws if a handler's own success path (queue.complete, or the fail()
    // call that follows a failed handler) throws too — vanishingly unlikely with a single
    // in-process runner, but left uncaught it would be an unhandled rejection that crashes
    // the process instead of just costing this one tick.
    tick().catch((err: unknown) => console.error('runner: tick failed unexpectedly', err));
  }, opts?.intervalMs ?? DEFAULT_INTERVAL_MS);
  return () => clearInterval(interval);
}

function failJob(ctx: AppContext, job: JobRow, message: string): void {
  const { retried } = ctx.queue.fail(job.id, message);
  ctx.events.append({
    kind: 'job.failed',
    level: 'warn',
    jobId: job.id,
    message: `Job #${job.id} (${job.pipeline}) failed: ${message}`,
    data: { pipeline: job.pipeline, retried },
  });
  if (!retried) {
    ctx.events.append({
      kind: 'job.attention',
      level: 'attention',
      jobId: job.id,
      message: `Job #${job.id} (${job.pipeline}) failed permanently: ${message}`,
      data: { pipeline: job.pipeline },
    });
  }
}
