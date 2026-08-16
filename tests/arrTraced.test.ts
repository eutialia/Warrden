import { describe, it, expect } from 'vitest';
import { traceArrClient } from '../src/arr/traced.js';
import { SqlTracer } from '../src/trace/tracer.js';
import { TraceEntries } from '../src/db/traceEntries.js';
import { EventLog } from '../src/events/log.js';
import { freshDb } from './helpers.js';
import type { ArrApi } from '../src/arr/types.js';

function setup() {
  const db = freshDb();
  return { db, tracer: new SqlTracer(db, new EventLog(db), () => true), store: new TraceEntries(db) };
}

describe('traceArrClient', () => {
  it('records method name, args and result for successful calls', async () => {
    const { tracer, store } = setup();
    const fake = {
      searchReleases: async (p: unknown) => [{ guid: 'g1' }],
    } as unknown as ArrApi;
    const traced = traceArrClient(fake, tracer, 9);
    const releases = await traced.searchReleases({ movieId: 1 });
    expect(releases).toEqual([{ guid: 'g1' }]);
    const rows = store.listByJob(9);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('arr.request');
    expect(rows[0].summary).toBe('searchReleases');
    expect(rows[0].status).toBe('ok');
    expect(JSON.parse(rows[0].payload ?? '')).toEqual({ args: [{ movieId: 1 }], result: [{ guid: 'g1' }] });
  });

  it('records errors, rethrows, and flags grabRelease as a side effect', async () => {
    const { tracer, store } = setup();
    const fake = {
      grabRelease: async () => {
        throw new Error('indexer down');
      },
    } as unknown as ArrApi;
    const traced = traceArrClient(fake, tracer, 9);
    await expect(traced.grabRelease('g', 1)).rejects.toThrow('indexer down');
    const row = store.listByJob(9)[0];
    expect(row.status).toBe('error');
    expect(row.side_effect).toBe(1);
  });
});
