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

interface OpenAttentionInput {
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
  /** Optional per-emission discriminator (see `open()`'s doc) — `undefined` when the
   * emitter didn't carry one, which still matches another `undefined` (the plain
   * per-target behavior every emitter had before `dedupeKey` existed). Always normalized
   * to a `string` via `normalizeDedupeKey` — see its own doc for why. */
  dedupeKey?: string;
}

/** Normalizes a raw `data.dedupeKey` value to a `string` (via `String(...)`), or
 * `undefined` when it wasn't set at all (`undefined`/`null` both mean "no dedupeKey").
 * Applied on BOTH sides of every dedupeKey comparison — `targetKeyOf` (building the new
 * row's key) AND `sameTarget` (reading an existing row's stored value back out) — so an
 * emitter that hands a non-string (a `seasonNumber` passed as a bare `number`, say)
 * dedupes exactly as if it had stringified it itself, instead of the two sides silently
 * disagreeing on the type and comparing unequal forever (which would look like "this
 * dedupeKey never matches anything," not a loud failure). */
function normalizeDedupeKey(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

/** Extracts `{ instance, targetKind, targetId, dedupeKey? }` from an attention event's
 * `data` when the first three are present — `open()`'s preferred dedupe key (see its own
 * doc). `null` when any of the first three is missing, so the caller falls back to the
 * older `(kind, jobId)` rule instead. `dedupeKey` is a convention, not an enforced field —
 * a caller that never set one leaves it `undefined`. */
function targetKeyOf(data: object | undefined): TargetKey | null {
  const d = (data ?? {}) as Record<string, unknown>;
  if (d.instance === undefined || d.targetKind === undefined || d.targetId === undefined) return null;
  return { instance: d.instance, targetKind: d.targetKind, targetId: d.targetId, dedupeKey: normalizeDedupeKey(d.dedupeKey) };
}

function sameTarget(data: Record<string, unknown>, key: TargetKey): boolean {
  return (
    data.instance === key.instance &&
    data.targetKind === key.targetKind &&
    data.targetId === key.targetId &&
    normalizeDedupeKey(data.dedupeKey) === key.dedupeKey
  );
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
   *   payload, instead of piling up a new row per run. A recurring condition on the WHOLE
   *   target (a stuck download, a settle timeout, a missing mount) is meant to collapse
   *   this way. But a target can fail at a finer grain than "the whole target" — five
   *   sidecars each failing to match a different episode, or four different seasons each
   *   coming back with no viable release — and those are distinct failures, not repeats
   *   of one condition; collapsing them into a single row would silently keep only the
   *   last one, hiding the other four. `data.dedupeKey` (a string) is the escape hatch: an
   *   emitter that carries one narrows the target key to `(instance, targetKind, targetId,
   *   dedupeKey)`, so only re-emissions for that SAME sub-target (the same sidecar path,
   *   the same season number, ...) collapse into each other. An emitter that carries no
   *   `dedupeKey` still gets the plain per-target behavior described above (an `undefined`
   *   `dedupeKey` matches another `undefined` one).
   * - **`(kind, jobId)`** (fallback): used when `data` doesn't carry a full target key.
   *   Under this fallback rule specifically, a `jobId` of `undefined` never dedupes:
   *   without a job to scope it, two unrelated occurrences of the same `kind` (e.g. two
   *   different files failing to match) would otherwise collapse into one, silently
   *   dropping the first.
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
        // COALESCE, not a bare overwrite: a target-keyed refresh with no jobId of its own
        // (an event that carries instance/targetKind/targetId but no jobId) must not null
        // out the existing row's job link — it just has nothing newer to offer for it.
        const row = this.db
          .prepare(`UPDATE attention_items SET ts = ?, message = ?, data = ?, job_id = COALESCE(?, job_id) WHERE id = ? RETURNING *`)
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
