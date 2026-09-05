import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { AppContext } from '../context.js';
import type { PlacedFiles } from '../db/placedFiles.js';
import { targetEventData } from '../events/target.js';
import type { JobRow } from '../jobs/queue.js';

/** Why placement must not proceed — foreign file on disk, or another Warrden source already claims the path. */
export type PlaceBlock =
  | { kind: 'foreign' }
  | { kind: 'collision'; claimedBy: string };

/**
 * Shared foreign-file + collision guards for every library placement (ingest sidecars and
 * subtitle candidates). Never overwrite a path without a matching `placed_files` row, and
 * never let two different sources claim the same target. Returns `null` when placement may
 * proceed (including re-placement from the same source — the idempotent refresh path).
 */
export function placeBlocked(placedFiles: PlacedFiles, targetPath: string, sourcePath: string): PlaceBlock | null {
  const existing = placedFiles.findByPlacedPath(targetPath);
  if (existsSync(targetPath) && !existing) return { kind: 'foreign' };
  if (existing && existing.source_path !== sourcePath) {
    return { kind: 'collision', claimedBy: existing.source_path };
  }
  return null;
}

/**
 * The warn event for a placement one of the guards above stopped. Shared by ingest and
 * subtitle so the two can't drift on what a blocked placement reads like; the only
 * pipeline-specific parts are the event kind's prefix and the name each pipeline gives the
 * source it was placing (a sidecar swept out of a torrent folder, or a subtitle file pulled
 * out of a pack), both derived from `scope`.
 */
export function reportPlaceBlocked(
  ctx: AppContext,
  job: JobRow,
  scope: 'ingest' | 'subtitle',
  block: PlaceBlock,
  sourcePath: string,
  targetPath: string,
): void {
  const targetName = basename(targetPath);
  const message =
    block.kind === 'foreign'
      ? `Skipped "${basename(sourcePath)}" — "${targetName}" already exists and wasn't placed by Warrden`
      : `Skipped "${basename(sourcePath)}" — "${targetName}" is already claimed by "${block.claimedBy}"`;
  ctx.events.append({
    kind: block.kind === 'foreign' ? `${scope}.skipped-foreign` : `${scope}.skipped-collision`,
    level: 'warn',
    jobId: job.id,
    message,
    data: targetEventData(job, { [scope === 'ingest' ? 'sidecarPath' : 'sourcePath']: sourcePath, targetPath }),
  });
}
