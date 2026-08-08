import type Database from 'better-sqlite3';

export type ManagedObjectKind = 'notification' | 'tag' | 'release_profile';

export interface ManagedObjectRow {
  id: number;
  arr_instance: string;
  kind: ManagedObjectKind;
  external_id: number;
  name: string | null;
  data: Record<string, unknown>;
  created_at: number;
}

// Raw shape as read from SQLite, before the JSON `data` column is parsed at the boundary.
interface ManagedObjectRowRaw {
  id: number;
  arr_instance: string;
  kind: ManagedObjectKind;
  external_id: number;
  name: string | null;
  data: string;
  created_at: number;
}

interface InsertManagedObjectInput {
  arrInstance: string;
  kind: ManagedObjectKind;
  externalId: number;
  name?: string;
  data?: object;
}

function parseRow(row: ManagedObjectRowRaw): ManagedObjectRow {
  return { ...row, data: JSON.parse(row.data) as Record<string, unknown> };
}

/**
 * Typed wrapper over the `managed_objects` table — the registry of every arr-side
 * resource Warrden has created (webhook notifications, `warrden-` tags, `warrden: `
 * release profiles). Registration paths use it to record what they created (or found
 * already existing), and GC (`reconcile.ts`'s `gc()`) uses it to find orphans to clean up. Keeping the
 * SQL here means neither side hand-rolls it.
 */
export class ManagedObjects {
  constructor(private readonly db: Database.Database) {}

  /**
   * Upsert: re-registering an existing (arrInstance, kind, externalId) triple refreshes
   * `created_at` rather than being a no-op — everything else about the row is left as
   * first recorded. `created_at` therefore means "last (re-)registered at," not "first
   * created at": GC (`reconcile.ts`'s `gc()`) uses it as a grace-period clock, and a re-pin of an existing
   * tag/profile (`pinReleaseGroup` re-registering on every call, idempotent or not) needs
   * to restart that clock — otherwise a long-lived row re-pinned moments ago could still
   * read as old enough to GC from under it.
   */
  insert(o: InsertManagedObjectInput): void {
    this.db
      .prepare(
        `INSERT INTO managed_objects (arr_instance, kind, external_id, name, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(arr_instance, kind, external_id) DO UPDATE SET created_at = excluded.created_at`,
      )
      .run(o.arrInstance, o.kind, o.externalId, o.name ?? null, JSON.stringify(o.data ?? {}), Date.now());
  }

  get(id: number): ManagedObjectRow | null {
    const row = this.db.prepare(`SELECT * FROM managed_objects WHERE id = ?`).get(id) as ManagedObjectRowRaw | undefined;
    return row ? parseRow(row) : null;
  }

  list(opts?: { arrInstance?: string; kind?: ManagedObjectKind }): ManagedObjectRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts?.arrInstance !== undefined) {
      clauses.push('arr_instance = ?');
      params.push(opts.arrInstance);
    }
    if (opts?.kind !== undefined) {
      clauses.push('kind = ?');
      params.push(opts.kind);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM managed_objects${where} ORDER BY id ASC`).all(...params) as ManagedObjectRowRaw[];
    return rows.map(parseRow);
  }

  delete(arrInstance: string, kind: ManagedObjectKind, externalId: number): void {
    this.db.prepare(`DELETE FROM managed_objects WHERE arr_instance = ? AND kind = ? AND external_id = ?`).run(arrInstance, kind, externalId);
  }
}
