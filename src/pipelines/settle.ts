/**
 * How long a pipeline waits before re-checking an arr that is mid-import, and how long it
 * keeps doing that before giving up. Shared by ingest and subtitle: both gate on the same
 * `assessQueue` verdict against the same queue, so a divergence between their retry cadence
 * or their deadline would only ever be a bug.
 *
 * The deadline is what stops an unbounded wait: `RescheduleError` is not a retry, so the
 * runner never counts it against `attempts`, and a target the arr never finishes importing
 * would otherwise reschedule forever. It is measured against `job.created_at`.
 */
export const SETTLE_RETRY_MS = 2 * 60_000;
export const SETTLE_DEADLINE_MS = 24 * 60 * 60_000;
