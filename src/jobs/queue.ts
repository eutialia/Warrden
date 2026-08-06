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
        // Reset not_before to this enqueue's own effective value (default 0, i.e.
        // immediately claimable) rather than leaving the twin's existing one in place — a
        // fresh trigger (a new webhook, a manual re-pick) legitimately overrides whatever
        // retry backoff the pending twin was still waiting out.
        this.db.prepare(`UPDATE jobs SET not_before = ?, updated_at = ? WHERE id = ?`).run(j.notBefore ?? 0, now, twin.id);
        return { id: twin.id, outcome: 'coalesced' };
      }
      if (twin?.status === 'running') {
        this.db.prepare(`UPDATE jobs SET dirty = 1, updated_at = ? WHERE id = ?`).run(now, twin.id);
        return { id: twin.id, outcome: 'marked-dirty' };
      }
      const info = this.db
        .prepare(
          `INSERT INTO jobs (pipeline, target_kind, target_id, arr_instance, payload, not_before, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(j.pipeline, j.targetKind, j.targetId, j.arrInstance, JSON.stringify(j.payload ?? {}), j.notBefore ?? 0, now, now);
      return { id: Number(info.lastInsertRowid), outcome: 'enqueued' };
    });
    // BEGIN IMMEDIATE up front closes the theoretical window where a deferred
    // transaction upgrades from read to write mid-flight and races another writer.
    return tx.immediate();
  }

  claim(now: number = Date.now()): JobRow | null {
    const row = this.db
      .prepare(
        `UPDATE jobs SET status = 'running', updated_at = ?
         WHERE id = (
           SELECT id FROM jobs WHERE status = 'pending' AND not_before <= ?
           ORDER BY created_at ASC, id ASC LIMIT 1
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
      if (!job) throw new Error(`complete: job ${id} not found`);

      const info = this.db
        .prepare(`UPDATE jobs SET status = 'done', dirty = 0, result = ?, updated_at = ? WHERE id = ? AND status = 'running'`)
        .run(result === undefined ? null : JSON.stringify(result), now, id);
      if (info.changes === 0) {
        throw new Error(`complete: job ${id} is not running (status=${job.status})`);
      }

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
    const maxAttempts = opts?.maxAttempts ?? 3;
    const now = Date.now();
    const tx = this.db.transaction((): { retried: boolean } => {
      const job = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobRowRaw | undefined;
      if (!job) throw new Error(`fail: job ${id} not found`);

      const attempts = job.attempts + 1;
      if (attempts < maxAttempts) {
        // Only the default backoff scales with attempts; an explicit retryInMs is used as-is.
        const delay = opts?.retryInMs ?? 60_000 * attempts;
        const info = this.db
          .prepare(
            `UPDATE jobs SET status = 'pending', dirty = 0, attempts = ?, not_before = ?, error = ?, updated_at = ?
             WHERE id = ? AND status = 'running'`,
          )
          .run(attempts, now + delay, err, now, id);
        if (info.changes === 0) {
          throw new Error(`fail: job ${id} is not running (status=${job.status})`);
        }
        return { retried: true };
      }

      const info = this.db
        .prepare(
          `UPDATE jobs SET status = 'failed', dirty = 0, attempts = ?, error = ?, updated_at = ? WHERE id = ? AND status = 'running'`,
        )
        .run(attempts, err, now, id);
      if (info.changes === 0) {
        throw new Error(`fail: job ${id} is not running (status=${job.status})`);
      }

      // Same rationale as complete()'s own dirty-twin requeue: a duplicate enqueue that
      // arrived while this run was in flight must not be lost just because the run ended
      // in a *terminal* failure rather than success — the trigger that set `dirty` is
      // still owed a fresh attempt.
      if (job.dirty) {
        this.db
          .prepare(
            `INSERT INTO jobs (pipeline, target_kind, target_id, arr_instance, payload, not_before, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
          )
          .run(job.pipeline, job.target_kind, job.target_id, job.arr_instance, job.payload, now, now);
      }
      return { retried: false };
    });
    return tx();
  }

  /**
   * Resets every `running` job back to `pending` (clearing `not_before` and `dirty`,
   * preserving `attempts`) and returns how many were reset. Meant to run once at startup,
   * before the runner starts polling: a process crash/restart while a job was in flight
   * otherwise leaves it wedged as `running` forever — the singleton index
   * (`jobs_singleton`) blocks any future enqueue for that same target, and only
   * `complete()`/`fail()` would clear it, but nothing will ever call those for a run that
   * no longer exists. Clearing `dirty` here too matters for the same reason: a duplicate
   * enqueue that raced the crash would otherwise leave it set, and the first `complete()`
   * after reclaiming would requeue a second, redundant run of a job that never actually
   * needed one.
   */
  reclaimAbandoned(): number {
    const info = this.db
      .prepare(`UPDATE jobs SET status = 'pending', dirty = 0, not_before = 0, updated_at = ? WHERE status = 'running'`)
      .run(Date.now());
    return info.changes;
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
