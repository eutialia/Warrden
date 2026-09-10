import type Database from 'better-sqlite3';

export const TRACE_RETENTION_DAYS = 7;
export const PAYLOAD_CAP_BYTES = 256 * 1024;
/** Head kept for one oversized member of an object payload; half the whole-payload head so
 * several truncated members still fit under the cap together. */
export const PAYLOAD_LEAF_HEAD_BYTES = 64 * 1024;

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

export interface TraceUsage {
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
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

function truncationEnvelope(json: string, head: number): { truncated: true; bytes: number; head: string } {
  return { truncated: true, bytes: Buffer.byteLength(json, 'utf-8'), head: json.slice(0, head) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The column must always hold valid JSON: a truncated raw string would be unparseable,
// so over-cap payloads become an envelope the UI renders as text. An object payload sheds
// its oversized members one at a time first, so the small facts beside them survive — an
// `llm.attempt` with a megabyte-long `request` body still carries the `usage` block that
// `usageByJob` sums in SQL, and the Call tab still has an output to draw.
export function serializePayload(value: unknown): string {
  const json = JSON.stringify(value ?? null);
  if (Buffer.byteLength(json, 'utf-8') <= PAYLOAD_CAP_BYTES) return json;
  if (isPlainObject(value)) {
    const pruned: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) {
      const memberJson = JSON.stringify(member ?? null);
      pruned[key] =
        Buffer.byteLength(memberJson, 'utf-8') > PAYLOAD_LEAF_HEAD_BYTES ? truncationEnvelope(memberJson, PAYLOAD_LEAF_HEAD_BYTES) : member;
    }
    const prunedJson = JSON.stringify(pruned);
    if (Buffer.byteLength(prunedJson, 'utf-8') <= PAYLOAD_CAP_BYTES) return prunedJson;
  }
  return JSON.stringify(truncationEnvelope(json, PAYLOAD_CAP_BYTES / 2));
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

  // Summed in SQL so the payloads stay server-side instead of crossing the wire for the
  // header to add up. json_extract returns NULL for a missing key and for a whole-payload
  // truncation envelope, which SUM ignores. Tokens come from attempts (a retry spends its own), but
  // `calls` counts `llm.call`, so one call retried twice is one call.
  usageByJob(jobId: number): TraceUsage {
    return this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM trace_entries WHERE job_id = ? AND kind = 'llm.call') AS calls,
                COALESCE(SUM(json_extract(payload, '$.usage.inputTokens')), 0) AS inputTokens,
                COALESCE(SUM(json_extract(payload, '$.usage.cachedInputTokens')), 0) AS cachedInputTokens,
                COALESCE(SUM(json_extract(payload, '$.usage.outputTokens')), 0) AS outputTokens,
                COALESCE(SUM(json_extract(payload, '$.usage.outputTokenDetails.reasoningTokens')), 0) AS reasoningTokens
         FROM trace_entries WHERE job_id = ? AND kind = 'llm.attempt'`,
      )
      .get(jobId, jobId) as TraceUsage;
  }

  // Whole jobs at a time: a partially pruned trace is worse than none.
  // Returns the count of pruned jobs, not rows.
  prune(retentionDays: number, now = Date.now()): number {
    // Same clamp EventLog.prune keeps: a zero or negative retention would put the cutoff
    // at (or past) now and delete traces that are still live.
    if (retentionDays <= 0) return 0;
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
