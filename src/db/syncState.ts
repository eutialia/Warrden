import type Database from 'better-sqlite3';

/**
 * Typed wrapper over the `sync_state` table: arbitrary small pieces of app state, one JSON
 * value per string key. `reconcile.ts` uses it for its `bootstrap:<instance>` flags,
 * `seen:<instance>` id sets, and `history:<instance>` import-history cursors (the ingest
 * webhook backstop). Kept alongside `ManagedObjects`/`AcquireRecords` as the one place that
 * owns this table's SQL — the dashboard's server routes can read the same rows through this class
 * instead of hand-rolling the query.
 */
export class SyncState {
  constructor(private readonly db: Database.Database) {}

  read<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as { value: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.value) as T);
  }

  write(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO sync_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, JSON.stringify(value));
  }
}
