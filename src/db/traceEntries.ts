import type Database from 'better-sqlite3';

export const TRACE_RETENTION_DAYS = 7;
export const PAYLOAD_CAP_BYTES = 256 * 1024;

export type TraceStatus = 'running' | 'ok' | 'error';

export interface TraceEntryRow {
  id: number;
  job_id: number;
  seq: number;
  parent_seq: number | null;
  kind: string;
  summary: string;
  side_effect: 0 | 1;
  status: TraceStatus;
  ts_start: number;
  ts_end: number | null;
  payload: string | null;
}

export interface TraceSummaryRow {
  job_id: number;
  entry_count: number;
  first_ts: number;
  last_ts: number;
}

export interface AppendTraceInput {
  jobId: number;
  kind: string;
  summary: string;
  parentSeq?: number;
  sideEffect?: boolean;
  status?: TraceStatus;
  tsStart?: number;
  tsEnd?: number;
  payload?: unknown;
}

// The column must always hold valid JSON: a truncated raw string would be unparseable,
// so over-cap payloads become an envelope the UI renders as text.
export function serializePayload(value: unknown): string {
  const json = JSON.stringify(value ?? null);
  const bytes = Buffer.byteLength(json, 'utf-8');
  if (bytes <= PAYLOAD_CAP_BYTES) return json;
  return JSON.stringify({ truncated: true, bytes, head: json.slice(0, PAYLOAD_CAP_BYTES / 2) });
}

export class TraceEntries {
  constructor(private readonly db: Database.Database) {}

  append(e: AppendTraceInput): number {
    const now = Date.now();
    const row = this.db
      .prepare(
        `INSERT INTO trace_entries (job_id, seq, parent_seq, kind, summary, side_effect, status, ts_start, ts_end, payload)
         SELECT ?, COALESCE(MAX(seq) + 1, 0), ?, ?, ?, ?, ?, ?, ?, ?
         FROM trace_entries WHERE job_id = ?
         RETURNING seq`,
      )
      .get(
        e.jobId,
        e.parentSeq ?? null,
        e.kind,
        e.summary,
        e.sideEffect === true ? 1 : 0,
        e.status ?? 'running',
        e.tsStart ?? now,
        e.tsEnd ?? null,
        e.payload === undefined ? null : serializePayload(e.payload),
        e.jobId,
      ) as { seq: number };
    return row.seq;
  }

  finish(jobId: number, seq: number, status: 'ok' | 'error', payload?: unknown): void {
    if (payload === undefined) {
      this.db
        .prepare(`UPDATE trace_entries SET status = ?, ts_end = ? WHERE job_id = ? AND seq = ?`)
        .run(status, Date.now(), jobId, seq);
      return;
    }
    this.db
      .prepare(`UPDATE trace_entries SET status = ?, ts_end = ?, payload = ? WHERE job_id = ? AND seq = ?`)
      .run(status, Date.now(), serializePayload(payload), jobId, seq);
  }

  listByJob(jobId: number): TraceEntryRow[] {
    return this.db
      .prepare(`SELECT * FROM trace_entries WHERE job_id = ? ORDER BY seq ASC`)
      .all(jobId) as TraceEntryRow[];
  }

  get(jobId: number, seq: number): TraceEntryRow | null {
    const row = this.db
      .prepare(`SELECT * FROM trace_entries WHERE job_id = ? AND seq = ?`)
      .get(jobId, seq) as TraceEntryRow | undefined;
    return row ?? null;
  }

  summaries(limit = 100): TraceSummaryRow[] {
    return this.db
      .prepare(
        `SELECT job_id, COUNT(*) AS entry_count, MIN(ts_start) AS first_ts,
                MAX(COALESCE(ts_end, ts_start)) AS last_ts
         FROM trace_entries GROUP BY job_id ORDER BY last_ts DESC LIMIT ?`,
      )
      .all(limit) as TraceSummaryRow[];
  }

  // Whole jobs at a time: a partially pruned trace is worse than none.
  // Returns the count of pruned jobs, not rows.
  prune(retentionDays: number, now = Date.now()): number {
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
    const stale = this.db
      .prepare(
        `SELECT job_id FROM trace_entries GROUP BY job_id
         HAVING MAX(COALESCE(ts_end, ts_start)) < ?`,
      )
      .all(cutoff) as { job_id: number }[];
    if (stale.length === 0) return 0;
    const del = this.db.prepare(`DELETE FROM trace_entries WHERE job_id = ?`);
    const tx = this.db.transaction((ids: { job_id: number }[]) => {
      for (const { job_id } of ids) del.run(job_id);
    });
    tx(stale);
    return stale.length;
  }
}
