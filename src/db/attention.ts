import type Database from 'better-sqlite3';

export type AttentionStatus = 'open' | 'dismissed' | 'resolved';

export interface AttentionRow {
  id: number;
  ts: number;
  kind: string;
  message: string;
  job_id: number | null;
  data: Record<string, unknown>;
  status: AttentionStatus;
  resolved_at: number | null;
}

// Raw shape as read from SQLite, before the JSON `data` column is parsed at the boundary.
interface AttentionRowRaw {
  id: number;
  ts: number;
  kind: string;
  message: string;
  job_id: number | null;
  data: string;
  status: AttentionStatus;
  resolved_at: number | null;
}

export interface OpenAttentionInput {
  kind: string;
  message: string;
  jobId?: number;
  data?: object;
}

function parseRow(row: AttentionRowRaw): AttentionRow {
  return { ...row, data: JSON.parse(row.data) as Record<string, unknown> };
}

/**
 * Typed wrapper over the `attention_items` table — things that need a human's eyes
 * (no sidecar match, an ambiguous bundle, a stuck manual import), surfaced on the
 * dashboard's Attention view and mirrored automatically from `EventLog.append` for every
 * `level: 'attention'` event.
 */
export class AttentionItems {
  constructor(private readonly db: Database.Database) {}

  /**
   * Opens a new attention item, or — if an open row already exists for the same
   * `(kind, jobId)` — refreshes that row's `ts`/`message`/`data` in place and returns it
   * instead of creating a duplicate. A `jobId` of `undefined` never dedupes: without a job
   * to scope it, two unrelated occurrences of the same `kind` (e.g. two different files
   * failing to match) would otherwise collapse into one, silently dropping the first.
   */
  open(input: OpenAttentionInput): AttentionRow {
    const now = Date.now();
    const data = JSON.stringify(input.data ?? {});
    const tx = this.db.transaction((): AttentionRow => {
      if (input.jobId !== undefined) {
        const existing = this.db
          .prepare(`SELECT id FROM attention_items WHERE kind = ? AND job_id = ? AND status = 'open'`)
          .get(input.kind, input.jobId) as { id: number } | undefined;
        if (existing) {
          const row = this.db
            .prepare(`UPDATE attention_items SET ts = ?, message = ?, data = ? WHERE id = ? RETURNING *`)
            .get(now, input.message, data, existing.id) as AttentionRowRaw;
          return parseRow(row);
        }
      }
      const row = this.db
        .prepare(
          `INSERT INTO attention_items (ts, kind, message, job_id, data, status)
           VALUES (?, ?, ?, ?, ?, 'open')
           RETURNING *`,
        )
        .get(now, input.kind, input.message, input.jobId ?? null, data) as AttentionRowRaw;
      return parseRow(row);
    });
    return tx();
  }

  list(opts?: { status?: AttentionStatus }): AttentionRow[] {
    let sql = 'SELECT * FROM attention_items';
    const params: unknown[] = [];
    if (opts?.status !== undefined) {
      sql += ' WHERE status = ?';
      params.push(opts.status);
    }
    sql += ' ORDER BY ts DESC, id DESC';
    const rows = this.db.prepare(sql).all(...params) as AttentionRowRaw[];
    return rows.map(parseRow);
  }

  get(id: number): AttentionRow | null {
    const row = this.db.prepare(`SELECT * FROM attention_items WHERE id = ?`).get(id) as AttentionRowRaw | undefined;
    return row ? parseRow(row) : null;
  }

  /** Only transitions a row currently `'open'` — returns `false` for an already-settled row or an unknown id. */
  setStatus(id: number, status: 'dismissed' | 'resolved'): boolean {
    const info = this.db
      .prepare(`UPDATE attention_items SET status = ?, resolved_at = ? WHERE id = ? AND status = 'open'`)
      .run(status, Date.now(), id);
    return info.changes > 0;
  }
}
