import { describe, it, expect } from 'vitest';
import type { QueueRecord } from '../src/arr/types.js';
import { assessQueue } from '../src/pipelines/ingest/queueState.js';

const seriesTarget = { kind: 'series' as const, id: 42 };

function record(overrides?: Partial<QueueRecord>): QueueRecord {
  return { id: 1, seriesId: 42, status: 'downloading', title: 'x', ...overrides };
}

describe('assessQueue', () => {
  it('settled: no matching records at all', () => {
    expect(assessQueue([], seriesTarget)).toEqual({ state: 'settled' });
  });

  it('settled: a matching record still downloading does not block ingest (a second season fetching)', () => {
    const records = [record({ status: 'downloading' })];
    expect(assessQueue(records, seriesTarget)).toEqual({ state: 'settled' });
  });

  it('records for a different target are ignored entirely', () => {
    const records = [record({ seriesId: 99, status: 'completed', trackedDownloadState: 'importing' })];
    expect(assessQueue(records, seriesTarget)).toEqual({ state: 'settled' });
  });

  it('busy: any matching record completed+importing, regardless of downloadId', () => {
    const records = [record({ downloadId: 'unrelated-dl', status: 'completed', trackedDownloadState: 'importing' })];
    expect(assessQueue(records, seriesTarget)).toEqual({ state: 'busy' });
  });

  it('busy wins even when another matching record looks stuck', () => {
    const records = [
      record({ id: 1, status: 'completed', trackedDownloadState: 'importing' }),
      record({ id: 2, status: 'completed', trackedDownloadStatus: 'warning' }),
    ];
    expect(assessQueue(records, seriesTarget)).toEqual({ state: 'busy' });
  });

  it('stuck: importPending state', () => {
    const records = [record({ downloadId: 'dl-1', trackedDownloadState: 'importPending' })];
    expect(assessQueue(records, seriesTarget)).toEqual({ state: 'stuck', downloadIds: ['dl-1'] });
  });

  it('stuck: completed + warning status', () => {
    const records = [record({ downloadId: 'dl-2', status: 'completed', trackedDownloadStatus: 'warning' })];
    expect(assessQueue(records, seriesTarget)).toEqual({ state: 'stuck', downloadIds: ['dl-2'] });
  });

  it('stuck: dedupes downloadIds and drops undefined/empty ones, collecting every stuck record (not just one)', () => {
    const records = [
      record({ id: 1, downloadId: 'dl-1', trackedDownloadState: 'importPending' }),
      record({ id: 2, downloadId: 'dl-1', status: 'completed', trackedDownloadStatus: 'warning' }),
      record({ id: 3, downloadId: undefined, trackedDownloadState: 'importPending' }),
      record({ id: 4, downloadId: 'dl-2', trackedDownloadState: 'importPending' }),
    ];
    expect(assessQueue(records, seriesTarget)).toEqual({ state: 'stuck', downloadIds: ['dl-1', 'dl-2'] });
  });

  it('movie target matches on movieId, not seriesId', () => {
    const records = [{ id: 1, movieId: 7, status: 'completed', trackedDownloadState: 'importing', title: 'x' }];
    expect(assessQueue(records, { kind: 'movie', id: 7 })).toEqual({ state: 'busy' });
  });
});
