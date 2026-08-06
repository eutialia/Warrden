import { describe, it, expect, vi } from 'vitest';
import { AttentionItems } from '../src/db/attention.js';
import { freshDb } from './helpers.js';

describe('AttentionItems', () => {
  it('open() inserts and returns the row', () => {
    const items = new AttentionItems(freshDb());
    const row = items.open({ kind: 'ingest.no-match', message: 'No sidecar match found', jobId: 1, data: { file: 'a.ass' } });
    expect(row).toMatchObject({
      kind: 'ingest.no-match',
      message: 'No sidecar match found',
      job_id: 1,
      data: { file: 'a.ass' },
      status: 'open',
      resolved_at: null,
    });
    expect(items.list()).toHaveLength(1);
  });

  it('a second open() with the same (kind, jobId) while an open row exists refreshes it in place', () => {
    vi.useFakeTimers();
    try {
      const items = new AttentionItems(freshDb());
      vi.setSystemTime(1_000);
      const first = items.open({ kind: 'ingest.no-match', message: 'first', jobId: 1, data: { n: 1 } });

      vi.setSystemTime(2_000);
      const second = items.open({ kind: 'ingest.no-match', message: 'second', jobId: 1, data: { n: 2 } });

      expect(second.id).toBe(first.id);
      expect(items.list()).toHaveLength(1);
      const row = items.get(first.id)!;
      expect(row).toMatchObject({ ts: 2_000, message: 'second', data: { n: 2 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('open() with jobId omitted always creates a new row, even for the same kind', () => {
    const items = new AttentionItems(freshDb());
    items.open({ kind: 'ingest.review', message: 'first' });
    items.open({ kind: 'ingest.review', message: 'second' });
    expect(items.list()).toHaveLength(2);
  });

  it('the same jobId with a different kind does not dedupe (kind is part of the key)', () => {
    const items = new AttentionItems(freshDb());
    items.open({ kind: 'ingest.no-match', message: 'first', jobId: 1 });
    items.open({ kind: 'ingest.ambiguous', message: 'second', jobId: 1 });
    expect(items.list()).toHaveLength(2);
  });

  it('the same kind with a different jobId does not dedupe (jobId is part of the key)', () => {
    const items = new AttentionItems(freshDb());
    items.open({ kind: 'ingest.no-match', message: 'first', jobId: 1 });
    items.open({ kind: 'ingest.no-match', message: 'second', jobId: 2 });
    expect(items.list()).toHaveLength(2);
  });

  it('does not dedupe against a row that is no longer open', () => {
    const items = new AttentionItems(freshDb());
    const first = items.open({ kind: 'ingest.no-match', message: 'first', jobId: 1 });
    items.setStatus(first.id, 'resolved');
    const second = items.open({ kind: 'ingest.no-match', message: 'second', jobId: 1 });
    expect(second.id).not.toBe(first.id);
    expect(items.list()).toHaveLength(2);
  });

  describe('setStatus', () => {
    it('transitions an open row and stamps resolved_at', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(1_000);
        const items = new AttentionItems(freshDb());
        const row = items.open({ kind: 'k', message: 'm' });
        vi.setSystemTime(5_000);
        expect(items.setStatus(row.id, 'resolved')).toBe(true);
        expect(items.get(row.id)).toMatchObject({ status: 'resolved', resolved_at: 5_000 });
      } finally {
        vi.useRealTimers();
      }
    });

    it.each(['dismissed', 'resolved'] as const)('returns false when the row is already %s', (status) => {
      const items = new AttentionItems(freshDb());
      const row = items.open({ kind: 'k', message: 'm' });
      items.setStatus(row.id, status);
      expect(items.setStatus(row.id, 'resolved')).toBe(false);
    });

    it('returns false for an unknown id', () => {
      const items = new AttentionItems(freshDb());
      expect(items.setStatus(999, 'resolved')).toBe(false);
    });
  });

  describe('list', () => {
    it('filters by status', () => {
      const items = new AttentionItems(freshDb());
      const open1 = items.open({ kind: 'k', message: 'a' });
      const open2 = items.open({ kind: 'k2', message: 'b' });
      items.setStatus(open2.id, 'dismissed');

      expect(items.list({ status: 'open' }).map((r) => r.id)).toEqual([open1.id]);
      expect(items.list({ status: 'dismissed' }).map((r) => r.id)).toEqual([open2.id]);
      expect(items.list()).toHaveLength(2);
    });

    it('orders newest-first (ts DESC, id DESC)', () => {
      vi.useFakeTimers();
      try {
        const items = new AttentionItems(freshDb());
        vi.setSystemTime(1_000);
        const a = items.open({ kind: 'a', message: 'a' });
        vi.setSystemTime(1_000);
        const b = items.open({ kind: 'b', message: 'b' });
        vi.setSystemTime(2_000);
        const c = items.open({ kind: 'c', message: 'c' });

        expect(items.list().map((r) => r.id)).toEqual([c.id, b.id, a.id]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('get returns null for an unknown id', () => {
    const items = new AttentionItems(freshDb());
    expect(items.get(999)).toBeNull();
  });
});
