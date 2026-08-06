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
  });
});
