import type Database from 'better-sqlite3';

export type TargetKind = 'series' | 'movie';
export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface EnqueueInput {
  pipeline: string;
  targetKind: TargetKind;
  targetId: number;
  arrInstance: string;
  payload?: object;
  notBefore?: number;
}

export interface EnqueueResult {
  id: number | null;
  outcome: 'enqueued' | 'coalesced' | 'marked-dirty';
}

export interface JobRow {
  id: number;
  pipeline: string;
  target_kind: TargetKind;
  target_id: number;
  arr_instance: string;
  status: JobStatus;
  dirty: 0 | 1;
  attempts: number;
  not_before: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

// Raw shape as read from SQLite, before JSON columns are parsed at the boundary.
interface JobRowRaw {
  id: number;
  pipeline: string;
  target_kind: TargetKind;
  target_id: number;
  arr_instance: string;
  status: JobStatus;
  dirty: 0 | 1;
  attempts: number;
  not_before: number;
  payload: string;
  result: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

function parseRow(row: JobRowRaw): JobRow {
  return {
    ...row,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    result: row.result === null ? null : (JSON.parse(row.result) as Record<string, unknown>),
  };
}

/**
 * Singleton job queue on top of the `jobs` table: one active (pending/running) row per
 * (pipeline, arrInstance, targetKind, targetId). Enqueuing a duplicate of a pending job
 * coalesces into it; enqueuing a duplicate of a running job flags it dirty so it gets
 * requeued once the in-flight run completes.
 */
export class JobQueue {
  constructor(private readonly db: Database.Database) {}

  enqueue(j: EnqueueInput): EnqueueResult {
    const now = Date.now();
    const tx = this.db.transaction((): EnqueueResult => {
      const twin = this.db
        .prepare(
          `SELECT id, status FROM jobs
           WHERE pipeline = ? AND arr_instance = ? AND target_kind = ? AND target_id = ?
             AND status IN ('pending', 'running')`,
        )
        .get(j.pipeline, j.arrInstance, j.targetKind, j.targetId) as { id: number; status: JobStatus } | undefined;

      if (twin?.status === 'pending') {
        return { id: null, outcome: 'coalesced' };
      }
      if (twin?.status === 'running') {
        this.db.prepare(`UPDATE jobs SET dirty = 1, updated_at = ? WHERE id = ?`).run(now, twin.id);
        return { id: null, outcome: 'marked-dirty' };
      }
      const info = this.db
        .prepare(
          `INSERT INTO jobs (pipeline, target_kind, target_id, arr_instance, payload, not_before, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(j.pipeline, j.targetKind, j.targetId, j.arrInstance, JSON.stringify(j.payload ?? {}), j.notBefore ?? 0, now, now);
      return { id: Number(info.lastInsertRowid), outcome: 'enqueued' };
    });
    return tx();
  }

  claim(now: number = Date.now()): JobRow | null {
    const row = this.db
      .prepare(
        `UPDATE jobs SET status = 'running', updated_at = ?
         WHERE id = (
           SELECT id FROM jobs WHERE status = 'pending' AND not_before <= ? ORDER BY created_at ASC LIMIT 1
         )
         RETURNING *`,
      )
      .get(now, now) as JobRowRaw | undefined;
    return row ? parseRow(row) : null;
  }

  complete(id: number, result?: object): { requeued: boolean } {
    const now = Date.now();
    const tx = this.db.transaction((): { requeued: boolean } => {
      const job = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobRowRaw | undefined;
      if (!job) return { requeued: false };

      this.db
        .prepare(`UPDATE jobs SET status = 'done', dirty = 0, result = ?, updated_at = ? WHERE id = ?`)
        .run(result === undefined ? null : JSON.stringify(result), now, id);

      if (!job.dirty) return { requeued: false };

      this.db
        .prepare(
          `INSERT INTO jobs (pipeline, target_kind, target_id, arr_instance, payload, not_before, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(job.pipeline, job.target_kind, job.target_id, job.arr_instance, job.payload, now, now);
      return { requeued: true };
    });
    return tx();
  }

  fail(id: number, err: string, opts?: { retryInMs?: number; maxAttempts?: number }): { retried: boolean } {
    const retryInMs = opts?.retryInMs ?? 60_000;
    const maxAttempts = opts?.maxAttempts ?? 3;
    const now = Date.now();
    const tx = this.db.transaction((): { retried: boolean } => {
      const job = this.db.prepare(`SELECT attempts FROM jobs WHERE id = ?`).get(id) as { attempts: number } | undefined;
      if (!job) return { retried: false };

      const attempts = job.attempts + 1;
      if (attempts < maxAttempts) {
        this.db
          .prepare(`UPDATE jobs SET status = 'pending', attempts = ?, not_before = ?, error = ?, updated_at = ? WHERE id = ?`)
          .run(attempts, now + retryInMs * attempts, err, now, id);
        return { retried: true };
      }

      this.db
        .prepare(`UPDATE jobs SET status = 'failed', attempts = ?, error = ?, updated_at = ? WHERE id = ?`)
        .run(attempts, err, now, id);
      return { retried: false };
    });
    return tx();
  }

  get(id: number): JobRow | null {
    const row = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobRowRaw | undefined;
    return row ? parseRow(row) : null;
  }

  list(opts?: { limit?: number }): JobRow[] {
    const rows = (
      opts?.limit === undefined
        ? this.db.prepare(`SELECT * FROM jobs ORDER BY created_at DESC, id DESC`).all()
        : this.db.prepare(`SELECT * FROM jobs ORDER BY created_at DESC, id DESC LIMIT ?`).all(opts.limit)
    ) as JobRowRaw[];
    return rows.map(parseRow);
  }
}
