import type { Config } from '../config/schema.js';

/**
 * How long an automatic subtitle trigger waits before the job is claimable, in ms.
 *
 * The queue is the debouncer: `enqueue` resets a pending twin's `not_before` to the newest
 * trigger's value, and `complete` parks a dirty requeue the same distance out, so a burst of
 * ingest follow-ups (four season imports plus reconcile's re-enqueues) collapses into one
 * run on the trailing edge instead of one browser session each. Only the automatic triggers
 * pass it; a human waiting on a manual run or an attention retry gets their job immediately.
 */
export function subtitleDebounceMs(config: Config): number {
  return config.subtitle.debounceMinutes * 60_000;
}
