import { describe, it, expect } from 'vitest';
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
});
