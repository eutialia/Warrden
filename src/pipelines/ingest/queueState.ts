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

/** A completed download the arr itself has flagged as trouble: `importBlocked` (the arr
 * stopped and is waiting on a human) or any `trackedDownloadStatus: 'warning'` (a rejection,
 * a mapping it couldn't resolve, ...). Both mean the arr is NOT going to import this on its
 * own, which is the only condition under which a rescue may safely step in. `status` must be
 * `'completed'`: a warning on a record still `'downloading'` is about the fetch (stalled
 * tracker, no seeds), and there's nothing on disk to import yet. `'importing'` overrides the
 * warning outright: the arr is moving these files RIGHT NOW, and Sonarr routinely carries
 * `statusMessages` (hence `trackedDownloadStatus: 'warning'`) from earlier in the record's
 * life straight into the importing state. Rescuing there is the double-import itself. */
function isStuckRecord(r: QueueRecord): boolean {
  if (r.status !== 'completed' || r.trackedDownloadState === 'importing') return false;
  return r.trackedDownloadState === 'importBlocked' || r.trackedDownloadStatus === 'warning';
}

/**
 * Reads the arr's live download queue to decide whether it's safe to sweep this target's
 * import output right now. Only queue records matching `target` are considered — records
 * for other series/movies are irrelevant to this job.
 *
 * - **Busy**: ANY matching record is `status: 'completed'` with `trackedDownloadState`
 *   `'importing'` or `'importPending'`, and isn't itself stuck (see `isStuckRecord`).
 *   `'importPending'` is Sonarr 4's NORMAL "grabbed, completed, sitting in the import
 *   queue" state, not a failure: treating it as stuck fired a rescue `ManualImport` that
 *   raced Sonarr's own import and double-imported a whole season. Busy deliberately
 *   ignores which `downloadId` triggered the job: webhook coalescing means the job's own
 *   payload `downloadId` may not even be the download currently importing, so waiting on
 *   every matching record is cheap insurance against racing the arr's own file move.
 * - **Stuck** (checked only once nothing is busy): any matching record the arr flagged
 *   per `isStuckRecord`. Reports the deduped, non-empty `downloadId`s of every such
 *   record (not just the one that triggered this job) so a rescue pass can retry all of
 *   them.
 * - **Settled** otherwise — notably, a matching record still `status: 'downloading'`
 *   (e.g. a second season of the same series still fetching) is settled, not busy: it
 *   must never delay ingesting a different season/download that already imported.
 *
 * Busy outranks stuck across records: one download of this target still importing means
 * the arr is mid-move on its files right now, and a rescue import launched alongside it
 * is exactly the race this ordering exists to avoid. The stuck record is still there next
 * run.
 */
export function assessQueue(records: QueueRecord[], target: { kind: TargetKind; id: number }): QueueAssessment {
  const targetRecords = records.filter((r) => matchesTarget(r, target));

  const busy = targetRecords.some(
    (r) =>
      !isStuckRecord(r) &&
      r.status === 'completed' &&
      (r.trackedDownloadState === 'importing' || r.trackedDownloadState === 'importPending'),
  );
  if (busy) return { state: 'busy' };

  const stuckRecords = targetRecords.filter(isStuckRecord);
  if (stuckRecords.length > 0) {
    const downloadIds = [...new Set(stuckRecords.map((r) => r.downloadId).filter((id): id is string => Boolean(id)))];
    return { state: 'stuck', downloadIds };
  }

  return { state: 'settled' };
}
