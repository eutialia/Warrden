import type Database from 'better-sqlite3';
import type { TargetKind } from '../jobs/queue.js';

type PlacedFileKind = 'audio' | 'subtitle';

export interface PlacedFileRow {
  id: number;
  arr_instance: string;
  target_kind: TargetKind;
  target_id: number;
  kind: PlacedFileKind;
  placed_path: string;
  video_path: string;
  source_path: string;
  job_id: number | null;
  data: Record<string, unknown>;
  created_at: number;
}

// Raw shape as read from SQLite, before the JSON `data` column is parsed at the boundary.
interface PlacedFileRowRaw {
  id: number;
  arr_instance: string;
  target_kind: TargetKind;
  target_id: number;
  kind: PlacedFileKind;
  placed_path: string;
  video_path: string;
  source_path: string;
  job_id: number | null;
  data: string;
  created_at: number;
}

export interface UpsertPlacedFileInput {
  // Kept exported: tests build partial fixtures with Partial<UpsertPlacedFileInput>.
  arrInstance: string;
  targetKind: TargetKind;
  targetId: number;
  kind: PlacedFileKind;
  placedPath: string;
  videoPath: string;
  sourcePath: string;
  jobId?: number;
  data?: object;
}

function parseRow(row: PlacedFileRowRaw): PlacedFileRow {
  return { ...row, data: JSON.parse(row.data) as Record<string, unknown> };
}

/**
 * Typed wrapper over the `placed_files` table — one row per file the ingest pipeline has
 * placed into the library (audio/subtitle sidecars matched to a video), keyed on the
 * unique `placed_path`. Re-placing the same path (e.g. a corrected re-match) refreshes the
 * row in place rather than accumulating duplicates, since `placed_path` is where the
 * ground truth about "what's on disk now" lives.
 *
 * `created_at` is when the file was first placed and never moves again. A sweep that
 * re-verifies an already-placed sidecar rewrites the row, so a `created_at` that moved
 * with it would make "delivered in the last 7 days" count the whole library every time a
 * series gets one new episode.
 */
export class PlacedFiles {
  constructor(private readonly db: Database.Database) {}

  upsert(o: UpsertPlacedFileInput): void {
    this.db
      .prepare(
        `INSERT INTO placed_files
           (arr_instance, target_kind, target_id, kind, placed_path, video_path, source_path, job_id, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(placed_path) DO UPDATE SET
           video_path = excluded.video_path,
           source_path = excluded.source_path,
           job_id = excluded.job_id,
           data = excluded.data`,
      )
      .run(
        o.arrInstance,
        o.targetKind,
        o.targetId,
        o.kind,
        o.placedPath,
        o.videoPath,
        o.sourcePath,
        o.jobId ?? null,
        JSON.stringify(o.data ?? {}),
        Date.now(),
      );
  }

  listByTarget(arrInstance: string, targetKind: TargetKind, targetId: number): PlacedFileRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM placed_files WHERE arr_instance = ? AND target_kind = ? AND target_id = ? ORDER BY id ASC`)
      .all(arrInstance, targetKind, targetId) as PlacedFileRowRaw[];
    return rows.map(parseRow);
  }

  listByJob(jobId: number): PlacedFileRow[] {
    const rows = this.db.prepare(`SELECT * FROM placed_files WHERE job_id = ? ORDER BY id ASC`).all(jobId) as PlacedFileRowRaw[];
    return rows.map(parseRow);
  }

  findByPlacedPath(placedPath: string): PlacedFileRow | null {
    const row = this.db.prepare(`SELECT * FROM placed_files WHERE placed_path = ?`).get(placedPath) as PlacedFileRowRaw | undefined;
    return row ? parseRow(row) : null;
  }

  deleteById(id: number): void {
    this.db.prepare(`DELETE FROM placed_files WHERE id = ?`).run(id);
  }
}
