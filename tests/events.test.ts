import { describe, it, expect, vi } from 'vitest';
import { AttentionItems } from '../src/db/attention.js';
import { EventLog } from '../src/events/log.js';
import { freshDb } from './helpers.js';

describe('EventLog', () => {
  it('appends, lists newest-first, and notifies subscribers', () => {
    const log = new EventLog(freshDb());
    const seen: string[] = [];
    const unsub = log.subscribe((e) => seen.push(e.kind));
    log.append({ kind: 'job.started', message: 'Acquire started' });
    log.append({ kind: 'job.done', message: 'Acquire done', level: 'info' });
    expect(log.list({ limit: 10 }).map((e) => e.kind)).toEqual(['job.done', 'job.started']);
    expect(seen).toEqual(['job.started', 'job.done']);
    unsub();
    log.append({ kind: 'x', message: 'x' });
    expect(seen).toHaveLength(2);
  });
  it('filters by level for the Attention view', () => {
    const log = new EventLog(freshDb());
    log.append({ kind: 'a', message: 'a' });
    log.append({ kind: 'b', message: 'b', level: 'attention' });
    expect(log.list({ level: 'attention' }).map((e) => e.kind)).toEqual(['b']);
  });

  it('does not let a throwing subscriber break the append or starve other subscribers', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = new EventLog(freshDb());
    const seen: string[] = [];
    log.subscribe(() => {
      throw new Error('boom');
    });
    log.subscribe((e) => seen.push(e.kind));

    const row = log.append({ kind: 'job.started', message: 'go' });

    expect(row.kind).toBe('job.started'); // row is still persisted and returned
    expect(seen).toEqual(['job.started']); // the healthy subscriber still ran
    consoleError.mockRestore();
  });

  describe('attention mirror', () => {
    it('an attention-level append creates an open attention item with the same kind/message/jobId/data', () => {
      const db = freshDb();
      const log = new EventLog(db);
      const attention = new AttentionItems(db);

      log.append({ kind: 'ingest.no-match', level: 'attention', message: 'No sidecar match', jobId: 3, data: { file: 'a.ass' } });

      const items = attention.list({ status: 'open' });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ kind: 'ingest.no-match', message: 'No sidecar match', job_id: 3, data: { file: 'a.ass' } });
    });

    it.each(['info', 'warn'] as const)('a %s-level append does not create an attention item', (level) => {
      const db = freshDb();
      const log = new EventLog(db);
      const attention = new AttentionItems(db);

      log.append({ kind: 'k', level, message: 'm' });

      expect(attention.list()).toHaveLength(0);
    });

    it('two attention appends with the same kind+jobId leave exactly one open row', () => {
      const db = freshDb();
      const log = new EventLog(db);
      const attention = new AttentionItems(db);

      log.append({ kind: 'ingest.no-match', level: 'attention', message: 'first', jobId: 3 });
      log.append({ kind: 'ingest.no-match', level: 'attention', message: 'second', jobId: 3 });

      const items = attention.list({ status: 'open' });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ message: 'second' });
    });

    it('mirrors before fanning out to subscribers — a subscriber already sees the attention item', () => {
      const db = freshDb();
      const log = new EventLog(db);
      const attention = new AttentionItems(db);
      let seenDuringFanout = -1;

      log.subscribe(() => {
        seenDuringFanout = attention.list({ status: 'open' }).length;
      });

      log.append({ kind: 'ingest.no-match', level: 'attention', message: 'm' });

      expect(seenDuringFanout).toBe(1);
    });

    it('a mirror write failure does not stop the row from being persisted/returned or reaching subscribers', () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const db = freshDb();
      const log = new EventLog(db);
      db.exec('DROP TABLE attention_items');
      const seen: string[] = [];
      log.subscribe((e) => seen.push(e.kind));

      const row = log.append({ kind: 'ingest.no-match', level: 'attention', message: 'm' });

      expect(row.kind).toBe('ingest.no-match'); // row is still persisted and returned
      expect(seen).toEqual(['ingest.no-match']); // subscribers still ran
      expect(consoleError).toHaveBeenCalledWith('EventLog attention mirror failed', expect.anything());
      consoleError.mockRestore();
    });
  });

  describe('prune', () => {
    const NOW = 1_800_000_000_000;
    const DAY = 24 * 60 * 60 * 1000;

    /** `append` stamps its own `ts`, so ages are restated afterwards. */
    function ageEvent(db: ReturnType<typeof freshDb>, id: number, ts: number): void {
      db.prepare('UPDATE events SET ts = ? WHERE id = ?').run(ts, id);
    }

    it.each([
      { retentionDays: 30, kept: ['fresh', 'edge'], removed: 1 },
      { retentionDays: 7, kept: ['fresh'], removed: 2 },
    ])('keeps only what is inside a $retentionDays-day window', ({ retentionDays, kept, removed }) => {
      const db = freshDb();
      const log = new EventLog(db);
      const fresh = log.append({ kind: 'fresh', message: 'm' });
      const edge = log.append({ kind: 'edge', message: 'm' });
      const old = log.append({ kind: 'old', message: 'm' });
      ageEvent(db, fresh.id, NOW - DAY);
      ageEvent(db, edge.id, NOW - 20 * DAY);
      ageEvent(db, old.id, NOW - 200 * DAY);

      expect(log.prune(retentionDays, NOW)).toBe(removed);
      expect(log.list().map((e) => e.kind).sort()).toEqual([...kept].sort());
    });

    it('keeps everything when retention is zero', () => {
      const db = freshDb();
      const log = new EventLog(db);
      const old = log.append({ kind: 'old', message: 'm' });
      ageEvent(db, old.id, NOW - 3650 * DAY);

      expect(log.prune(0, NOW)).toBe(0);
      expect(log.list()).toHaveLength(1);
    });

    it('leaves attention items alone — they are decisions, not history', () => {
      const db = freshDb();
      const log = new EventLog(db);
      const raised = log.append({ kind: 'ingest.no-match', level: 'attention', message: 'needs a human' });
      ageEvent(db, raised.id, NOW - 200 * DAY);

      log.prune(30, NOW);

      expect(log.list()).toHaveLength(0);
      expect(new AttentionItems(db).list({ status: 'open' })).toHaveLength(1);
    });
  });
});

