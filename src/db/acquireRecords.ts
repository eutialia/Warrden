import type Database from 'better-sqlite3';
import type { TargetKind } from '../jobs/queue.js';

export type AcquireStatus = 'no-candidates' | 'none-viable' | 'grabbed';

export interface InsertAcquireRecordInput {
  arrInstance: string;
  targetKind: TargetKind;
  targetId: number;
  status: AcquireStatus;
  /** Where the job that produced this record came from, e.g. `'webhook'` or (once Task 12
   * lands) `'reconcile'` — free-form, not constrained to a fixed set here. */
  source?: string;
  pickedGuid?: string;
  releaseGroup?: string | null;
  reasoning?: string;
  candidates?: object;
}

export interface AcquireRecordRow {
  id: number;
  arr_instance: string;
  target_kind: TargetKind;
  target_id: number;
  source: string | null;
  status: AcquireStatus | null;
  picked_guid: string | null;
  release_group: string | null;
  reasoning: string | null;
  candidates_json: Record<string, unknown> | null;
  created_at: number;
}

// Raw shape as read from SQLite, before the JSON `candidates_json` column is parsed at
// the boundary.
interface AcquireRecordRowRaw {
  id: number;
  arr_instance: string;
  target_kind: TargetKind;
  target_id: number;
  source: string | null;
  status: AcquireStatus | null;
  picked_guid: string | null;
  release_group: string | null;
  reasoning: string | null;
  candidates_json: string | null;
  created_at: number;
}

function parseRow(row: AcquireRecordRowRaw): AcquireRecordRow {
  return {
    ...row,
    candidates_json: row.candidates_json === null ? null : (JSON.parse(row.candidates_json) as Record<string, unknown>),
  };
}

/**
 * Typed wrapper over the `acquire_records` table — one append-only audit row per acquire
 * job outcome (`no-candidates` / `none-viable` / `grabbed`), written by `runAcquireJob`
 * and read by the dashboard (Task 13). Kept alongside `ManagedObjects` as the one place
 * that owns this table's SQL.
 */
export class AcquireRecords {
  constructor(private readonly db: Database.Database) {}

  insert(r: InsertAcquireRecordInput): void {
    this.db
      .prepare(
        `INSERT INTO acquire_records
           (arr_instance, target_kind, target_id, source, status, picked_guid, release_group, reasoning, candidates_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.arrInstance,
        r.targetKind,
        r.targetId,
        r.source ?? null,
        r.status,
        r.pickedGuid ?? null,
        r.releaseGroup ?? null,
        r.reasoning ?? null,
        JSON.stringify(r.candidates ?? {}),
        Date.now(),
      );
  }

  listByTarget(arrInstance: string, targetKind: TargetKind, targetId: number): AcquireRecordRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM acquire_records
         WHERE arr_instance = ? AND target_kind = ? AND target_id = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(arrInstance, targetKind, targetId) as AcquireRecordRowRaw[];
    return rows.map(parseRow);
  }
}
