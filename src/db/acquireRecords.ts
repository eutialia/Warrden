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

  /**
   * Every record for this target, newest first. `bounds.since`/`bounds.until` (both
   * inclusive, both optional) scope the result to one job's own run window — same
   * rationale as `outcomeForJob`'s bounds below: without them, a caller showing "this
   * job's own record" could show a *different* job's (a later re-pick's) record instead,
   * since every job for a target shares the same `acquire_records` rows.
   */
  listByTarget(arrInstance: string, targetKind: TargetKind, targetId: number, bounds?: { since?: number; until?: number }): AcquireRecordRow[] {
    const clauses = ['arr_instance = ?', 'target_kind = ?', 'target_id = ?'];
    const params: unknown[] = [arrInstance, targetKind, targetId];
    if (bounds?.since !== undefined) {
      clauses.push('created_at >= ?');
      params.push(bounds.since);
    }
    if (bounds?.until !== undefined) {
      clauses.push('created_at <= ?');
      params.push(bounds.until);
    }
    const rows = this.db
      .prepare(`SELECT * FROM acquire_records WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC`)
      .all(...params) as AcquireRecordRowRaw[];
    return rows.map(parseRow);
  }

  /**
   * Aggregate outcome for one job's own run against this target: `'grabbed'` if any record
   * that job itself produced (`created_at >= sinceCreatedAt`, the job's own `created_at`) is
   * `'grabbed'`, else `'none-viable'` if any is that, else `'no-candidates'` if any record
   * exists at all, else `null` (no record yet — the job hasn't run, or crashed before
   * recording anything). Needed because a multi-season series job (`runAcquireJob`'s series
   * branch, `src/pipelines/acquire/run.ts`) writes one row per season: the single latest row
   * alone doesn't tell you "did *any* season grab" when a later season's own outcome was
   * worse than an earlier one's.
   */
  outcomeForJob(
    arrInstance: string,
    targetKind: TargetKind,
    targetId: number,
    sinceCreatedAt: number,
    untilCreatedAt?: number,
  ): AcquireStatus | null {
    // The upper bound scopes a TERMINAL job to records its own run wrote (created_at ..
    // updated_at); without it, a later re-pick's records would retroactively flip every
    // older job's badge for the same target. Live jobs pass no bound — they're still writing.
    const rows = this.db
      .prepare(
        `SELECT status FROM acquire_records
         WHERE arr_instance = ? AND target_kind = ? AND target_id = ? AND created_at >= ? AND created_at <= ?`,
      )
      .all(arrInstance, targetKind, targetId, sinceCreatedAt, untilCreatedAt ?? Number.MAX_SAFE_INTEGER) as {
      status: AcquireStatus | null;
    }[];
    if (rows.some((r) => r.status === 'grabbed')) return 'grabbed';
    if (rows.some((r) => r.status === 'none-viable')) return 'none-viable';
    if (rows.some((r) => r.status === 'no-candidates')) return 'no-candidates';
    return null;
  }
}
