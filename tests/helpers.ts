import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { ArrClient } from '../src/arr/client.js';
import type { AppContext } from '../src/context.js';
import { ConfigSchema } from '../src/config/schema.js';
import { openDb } from '../src/db/db.js';
import { EventLog } from '../src/events/log.js';
import { JobQueue } from '../src/jobs/queue.js';

const createdDirs: string[] = [];
const openDbs: Database.Database[] = [];

/** Creates a fresh temp directory for a test, e.g. as a data dir for config/db files. */
export function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'warrden-'));
  createdDirs.push(dir);
  return dir;
}

/** Opens a fresh SQLite db in a new temp dir. Closed and cleaned up via cleanupTmpDirs(). */
export function freshDb(): Database.Database {
  const db = openDb(tmpDir());
  openDbs.push(db);
  return db;
}

/**
 * Builds a real `AppContext` backed by a fresh temp db, wired with a real queue and
 * event log, default config, and an empty arr clients map. Individual fields can be
 * swapped via `overrides` (e.g. a `clients` map seeded with fakes for pipeline tests).
 */
export function makeCtx(overrides?: Partial<AppContext>): AppContext {
  const db = freshDb();
  return {
    db,
    config: ConfigSchema.parse({}),
    queue: new JobQueue(db),
    events: new EventLog(db),
    clients: new Map<string, ArrClient>(),
    ...overrides,
  };
}

/**
 * Closes every db opened via freshDb() and removes every directory created via
 * tmpDir() so far, in this test file's module instance. Called from tests/setup.ts —
 * `process.on('exit')` doesn't fire reliably under Vitest's worker pool, so cleanup
 * has to be a Vitest lifecycle hook instead.
 */
export function cleanupTmpDirs(): void {
  for (const db of openDbs.splice(0)) {
    db.close();
  }
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
