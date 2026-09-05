import type Database from 'better-sqlite3';
import { AttentionItems } from '../db/attention.js';
import { ensureEnvelope } from './envelope.js';

type EventLevel = 'info' | 'warn' | 'attention';

/**
 * One job's event window. Raised from 100 once every pipeline started narrating itself
 * through the envelope: a pack import writes a row per file and a subtitle run writes one
 * per agent step, so 100 silently truncated the middle of a real run's story.
 *
 * Still bounded — an uncapped SELECT is a hole, not a feature — but hitting 500 now means
 * something is genuinely wrong, so `listByJob` says so out loud instead of quietly handing
 * back a prefix.
 */
const DEFAULT_LIST_BY_JOB_LIMIT = 500;

interface AppendInput {
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
      .get(
        Date.now(),
        e.kind,
        e.level ?? 'info',
        e.jobId ?? null,
        e.message,
        // Every persisted row carries the envelope, whether or not its emitter built one:
        // the dashboard reads `data` and nothing else, so an envelope-less row would render
        // as a bare kind. See `ensureEnvelope`.
        JSON.stringify(ensureEnvelope(e.kind, e.data)),
      ) as EventRowRaw;

    const parsed = parseRow(row);

    // Attention-level events double as attention items: anything a human needs to see
    // shows up on the Attention view without every caller having to write both. Same
    // containment as the subscriber loop below: the event row above is already
    // persisted, so a bookkeeping failure here must not fail the caller's pipeline.
    if (parsed.level === 'attention') {
      try {
        new AttentionItems(this.db).open({ kind: parsed.kind, message: parsed.message, jobId: parsed.job_id ?? undefined, data: parsed.data });
      } catch (err) {
        console.error('EventLog attention mirror failed', err);
      }
    }

    this.fanOut(parsed);
    return parsed;
  }

  // Fan-out without persistence: trace append notifications are high-volume and
  // carry ids only, so they ride the SSE stream but never touch the events table.
  broadcast(e: AppendInput): void {
    this.fanOut({
      id: 0,
      ts: Date.now(),
      kind: e.kind,
      level: e.level ?? 'info',
      job_id: e.jobId ?? null,
      message: e.message,
      data: ensureEnvelope(e.kind, e.data) as Record<string, unknown>,
    });
  }

  private fanOut(row: EventRow): void {
    for (const fn of this.subscribers) {
      try {
        fn(row);
      } catch (err) {
        // A misbehaving subscriber (e.g. a dropped SSE connection) must not stop the
        // row from being persisted or starve subscribers registered after it.
        console.error('EventLog subscriber threw', err);
      }
    }
  }

  /**
   * Deletes events older than `retentionDays`, returning how many went. `0` keeps
   * everything — the table is append-only and nothing else prunes it, so without this
   * it grows for the life of the install and the dashboard's "last 24 hours" counters
   * scan all of it.
   *
   * Attention items are a separate table and are never touched here: they are decisions
   * waiting on a human, not history.
   */
  prune(retentionDays: number, now = Date.now()): number {
    if (retentionDays <= 0) return 0;
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
    return this.db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff).changes;
  }

  list(opts?: { level?: string }): EventRow[] {
    const rows = (
      opts?.level === undefined
        ? this.db.prepare('SELECT * FROM events ORDER BY id DESC').all()
        : this.db.prepare('SELECT * FROM events WHERE level = ? ORDER BY id DESC').all(opts.level)
    ) as EventRowRaw[];
    return rows.map(parseRow);
  }

  /**
   * One job's events, oldest first, so a run can narrate itself in the order it happened.
   * `list()` is newest-first because it feeds a live feed; a single run reads as a story.
   *
   * Always bounded: `events` only ever grows, so an uncapped SELECT hands the caller a
   * result set with no ceiling. A full window is reported, because the caller is then
   * reading a prefix of a run rather than the run — silently returning one is how a
   * truncated story reads as a complete one.
   */
  listByJob(jobId: number, opts?: { limit?: number }): EventRow[] {
    const limit = opts?.limit ?? DEFAULT_LIST_BY_JOB_LIMIT;
    const rows = this.db
      .prepare('SELECT * FROM events WHERE job_id = ? ORDER BY id ASC LIMIT ?')
      .all(jobId, limit) as EventRowRaw[];
    if (rows.length === limit) {
      console.warn(`EventLog.listByJob truncated job #${jobId} at ${limit} events; older events are being read, newer ones dropped`);
    }
    return rows.map(parseRow);
  }

  /**
   * One job's events of specific kinds, oldest first and unbounded by `listByJob`'s window.
   * The window is a defence against a runaway job filling a response; a handful of named
   * kinds cannot be that, and the run body needs exactly the lines a long run's transcript
   * spam had already pushed out of the oldest 100.
   */
  listByJobKinds(jobId: number, kinds: readonly string[]): EventRow[] {
    if (kinds.length === 0) return [];
    const placeholders = kinds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE job_id = ? AND kind IN (${placeholders}) ORDER BY id ASC`)
      .all(jobId, ...kinds) as EventRowRaw[];
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
