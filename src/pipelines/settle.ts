import type { ArrApi } from '../arr/types.js';
import type { AppContext } from '../context.js';
import { targetEventData } from '../events/target.js';
import { RescheduleError } from '../jobs/errors.js';
import type { JobRow } from '../jobs/queue.js';
import { assessQueue, type QueueAssessment } from './queueState.js';

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

/**
 * The wait both pipelines open a run with: an arr that is still moving this target's files
 * has neither the library nor the queue in the state either pipeline reconciles against, so
 * acting on it imports twice (ingest) or hunts for episodes that are seconds from existing
 * (subtitle).
 *
 * Returns the queue assessment when the caller may proceed — ingest reads its `'stuck'`
 * verdict for its own dwell branch and hands it to the rescue stage — or `null` when the
 * deadline has passed and the caller must stop without doing anything, a human now owning
 * it. A `busy` verdict inside the deadline throws `RescheduleError`, which is not a retry:
 * the runner never counts it against `attempts`, so `SETTLE_DEADLINE_MS` against
 * `job.created_at` is the only thing bounding the wait.
 *
 * Shared by ingest and subtitle so the two can't drift on the settle semantics; `scope`
 * supplies the only pipeline-specific parts, the event kind's prefix and what the timeout
 * message says the wait was blocking.
 */
export async function settleGate(
  ctx: AppContext,
  job: JobRow,
  client: ArrApi,
  scope: 'ingest' | 'subtitle',
): Promise<QueueAssessment | null> {
  const assessment = assessQueue(await client.listQueue(), { kind: job.target_kind, id: job.target_id });
  if (assessment.state !== 'busy') return assessment;

  if (Date.now() - job.created_at > SETTLE_DEADLINE_MS) {
    ctx.events.append({
      kind: `${scope}.settle-timeout`,
      level: 'attention',
      jobId: job.id,
      message: `Gave up waiting for Sonarr/Radarr to finish importing${scope === 'ingest' ? '' : ' before searching for subtitles'} (still busy after ${Math.round(SETTLE_DEADLINE_MS / 3_600_000)}h) — check the download queue there`,
      data: targetEventData(job),
    });
    return null;
  }

  ctx.trace.event({ jobId: job.id, kind: 'pipeline.wait', summary: 'waiting for arr import to settle' });
  throw new RescheduleError('arr still importing this target', SETTLE_RETRY_MS);
}
