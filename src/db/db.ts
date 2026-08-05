import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved relative to this module's own location (not process.cwd()) so it finds
// migrations/*.sql both in dev (src/db/migrations) and in the built layout
// (dist/db/migrations) — the build step copies the .sql files alongside the
// compiled db.js since tsc does not emit non-TS assets.
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

interface MigrationRow {
  name: string;
}

/** Opens (creating if needed) the warrden SQLite database in `dataDir`, applying any pending migrations. */
export function openDb(dataDir: string): Database.Database {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'warrden.db'));
  db.pragma('journal_mode = WAL');
  runMigrations(db);
  return db;
}

function runMigrations(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY)');

  const applied = new Set(
    db
      .prepare('SELECT name FROM migrations')
      .all()
      .map((row) => (row as MigrationRow).name),
  );

  const pending = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .filter((name) => !applied.has(name));

  for (const name of pending) {
    const sql = readFileSync(join(MIGRATIONS_DIR, name), 'utf-8');
    const applyMigration = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO migrations (name) VALUES (?)').run(name);
    });
    applyMigration();
  }
}
