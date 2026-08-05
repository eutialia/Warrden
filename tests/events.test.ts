import { describe, it, expect, vi } from 'vitest';
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
});
