import { describe, it, expect } from 'vitest';
import { AcquireRecords } from '../src/db/acquireRecords.js';
import { freshDb } from './helpers.js';

describe('AcquireRecords', () => {
  it('inserts a record and reads it back via listByTarget, newest first', () => {
    const records = new AcquireRecords(freshDb());
    records.insert({ arrInstance: 'sonarr', targetKind: 'series', targetId: 42, status: 'no-candidates', source: 'webhook' });
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

  describe('outcomeForJob', () => {
    it.each([
      { statuses: ['no-candidates', 'grabbed', 'none-viable'], expected: 'grabbed' },
      { statuses: ['no-candidates', 'none-viable'], expected: 'none-viable' },
      { statuses: ['no-candidates', 'no-candidates'], expected: 'no-candidates' },
      { statuses: [], expected: null },
    ] as const)('aggregates $statuses to $expected (grabbed > none-viable > no-candidates)', ({ statuses, expected }) => {
      const db = freshDb();
      const records = new AcquireRecords(db);
      const sinceCreatedAt = Date.now();
      for (const status of statuses) {
        records.insert({ arrInstance: 'sonarr', targetKind: 'series', targetId: 42, status });
      }
      expect(records.outcomeForJob('sonarr', 'series', 42, sinceCreatedAt)).toBe(expected);
    });

    it('ignores records older than the job itself', () => {
      const db = freshDb();
      const records = new AcquireRecords(db);
      records.insert({ arrInstance: 'sonarr', targetKind: 'series', targetId: 42, status: 'grabbed' });
      const sinceCreatedAt = Date.now() + 1000; // job enqueued strictly after that old record
      expect(records.outcomeForJob('sonarr', 'series', 42, sinceCreatedAt)).toBeNull();
    });
  });
});
