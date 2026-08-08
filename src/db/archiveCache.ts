import type Database from 'better-sqlite3';
import type { TargetKind } from '../jobs/queue.js';

/** One file inside a cached archive, pre-annotated at cache-write time with everything the
 * reconcile pass needs to match it to an episode without re-parsing the filename. */
export interface ArchiveCacheEntry {
  path: string; // path within the extracted archive dir
  lang: string | null;
  episodeRef: { season: number | null; episode: number } | null;
}

export interface ArchiveCacheRow {
  id: number;
  arr_instance: string;
  target_kind: TargetKind;
  target_id: number;
  source_url: string;
  path: string; // local extracted dir (under dataDir/cache)
  files: ArchiveCacheEntry[];
  created_at: number;
}

interface ArchiveCacheRowRaw extends Omit<ArchiveCacheRow, 'files'> {
  files: string;
}

function parseRow(row: ArchiveCacheRowRaw): ArchiveCacheRow {
  return { ...row, files: JSON.parse(row.files) as ArchiveCacheEntry[] };
}

/**
 * Typed wrapper over the `archive_cache` table — the per-series record of subtitle bundles
 * the agent already downloaded and extracted, so a later episode landing mid-season can be
 * subtitled from the cache instead of re-searching (and re-downloading) the whole pack.
 * Rows are keyed unique per (target, path): re-extracting the same archive refreshes the
 * row in place rather than piling up duplicates.
 */
export class ArchiveCache {
  constructor(private readonly db: Database.Database) {}

  upsert(o: {
    arrInstance: string;
    targetKind: TargetKind;
    targetId: number;
    sourceUrl: string;
    path: string;
    files: ArchiveCacheEntry[];
  }): void {
    this.db
      .prepare(
        `INSERT INTO archive_cache (arr_instance, target_kind, target_id, source_url, path, files, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(arr_instance, target_kind, target_id, path) DO UPDATE SET
           source_url = excluded.source_url,
           files = excluded.files,
           created_at = excluded.created_at`,
      )
      .run(o.arrInstance, o.targetKind, o.targetId, o.sourceUrl, o.path, JSON.stringify(o.files), Date.now());
  }

  forTarget(arrInstance: string, targetKind: TargetKind, targetId: number): ArchiveCacheRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM archive_cache WHERE arr_instance = ? AND target_kind = ? AND target_id = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(arrInstance, targetKind, targetId) as ArchiveCacheRowRaw[];
    return rows.map(parseRow);
  }

  deleteById(id: number): void {
    this.db.prepare(`DELETE FROM archive_cache WHERE id = ?`).run(id);
  }
}