describe('EventLog.broadcast', () => {
  it('fans out to subscribers without persisting a row', () => {
    const log = new EventLog(freshDb());
    const seen: string[] = [];
    log.subscribe((e) => seen.push(e.kind));
    log.broadcast({ kind: 'trace.appended', jobId: 3, message: '', data: { seq: 5 } });
    expect(seen).toEqual(['trace.appended']);
    expect(log.list()).toHaveLength(0);
  });

  it('isolates subscriber failures like append does', () => {
    const log = new EventLog(freshDb());
    log.subscribe(() => {
      throw new Error('boom');
    });
    const seen: number[] = [];
    log.subscribe((e) => seen.push(e.job_id ?? -1));
    expect(() => log.broadcast({ kind: 'trace.appended', jobId: 1, message: '' })).not.toThrow();
    expect(seen).toEqual([1]);
  });
});

describe('EventLog.listByJob', () => {
  it("returns only that job's events, oldest first", () => {
    const events = new EventLog(freshDb());
    events.append({ kind: 'a.one', jobId: 1, message: 'first' });
    events.append({ kind: 'b.other', jobId: 2, message: 'other job' });
    events.append({ kind: 'a.two', jobId: 1, message: 'second' });

    const rows = events.listByJob(1);

    expect(rows.map((r) => r.message)).toEqual(['first', 'second']);
  });

  it('returns an empty array for a job that logged nothing', () => {
    expect(new EventLog(freshDb()).listByJob(99)).toEqual([]);
  });

  it('never returns rows with no job attached', () => {
    const events = new EventLog(freshDb());
    events.append({ kind: 'global.thing', message: 'no job' });
    expect(events.listByJob(1)).toEqual([]);
  });

  it('parses the data column, matching list()', () => {
    const events = new EventLog(freshDb());
    events.append({ kind: 'a.one', jobId: 1, message: 'm', data: { counts: { missing: 0 } } });
    expect(events.listByJob(1)[0]!.data).toEqual({ counts: { missing: 0 } });
  });
});
