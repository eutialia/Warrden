import type { QueueRecord } from '../../arr/types.js';
import type { TargetKind } from '../../jobs/queue.js';

export type QueueAssessment =
  | { state: 'settled' }
  | { state: 'busy' }
  | { state: 'stuck'; downloadIds: string[] };

/** True when `record` belongs to `target` — the only field that actually identifies a
 * queue record's target (arrs never tag queue records with a job id). */
function matchesTarget(record: QueueRecord, target: { kind: TargetKind; id: number }): boolean {
  return target.kind === 'series' ? record.seriesId === target.id : record.movieId === target.id;
}

/**
 * Reads the arr's live download queue to decide whether it's safe to sweep this target's
 * import output right now. Only queue records matching `target` are considered — records
 * for other series/movies are irrelevant to this job.
 *
 * - **Busy**: ANY matching record is `status: 'completed'` and `trackedDownloadState:
 *   'importing'` — the arr is actively mid-import for this target. This deliberately
 *   ignores which `downloadId` triggered the job: webhook coalescing means the job's own
 *   payload `downloadId` may not even be the download currently importing, and
 *   `'importing'` only lasts minutes, so waiting on every matching record is cheap
 *   insurance against racing the arr's own file move.
 * - **Stuck** (checked only once nothing is busy): any matching record with
 *   `trackedDownloadState: 'importPending'`, or `status: 'completed'` with
 *   `trackedDownloadStatus: 'warning'` — an import the arr gave up on automatically.
 *   Reports the deduped, non-empty `downloadId`s of every such record (not just the one
 *   that triggered this job) so a rescue pass can retry all of them.
 * - **Settled** otherwise — notably, a matching record still `status: 'downloading'`
 *   (e.g. a second season of the same series still fetching) is settled, not busy: it
 *   must never delay ingesting a different season/download that already imported.
 */
export function assessQueue(records: QueueRecord[], target: { kind: TargetKind; id: number }): QueueAssessment {
  const targetRecords = records.filter((r) => matchesTarget(r, target));

  const busy = targetRecords.some((r) => r.status === 'completed' && r.trackedDownloadState === 'importing');
  if (busy) return { state: 'busy' };

  const stuckRecords = targetRecords.filter(
    (r) => r.trackedDownloadState === 'importPending' || (r.status === 'completed' && r.trackedDownloadStatus === 'warning'),
  );
  if (stuckRecords.length > 0) {
    const downloadIds = [...new Set(stuckRecords.map((r) => r.downloadId).filter((id): id is string => Boolean(id)))];
    return { state: 'stuck', downloadIds };
  }

  return { state: 'settled' };
}
