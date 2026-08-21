import { configuredStoragePaths } from '../config/storage.js';
import type { AppContext } from '../context.js';
import { targetEventData } from '../events/target.js';
import { ensureMounts, MountError } from '../fs/files.js';
import { RescheduleError } from '../jobs/errors.js';
import type { JobRow } from '../jobs/queue.js';

export const MOUNT_RETRY_MS = 5 * 60_000;

/**
 * Verifies every configured storage path is present, translating a `MountError` into an
 * attention event plus an uncounted, fixed-delay reschedule (no deadline: a missing path
 * pauses the pipeline until every one of them is back). Filesystem work against an
 * unmounted NAS share would otherwise look like "nothing to do" instead of "not actually
 * mounted", which is worse for the subtitle pipeline than for ingest: a sweep that
 * silently no-ops would also silently skip the drift/placement that proves a sub is usable.
 *
 * Shared by ingest and subtitle so the two pipelines can't drift on the storage-path
 * semantics. The only pipeline-specific part is the event kind's prefix (`ingest.` vs
 * `subtitle.`), which `scope` supplies. `scope` is a runtime string rather than a const
 * union precisely so we don't have to widen the type when a third pipeline appears.
 */
export function assertMounted(ctx: AppContext, job: JobRow, scope: 'ingest' | 'subtitle'): void {
  try {
    ensureMounts(configuredStoragePaths(ctx.config));
  } catch (err) {
    if (!(err instanceof MountError)) throw err;
    ctx.events.append({
      kind: `${scope}.mount-missing`,
      level: 'attention',
      jobId: job.id,
      message: `${scope === 'ingest' ? 'Import cleanup' : 'Subtitle search'} paused: storage not reachable (${err.missing.join(', ')}). Fix or blank those paths under Settings, Storage; under Docker, check the bind mounts too.`,
      data: targetEventData(job, { missing: err.missing }),
    });
    throw new RescheduleError('storage path(s) missing', MOUNT_RETRY_MS);
  }
}
