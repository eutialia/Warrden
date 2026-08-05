import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/db.js';
import { freshDb, tmpDir } from './helpers.js';

describe('db', () => {
  it('creates schema and is idempotent across reopens', () => {
    const dir = tmpDir();
    const db1 = openDb(dir);
    const tables = db1
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const t of ['jobs', 'events', 'acquire_records', 'managed_objects', 'sync_state']) expect(tables).toContain(t);
    expect(db1.pragma('journal_mode', { simple: true })).toBe('wal');
    db1.close();
    expect(() => openDb(dir).close()).not.toThrow(); // migrations idempotent
  });
  it('enforces the singleton index on active jobs only', () => {
    const db = freshDb();
    const ins = db.prepare(`INSERT INTO jobs (pipeline, target_kind, target_id, arr_instance, status, created_at, updated_at)
                            VALUES ('acquire','series',1,'sonarr',?, 0, 0)`);
    ins.run('pending');
    expect(() => ins.run('pending')).toThrow();
    ins.run('done'); // completed rows don't collide
  });
});
