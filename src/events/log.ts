import type Database from 'better-sqlite3';
import { AttentionItems } from '../db/attention.js';

export type EventLevel = 'info' | 'warn' | 'attention';

export interface AppendInput {
  kind: string;
  level?: EventLevel;
  jobId?: number;
  message: string;
  data?: object;
}

export interface EventRow {
  id: number;
  ts: number;
  kind: string;
  level: EventLevel;
  job_id: number | null;
  message: string;
  data: Record<string, unknown>;
}

// Raw shape as read from SQLite, before the JSON `data` column is parsed at the boundary.
interface EventRowRaw {
  id: number;
  ts: number;
  kind: string;
  level: EventLevel;
  job_id: number | null;
  message: string;
  data: string;
}

function parseRow(row: EventRowRaw): EventRow {
  return { ...row, data: JSON.parse(row.data) as Record<string, unknown> };
}

/**
 * Append-only event log on top of the `events` table. Every append is persisted and then
 * fanned out synchronously to subscribers (e.g. the SSE stream) so listeners never miss
 * an event that a concurrent `list()` call would already see.
 */
export class EventLog {
  private readonly subscribers = new Set<(e: EventRow) => void>();

  constructor(private readonly db: Database.Database) {}

  append(e: AppendInput): EventRow {
    const row = this.db
      .prepare(
        `INSERT INTO events (ts, kind, level, job_id, message, data)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(Date.now(), e.kind, e.level ?? 'info', e.jobId ?? null, e.message, JSON.stringify(e.data ?? {})) as EventRowRaw;

    const parsed = parseRow(row);

    // Attention-level events double as attention items: anything a human needs to see
    // shows up on the Attention view without every caller having to write both.
    if (parsed.level === 'attention') {
      new AttentionItems(this.db).open({ kind: parsed.kind, message: parsed.message, jobId: parsed.job_id ?? undefined, data: parsed.data });
    }

    for (const fn of this.subscribers) {
      try {
        fn(parsed);
      } catch (err) {
        // A misbehaving subscriber (e.g. a dropped SSE connection) must not stop the
        // row from being persisted or starve subscribers registered after it.
        console.error('EventLog subscriber threw', err);
      }
    }
    return parsed;
  }

  list(opts?: { limit?: number; level?: string }): EventRow[] {
    let sql = 'SELECT * FROM events';
    const params: unknown[] = [];
    if (opts?.level !== undefined) {
      sql += ' WHERE level = ?';
      params.push(opts.level);
    }
    sql += ' ORDER BY id DESC';
    if (opts?.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(opts.limit);
    }
    const rows = this.db.prepare(sql).all(...params) as EventRowRaw[];
    return rows.map(parseRow);
  }

  subscribe(fn: (e: EventRow) => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /** Exposed for tests to assert subscriptions are actually cleaned up (e.g. after an SSE abort). */
  get subscriberCount(): number {
    return this.subscribers.size;
  }
}
