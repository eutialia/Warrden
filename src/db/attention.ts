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

interface TargetKey {
  instance: unknown;
  targetKind: unknown;
  targetId: unknown;
}

/** Extracts `{ instance, targetKind, targetId }` from an attention event's `data` when all
 * three are present — `open()`'s preferred dedupe key (see its own doc). `null` when any
 * is missing, so the caller falls back to the older `(kind, jobId)` rule instead. */
function targetKeyOf(data: object | undefined): TargetKey | null {
  const d = (data ?? {}) as Record<string, unknown>;
  if (d.instance === undefined || d.targetKind === undefined || d.targetId === undefined) return null;
  return { instance: d.instance, targetKind: d.targetKind, targetId: d.targetId };
}

function sameTarget(data: Record<string, unknown>, key: TargetKey): boolean {
  return data.instance === key.instance && data.targetKind === key.targetKind && data.targetId === key.targetId;
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
   * Opens a new attention item, or refreshes an already-open one in place instead of
   * creating a duplicate, using whichever of two dedupe keys applies:
   * - **Target key** (preferred): when `data` carries `{ instance, targetKind, targetId }`
   *   (every ingest rescue/settle/mount event does), an open row for the same `kind` AND
   *   the same target dedupes regardless of which job produced it — a stuck download that
   *   lingers across several job runs, or a repeated acquire attention for the same
   *   series, collapses into ONE open item that always carries the latest executable
   *   payload, instead of piling up a new row per run.
   * - **`(kind, jobId)`** (fallback): used when `data` doesn't carry a full target key.
   *   A `jobId` of `undefined` never dedupes either way: without a job to scope it, two
   *   unrelated occurrences of the same `kind` (e.g. two different files failing to
   *   match) would otherwise collapse into one, silently dropping the first.
   *
   * Either way, only an `'open'` row is ever matched — a `dismissed`/`resolved` one is
   * done, not a duplicate to refresh.
   */
  open(input: OpenAttentionInput): AttentionRow {
    const now = Date.now();
    const data = JSON.stringify(input.data ?? {});
    const key = targetKeyOf(input.data);
    const tx = this.db.transaction((): AttentionRow => {
      let existingId: number | undefined;

      if (key) {
        const openRows = this.db.prepare(`SELECT id, data FROM attention_items WHERE kind = ? AND status = 'open'`).all(input.kind) as {
          id: number;
          data: string;
        }[];
        existingId = openRows.find((r) => sameTarget(JSON.parse(r.data) as Record<string, unknown>, key))?.id;
      } else if (input.jobId !== undefined) {
        existingId = (
          this.db.prepare(`SELECT id FROM attention_items WHERE kind = ? AND job_id = ? AND status = 'open'`).get(input.kind, input.jobId) as
            | { id: number }
            | undefined
        )?.id;
      }

      if (existingId !== undefined) {
        const row = this.db
          .prepare(`UPDATE attention_items SET ts = ?, message = ?, data = ?, job_id = ? WHERE id = ? RETURNING *`)
          .get(now, input.message, data, input.jobId ?? null, existingId) as AttentionRowRaw;
        return parseRow(row);
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
