import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/db.js';

describe('db', () => {
  it('creates schema and is idempotent across reopens', () => {
    const dir = mkdtempSync(join(tmpdir(), 'warrden-db-'));
    const db1 = openDb(dir);
    const tables = db1.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
    for (const t of ['jobs', 'events', 'acquire_records', 'managed_objects', 'sync_state']) expect(tables).toContain(t);
    expect(db1.pragma('journal_mode', { simple: true })).toBe('wal');
    db1.close();
    expect(() => openDb(dir).close()).not.toThrow(); // migrations idempotent
  });
  it('enforces the singleton index on active jobs only', () => {
    const db = openDb(mkdtempSync(join(tmpdir(), 'warrden-db-')));
    const ins = db.prepare(`INSERT INTO jobs (pipeline, target_kind, target_id, arr_instance, status, created_at, updated_at)
                            VALUES ('acquire','series',1,'sonarr',?, 0, 0)`);
    ins.run('pending');
    expect(() => ins.run('pending')).toThrow();
    ins.run('done'); // completed rows don't collide
  });
});
