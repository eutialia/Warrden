import { describeStop, stopFromError } from '../agent/stop.js';
import type { AppContext } from '../context.js';
import { eventEnvelope } from '../events/envelope.js';
import { targetEventData } from '../events/target.js';
import { firstSentence, reportRunFailed, reportRunFinished } from './finished.js';
import { subtitleDebounceMs } from './debounce.js';
import { RescheduleError } from './errors.js';
import type { JobRow, PipelineName } from './queue.js';

type JobHandler = (ctx: AppContext, job: JobRow) => Promise<void>;

const DEFAULT_INTERVAL_MS = 1000;

/** Human pipeline name for permanent-failure attention (never the raw enum). */
function pipelineLabel(pipeline: string): string {
  if (pipeline === 'acquire') return 'Release search';
  if (pipeline === 'ingest') return 'Import cleanup';
  if (pipeline === 'subtitle') return 'Subtitle search';
  return pipeline;
}

/**
 * Polls the job queue on an interval, claiming one pending job per tick and dispatching it
 * to the handler registered for its `pipeline`. A handler that resolves completes the job
 * via `queue.complete` — if that requeues a dirty twin, the queue already handled it, there's
 * nothing more for the runner to do. A handler that throws `RescheduleError` isn't failing —
 * it's saying "not done yet, try me again later" (e.g. the ingest pipeline's settle-wait) —
 * so it goes through `queue.reschedule` instead, with only an info-level `job.rescheduled`
 * event. Any other throw (or an unregistered pipeline) is reported via `queue.fail`, which
 * itself decides retry vs terminal failure: every failure appends a `warn` event, and a
 * terminal (non-retried) one additionally raises an `attention` event so it surfaces on the
 * dashboard instead of silently parking. Returns a stop function that clears the interval.
 *
 * Either ending — clean or thrown — closes with exactly one `run.finished` event carrying
 * the run's verdict and its counts (`src/jobs/finished.ts`). A rescheduled job is not an
 * ending and gets none.
 */
export function startRunner(
  ctx: AppContext,
  // `Partial` (not a fully-required `Record`) on purpose: `job.pipeline` is typed as
  // `PipelineName` everywhere a job gets enqueued, but a row already sitting in the db from
  // before a pipeline was renamed/removed isn't bound by that — the "no handler registered"
  // path right below exists specifically for that drift, so the caller must be allowed to
  // register a handler map that doesn't cover every `PipelineName`.
  handlers: Partial<Record<PipelineName, JobHandler>>,
  opts?: { intervalMs?: number },
): () => void {
  let ticking = false;

  const tick = async (): Promise<void> => {
    if (ticking) return; // don't overlap ticks if a job outlives one interval
    ticking = true;
    try {
      const job = ctx.queue.claim();
      if (!job) return;

      const handler = handlers[job.pipeline];
      if (!handler) {
        failJob(ctx, job, `No handler registered for pipeline "${job.pipeline}"`, false);
        return;
      }

      try {
        await handler(ctx, job);
        ctx.queue.complete(job.id, undefined, requeueOpts(ctx, job));
        reportRunFinished(ctx, job);
      } catch (err) {
        if (err instanceof RescheduleError) {
          ctx.queue.reschedule(job.id, err.delayMs);
          ctx.events.append({
            kind: 'job.rescheduled',
            jobId: job.id,
            message: `Job #${job.id} (${job.pipeline}) rescheduled in ${Math.round(err.delayMs / 1000)}s: ${err.message}`,
            data: eventEnvelope(
              {
                scope: 'run',
                action: 'rescheduled',
                // A settle-wait reschedules the same job every two minutes for as long as
                // the arr keeps importing. The rows stay individually stored (append-only,
                // and each one is a real thing that happened); a reader folds the burst on
                // this key into one line saying how many and how long.
                facts: {
                  pipeline: job.pipeline,
                  delayMs: err.delayMs,
                  reason: err.message,
                  coalesceKey: `waits:${job.id}`,
                },
              },
              targetEventData(job),
            ),
          });
          return;
        }
        const stop = stopFromError(err);
        failJob(ctx, job, describeStop(stop), stop.kind === 'error' && stop.permanent);
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

/** The trailing edge for a dirty twin `complete()` is about to requeue. Only the subtitle
 * pipeline debounces: a trigger that landed while a browser session was already running
 * deserves a fresh run, but not immediately after the one it raced — the imports that fired
 * it are usually still arriving. Every other pipeline requeues immediately, as before. */
function requeueOpts(ctx: AppContext, job: JobRow): { requeueNotBefore: number } | undefined {
  if (job.pipeline !== 'subtitle') return undefined;
  return { requeueNotBefore: Date.now() + subtitleDebounceMs(ctx.config) };
}

function failJob(ctx: AppContext, job: JobRow, message: string, permanent: boolean): void {
  // `maxAttempts: 1` makes this very attempt the last one: a permanent error (a provider
  // 4xx, a prompt the SDK refuses) fails identically on every retry, so the two extra runs
  // would only cost two more full indexer sweeps before landing on the same attention row.
  const { retried } = ctx.queue.fail(job.id, message, { ...(permanent ? { maxAttempts: 1 } : {}), ...requeueOpts(ctx, job) });
  reportRunFailed(ctx, job, message, { retried, permanent });
  if (!retried) {
    // Joins the target-dedupe protocol (`targetEventData`): a `JobRow` always carries the
    // `(arr_instance, target_kind, target_id)` triple, so a target whose job keeps failing
    // permanently across retries collapses into one open attention row instead of piling
    // up a new one per failed run. `dedupeKey: job.pipeline` is required, not cosmetic:
    // `kind` here is the constant `'job.attention'` regardless of which pipeline failed, so
    // without a per-pipeline discriminator an acquire and an ingest permanent failure for
    // the SAME target would collapse into one row, silently losing whichever one didn't
    // write last.
    ctx.events.append({
      kind: 'job.attention',
      level: 'attention',
      jobId: job.id,
      message: `${pipelineLabel(job.pipeline)} for this title failed permanently: ${message}`,
      data: eventEnvelope(
        {
          scope: 'run',
          action: 'attention',
          facts: { pipeline: job.pipeline, error: firstSentence(message) },
          verdict: { tone: 'danger' },
        },
        // `pipeline` stays at the top level too: `POST /api/attention/:id/retry` reads
        // `item.data.pipeline` to know which pipeline to re-enqueue, and the attention
        // mirror copies `data` verbatim.
        targetEventData(job, { pipeline: job.pipeline, dedupeKey: job.pipeline }),
      ),
    });
  }
}
