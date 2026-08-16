import { describe, it, expect, vi } from 'vitest';
import { SqlTracer, NOOP_TRACER } from '../src/trace/tracer.js';
import { TraceEntries } from '../src/db/traceEntries.js';
import { EventLog } from '../src/events/log.js';
import { freshDb } from './helpers.js';

function setup(enabled: () => boolean) {
  const db = freshDb();
  const events = new EventLog(db);
  return { tracer: new SqlTracer(db, events, enabled), store: new TraceEntries(db), events };
}

describe('SqlTracer', () => {
  it('never invokes payload thunks when disabled', () => {
    const { tracer, store } = setup(() => false);
    const thunk = vi.fn(() => ({ big: 'payload' }));
    const step = tracer.begin({ jobId: 1, kind: 'a', summary: 'a', payload: thunk });
    step.end('ok', thunk);
    tracer.event({ jobId: 1, kind: 'b', summary: 'b', payload: thunk });
    expect(thunk).not.toHaveBeenCalled();
    expect(step.seq).toBeNull();
    expect(store.listByJob(1)).toHaveLength(0);
  });

  it('writes begin/end and broadcasts trace.appended when enabled', () => {
    const { tracer, store, events } = setup(() => true);
    const kinds: string[] = [];
    events.subscribe((e) => kinds.push(e.kind));
    const step = tracer.begin({ jobId: 1, kind: 'llm.call', summary: 'pick', payload: () => ({ q: 1 }) });
    expect(step.seq).toBe(0);
    step.end('ok', () => ({ out: 2 }));
    const rows = store.listByJob(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('ok');
    expect(JSON.parse(rows[0].payload ?? '')).toEqual({ out: 2 });
    expect(kinds).toEqual(['trace.appended', 'trace.appended']);
    expect(events.list()).toHaveLength(0);
  });

  it('reads the switch live per call', () => {
    let on = false;
    const { tracer, store } = setup(() => on);
    tracer.event({ jobId: 1, kind: 'a', summary: 'off' });
    on = true;
    tracer.event({ jobId: 1, kind: 'b', summary: 'on' });
    expect(store.listByJob(1).map((r) => r.kind)).toEqual(['b']);
  });

  it('swallows storage failures instead of failing the caller', () => {
    const db = freshDb();
    db.exec('DROP TABLE trace_entries');
    const tracer = new SqlTracer(db, new EventLog(db), () => true);
    expect(() => tracer.event({ jobId: 1, kind: 'a', summary: 'a' })).not.toThrow();
  });

  it('NOOP_TRACER is inert', () => {
    const h = NOOP_TRACER.begin({ jobId: 1, kind: 'a', summary: 'a' });
    expect(h.seq).toBeNull();
    expect(() => h.end('ok')).not.toThrow();
  });
});
