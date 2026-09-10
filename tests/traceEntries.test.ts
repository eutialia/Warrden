import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { TraceEntries, serializePayload, PAYLOAD_CAP_BYTES, PAYLOAD_LEAF_HEAD_BYTES } from '../src/db/traceEntries.js';
import { freshDb } from './helpers.js';

let db: Database.Database;
let t: TraceEntries;
beforeEach(() => {
  db = freshDb();
  t = new TraceEntries(db);
});

describe('TraceEntries', () => {
  it('allocates seq from 0 per job, independently across jobs', () => {
    expect(t.append({ jobId: 1, kind: 'a', summary: 'a' })).toBe(0);
    expect(t.append({ jobId: 1, kind: 'b', summary: 'b' })).toBe(1);
    expect(t.append({ jobId: 2, kind: 'a', summary: 'a' })).toBe(0);
  });

  it('continues seq across separate executions of the same job id', () => {
    t.append({ jobId: 7, kind: 'a', summary: 'first run' });
    // simulate a reschedule: nothing in memory survives, only the DB
    const again = new TraceEntries(db);
    expect(again.append({ jobId: 7, kind: 'b', summary: 'second run' })).toBe(1);
  });

  it('finish sets ts_end and status, and replaces payload when given', () => {
    const seq = t.append({ jobId: 1, kind: 'llm.call', summary: 'pick', payload: { input: 'x' } });
    t.finish(1, seq, 'ok', { output: 'y' });
    const row = t.get(1, seq);
    expect(row?.status).toBe('ok');
    expect(row?.ts_end).toBeTypeOf('number');
    expect(JSON.parse(row?.payload ?? '')).toEqual({ output: 'y' });
  });

  it('stores an over-cap payload that is one huge value as a valid-JSON truncation envelope', () => {
    const big = 'x'.repeat(PAYLOAD_CAP_BYTES + 1000);
    const seq = t.append({ jobId: 1, kind: 'arr.request', summary: 'big', payload: big });
    const parsed = JSON.parse(t.get(1, seq)?.payload ?? '') as { truncated: boolean; bytes: number; head: string };
    expect(parsed.truncated).toBe(true);
    expect(parsed.bytes).toBeGreaterThan(PAYLOAD_CAP_BYTES);
    expect(parsed.head.length).toBeGreaterThan(0);
  });

  it('listByJob returns entries ordered by seq; get misses return null', () => {
    t.append({ jobId: 1, kind: 'a', summary: 'a' });
    t.append({ jobId: 1, kind: 'b', summary: 'b', parentSeq: 0 });
    const rows = t.listByJob(1);
    expect(rows.map((r) => r.seq)).toEqual([0, 1]);
    expect(rows[1].parent_seq).toBe(0);
    expect(t.get(9, 0)).toBeNull();
  });

  it('headersByJob drops the payload column and reports whether there was one', () => {
    t.append({ jobId: 1, kind: 'a', summary: 'a' });
    t.append({ jobId: 1, kind: 'b', summary: 'b', payload: { input: 'x' } });
    const rows = t.headersByJob(1);
    expect(rows.map((r) => r.hasPayload)).toEqual([false, true]);
    expect(rows[0]).not.toHaveProperty('payload');
  });

  it('prune deletes jobs whose entries are all older than the cutoff', () => {
    const now = Date.now();
    t.append({ jobId: 1, kind: 'a', summary: 'old', tsStart: now - 8 * 24 * 3600 * 1000 });
    t.append({ jobId: 2, kind: 'a', summary: 'new', tsStart: now });
    expect(t.prune(7, now)).toBe(1);
    expect(t.listByJob(1)).toHaveLength(0);
    expect(t.listByJob(2)).toHaveLength(1);
  });

  it('prune deletes nothing for a zero or negative retention', () => {
    const now = Date.now();
    t.append({ jobId: 1, kind: 'a', summary: 'old', tsStart: now - 8 * 24 * 3600 * 1000 });
    expect(t.prune(0, now)).toBe(0);
    expect(t.prune(-1, now)).toBe(0);
    expect(t.listByJob(1)).toHaveLength(1);
  });

  it('serializePayload passes small values through unchanged', () => {
    expect(JSON.parse(serializePayload({ a: 1 }))).toEqual({ a: 1 });
    expect(serializePayload(undefined)).toBe('null');
  });

  it('serializePayload truncates only the oversized member of an object, keeping the small facts', () => {
    const usage = { inputTokens: 100, outputTokens: 7 };
    const parsed = JSON.parse(
      serializePayload({ usage, output: { pick: 'a' }, request: { body: 'x'.repeat(PAYLOAD_CAP_BYTES + 1000) } }),
    ) as { usage: unknown; output: unknown; request: { truncated: boolean; bytes: number; head: string } };
    expect(parsed.usage).toEqual(usage);
    expect(parsed.output).toEqual({ pick: 'a' });
    expect(parsed.request.truncated).toBe(true);
    expect(parsed.request.bytes).toBeGreaterThan(PAYLOAD_CAP_BYTES);
    expect(parsed.request.head.length).toBe(PAYLOAD_LEAF_HEAD_BYTES);
  });

  it('serializePayload falls back to the whole-payload envelope when shedding members is not enough', () => {
    const member = 'x'.repeat(PAYLOAD_LEAF_HEAD_BYTES * 2);
    const wide = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`m${i}`, member]));
    const parsed = JSON.parse(serializePayload(wide)) as { truncated: boolean; bytes: number };
    expect(parsed.truncated).toBe(true);
    expect(parsed.bytes).toBeGreaterThan(PAYLOAD_CAP_BYTES);
  });
});
