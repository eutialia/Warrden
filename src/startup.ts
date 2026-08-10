import type { AppContext } from './context.js';
import { reconcile } from './reconcile/reconcile.js';
import { errorMessage } from './util/errors.js';

/** Resets any job left `running` by a crashed previous process so it's claimable again,
 * reporting how many (if any) via the event log. Meant to run once at startup, before the
 * runner starts polling: a process crash/restart while a job was in flight otherwise
 * leaves it wedged as `running` forever. */
export function reclaimAbandonedJobs(ctx: AppContext): void {
  const reclaimed = ctx.queue.reclaimAbandoned();
  if (reclaimed > 0) {
    ctx.events.append({
      kind: 'jobs.reclaimed',
      level: 'warn',
      message: `Reclaimed ${reclaimed} job(s) left "running" by a previous, presumably crashed, run`,
      data: { count: reclaimed },
    });
  }
}

/** Once a day is often enough to keep the event log inside its retention window. */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Trims the event log to `eventRetentionDays`, now and once a day after. Nothing else
 * deletes from that table, so without this it grows for the life of the install — and the
 * dashboard's per-day counters read it on every poll.
 *
 * A failed prune is reported and forgotten: it is housekeeping, and the next tick will try
 * again. Returns a stop function that clears the interval.
 */
export function scheduleEventPrune(ctx: AppContext): () => void {
  const runOnce = (): void => {
    try {
      const removed = ctx.events.prune(ctx.config.eventRetentionDays);
      if (removed > 0) {
        ctx.events.append({
          kind: 'events.pruned',
          message: `Removed ${removed} event(s) older than ${ctx.config.eventRetentionDays} days`,
          data: { removed, retentionDays: ctx.config.eventRetentionDays },
        });
      }
    } catch (err) {
      ctx.events.append({
        kind: 'events.prune-failed',
        level: 'warn',
        message: `Could not trim the event log: ${errorMessage(err)}`,
      });
    }
  };

  runOnce();
  const interval = setInterval(runOnce, PRUNE_INTERVAL_MS);
  return () => clearInterval(interval);
}

/**
 * Runs `reconcile()` once immediately, then on `reconcileIntervalMinutes`. `reconcile`
 * already isolates per-instance failures internally, but this is the last-resort net for
 * anything that still escapes it (e.g. a `managed_objects`/`sync_state` query failing
 * outright) — reconciliation is background maintenance, never worth crashing the process
 * over. An overlap guard (mirroring `startRunner`'s `ticking` in `src/jobs/runner.ts`)
 * skips a scheduled tick that would otherwise fire while the previous pass is still
 * running — a slow pass against many/unreachable arr instances could otherwise overlap
 * with the next tick and run two reconciliation passes concurrently, doubling up on GC
 * bookkeeping and event volume for no benefit. Returns a stop function that clears the
 * interval.
 */
export function scheduleReconcile(ctx: AppContext): () => void {
  let running = false;

  const runOnce = (): void => {
    if (running) return;
    running = true;
    reconcile(ctx)
      .catch((err: unknown) => {
        ctx.events.append({
          kind: 'reconcile.crashed',
          level: 'warn',
          message: `Reconciliation pass threw unexpectedly: ${errorMessage(err)}`,
        });
      })
      .finally(() => {
        running = false;
      });
  };

  runOnce();
  const interval = setInterval(runOnce, ctx.config.reconcileIntervalMinutes * 60_000);
  return () => clearInterval(interval);
}
