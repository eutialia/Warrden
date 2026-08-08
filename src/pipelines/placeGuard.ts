import { existsSync } from 'node:fs';
import type { PlacedFiles } from '../db/placedFiles.js';

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
