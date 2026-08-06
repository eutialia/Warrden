import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AcquireRecords } from '../src/db/acquireRecords.js';
import { freshDb } from './helpers.js';

describe('AcquireRecords', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('inserts a record and reads it back via listByTarget, newest first', () => {
    const records = new AcquireRecords(freshDb());
    records.insert({ arrInstance: 'sonarr', targetKind: 'series', targetId: 42, status: 'no-candidates', source: 'webhook' });
    // The table's uniqueness key includes created_at (ms resolution) — in production
    // recordOutcome only ever fires once per serially-processed job, so two inserts for
    // the same target in the same millisecond can't happen there; advance the fake clock
    // here purely so this test's two back-to-back inserts don't collide with each other.
    vi.advanceTimersByTime(1);
    records.insert({
      arrInstance: 'sonarr',
      targetKind: 'series',
      targetId: 42,
      status: 'grabbed',
      source: 'webhook',
      pickedGuid: 'g1',
      releaseGroup: 'SubsPlease',
      reasoning: 'matches policy',
      candidates: { kept: [{ guid: 'g1' }], dropped: [] },
    });

    const rows = records.listByTarget('sonarr', 'series', 42);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: 'grabbed', picked_guid: 'g1', release_group: 'SubsPlease' });
    expect(rows[0]!.candidates_json).toEqual({ kept: [{ guid: 'g1' }], dropped: [] });
    expect(rows[1]).toMatchObject({ status: 'no-candidates', picked_guid: null });
  });

  it('scopes listByTarget to the given (arrInstance, targetKind, targetId)', () => {
    const records = new AcquireRecords(freshDb());
    records.insert({ arrInstance: 'sonarr', targetKind: 'series', targetId: 42, status: 'grabbed' });
    records.insert({ arrInstance: 'sonarr', targetKind: 'series', targetId: 43, status: 'grabbed' });
    records.insert({ arrInstance: 'radarr', targetKind: 'movie', targetId: 42, status: 'grabbed' });

    expect(records.listByTarget('sonarr', 'series', 42)).toHaveLength(1);
    expect(records.listByTarget('sonarr', 'series', 99)).toHaveLength(0);
  });

  it('defaults source to null when not given', () => {
    const records = new AcquireRecords(freshDb());
    records.insert({ arrInstance: 'sonarr', targetKind: 'series', targetId: 42, status: 'none-viable' });
    expect(records.listByTarget('sonarr', 'series', 42)[0]).toMatchObject({ source: null });
  });
});
