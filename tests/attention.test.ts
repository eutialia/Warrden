import { describe, it, expect, vi } from 'vitest';
import { AttentionItems } from '../src/db/attention.js';
import { freshDb, withFakeTime } from './helpers.js';

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
    withFakeTime(() => {
      const items = new AttentionItems(freshDb());
      vi.setSystemTime(1_000);
      const first = items.open({ kind: 'ingest.no-match', message: 'first', jobId: 1, data: { n: 1 } });

      vi.setSystemTime(2_000);
      const second = items.open({ kind: 'ingest.no-match', message: 'second', jobId: 1, data: { n: 2 } });

      expect(second.id).toBe(first.id);
      expect(items.list()).toHaveLength(1);
      const row = items.get(first.id)!;
      expect(row).toMatchObject({ ts: 2_000, message: 'second', data: { n: 2 } });
    });
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

  describe('target-key dedupe (data carries instance/targetKind/targetId)', () => {
    it('collapses cross-job repeat proposals for the same target into one open row, refreshing ts/message/data/job_id to the latest', () => {
      withFakeTime(() => {
        const items = new AttentionItems(freshDb());
        vi.setSystemTime(1_000);
        const first = items.open({
          kind: 'ingest.rescue-proposed',
          message: 'first proposal',
          jobId: 10,
          data: { action: 'bundle-import', instance: 'sonarr', targetKind: 'series', targetId: 42, files: ['a'], reasoning: 'r1' },
        });

        vi.setSystemTime(2_000);
        const second = items.open({
          kind: 'ingest.rescue-proposed',
          message: 'second proposal',
          jobId: 11, // a different job re-triggered the same rescue
          data: { action: 'bundle-import', instance: 'sonarr', targetKind: 'series', targetId: 42, files: ['a', 'b'], reasoning: 'r2' },
        });

        expect(second.id).toBe(first.id);
        expect(items.list()).toHaveLength(1);
        expect(items.get(first.id)).toMatchObject({
          ts: 2_000,
          message: 'second proposal',
          job_id: 11,
          data: { instance: 'sonarr', targetKind: 'series', targetId: 42, files: ['a', 'b'], reasoning: 'r2' },
        });
      });
    });

    it('keeps proposals for different targets (series id, instance, or kind) as separate open rows', () => {
      const items = new AttentionItems(freshDb());
      items.open({ kind: 'ingest.rescue-proposed', message: 'series 42', jobId: 1, data: { instance: 'sonarr', targetKind: 'series', targetId: 42 } });
      items.open({ kind: 'ingest.rescue-proposed', message: 'series 43', jobId: 2, data: { instance: 'sonarr', targetKind: 'series', targetId: 43 } });
      items.open({ kind: 'ingest.rescue-proposed', message: 'radarr movie 42', jobId: 3, data: { instance: 'radarr', targetKind: 'movie', targetId: 42 } });

      expect(items.list()).toHaveLength(3);
    });

    it('does not dedupe against a target-keyed row that is no longer open', () => {
      const items = new AttentionItems(freshDb());
      const data = { instance: 'sonarr', targetKind: 'series', targetId: 42 };
      const first = items.open({ kind: 'ingest.rescue-proposed', message: 'first', jobId: 1, data });
      items.setStatus(first.id, 'resolved');
      const second = items.open({ kind: 'ingest.rescue-proposed', message: 'second', jobId: 2, data });
      expect(second.id).not.toBe(first.id);
      expect(items.list()).toHaveLength(2);
    });

    it('a different kind with the same target does not dedupe (kind is still part of the key)', () => {
      const items = new AttentionItems(freshDb());
      const data = { instance: 'sonarr', targetKind: 'series', targetId: 42 };
      items.open({ kind: 'ingest.rescue-proposed', message: 'first', jobId: 1, data });
      items.open({ kind: 'ingest.mount-missing', message: 'second', jobId: 1, data });
      expect(items.list()).toHaveLength(2);
    });

    it('refreshing a target-keyed row with no jobId of its own (COALESCE) keeps the existing job link instead of nulling it out', () => {
      const items = new AttentionItems(freshDb());
      const data = { instance: 'sonarr', targetKind: 'series', targetId: 42 };
      const first = items.open({ kind: 'ingest.rescue-proposed', message: 'first', jobId: 7, data });

      const second = items.open({ kind: 'ingest.rescue-proposed', message: 'second' /* no jobId */, data });

      expect(second.id).toBe(first.id);
      expect(items.get(first.id)).toMatchObject({ job_id: 7, message: 'second' });
    });
  });

  describe('target-key dedupe with a per-emission discriminator (dedupeKey)', () => {
    it('two emissions for the same target but different dedupeKeys stay separate open rows', () => {
      const items = new AttentionItems(freshDb());
      items.open({
        kind: 'ingest.unmatched',
        message: 'sidecar A',
        jobId: 1,
        data: { instance: 'sonarr', targetKind: 'series', targetId: 42, sidecarPath: '/a.ass', dedupeKey: '/a.ass' },
      });
      items.open({
        kind: 'ingest.unmatched',
        message: 'sidecar B',
        jobId: 1,
        data: { instance: 'sonarr', targetKind: 'series', targetId: 42, sidecarPath: '/b.ass', dedupeKey: '/b.ass' },
      });

      expect(items.list()).toHaveLength(2);
    });

    it('two emissions for the same target and the same dedupeKey still collapse (refresh, not duplicate)', () => {
      withFakeTime(() => {
        const items = new AttentionItems(freshDb());
        vi.setSystemTime(1_000);
        const first = items.open({
          kind: 'acquire.none-viable',
          message: 'season 1 first',
          jobId: 1,
          data: { instance: 'sonarr', targetKind: 'series', targetId: 42, seasonNumber: 1, dedupeKey: '1' },
        });

        vi.setSystemTime(2_000);
        const second = items.open({
          kind: 'acquire.none-viable',
          message: 'season 1 retried',
          jobId: 2,
          data: { instance: 'sonarr', targetKind: 'series', targetId: 42, seasonNumber: 1, dedupeKey: '1' },
        });

        expect(second.id).toBe(first.id);
        expect(items.list()).toHaveLength(1);
      });
    });

    it('a dedupeKey-carrying emission does not collapse against a plain target-keyed row (undefined dedupeKey is its own bucket)', () => {
      const items = new AttentionItems(freshDb());
      items.open({
        kind: 'ingest.mount-missing',
        message: 'mount missing',
        jobId: 1,
        data: { instance: 'sonarr', targetKind: 'series', targetId: 42 },
      });
      items.open({
        kind: 'ingest.mount-missing',
        message: 'sub-target failure',
        jobId: 2,
        data: { instance: 'sonarr', targetKind: 'series', targetId: 42, dedupeKey: 'x' },
      });

      expect(items.list()).toHaveLength(2);
    });

    it('a numeric dedupeKey still dedupes (normalized to a string on both sides, not silently ignored)', () => {
      const items = new AttentionItems(freshDb());
      const data = { instance: 'sonarr', targetKind: 'series', targetId: 42, dedupeKey: 1 };
      const first = items.open({ kind: 'job.attention', message: 'first', jobId: 1, data });
      const second = items.open({ kind: 'job.attention', message: 'second', jobId: 2, data });

      expect(second.id).toBe(first.id);
      expect(items.list()).toHaveLength(1);
    });
  });

  describe('setStatus', () => {
    it('transitions an open row and stamps resolved_at', () => {
      withFakeTime(() => {
        vi.setSystemTime(1_000);
        const items = new AttentionItems(freshDb());
        const row = items.open({ kind: 'k', message: 'm' });
        vi.setSystemTime(5_000);
        expect(items.setStatus(row.id, 'resolved')).toBe(true);
        expect(items.get(row.id)).toMatchObject({ status: 'resolved', resolved_at: 5_000 });
      });
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
      withFakeTime(() => {
        const items = new AttentionItems(freshDb());
        vi.setSystemTime(1_000);
        const a = items.open({ kind: 'a', message: 'a' });
        vi.setSystemTime(1_000);
        const b = items.open({ kind: 'b', message: 'b' });
        vi.setSystemTime(2_000);
        const c = items.open({ kind: 'c', message: 'c' });

        expect(items.list().map((r) => r.id)).toEqual([c.id, b.id, a.id]);
      });
    });
  });

  it('get returns null for an unknown id', () => {
    const items = new AttentionItems(freshDb());
    expect(items.get(999)).toBeNull();
  });
});
