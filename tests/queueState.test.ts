import { describe, it, expect } from 'vitest';
import { assessQueue } from '../src/pipelines/ingest/queueState.js';
import { queueRecord } from './helpers.js';

const seriesTarget = { kind: 'series' as const, id: 42 };

describe('assessQueue', () => {
  it('settled: no matching records at all', () => {
    expect(assessQueue([], seriesTarget)).toEqual({ state: 'settled' });
  });

  it('settled: a matching record still downloading does not block ingest (a second season fetching)', () => {
    const records = [queueRecord({ status: 'downloading' })];
    expect(assessQueue(records, seriesTarget)).toEqual({ state: 'settled' });
  });

  it('records for a different target are ignored entirely', () => {
    const records = [queueRecord({ seriesId: 99, status: 'completed', trackedDownloadState: 'importing' })];
    expect(assessQueue(records, seriesTarget)).toEqual({ state: 'settled' });
  });

  it('busy: any matching record completed+importing, regardless of downloadId', () => {
    const records = [queueRecord({ downloadId: 'unrelated-dl', status: 'completed', trackedDownloadState: 'importing' })];
    expect(assessQueue(records, seriesTarget)).toEqual({ state: 'busy' });
  });

  it('busy wins even when another matching record looks stuck', () => {
    const records = [
      queueRecord({ id: 1, status: 'completed', trackedDownloadState: 'importing' }),
      queueRecord({ id: 2, status: 'completed', trackedDownloadStatus: 'warning' }),
    ];
    expect(assessQueue(records, seriesTarget)).toEqual({ state: 'busy' });
  });

  it('stuck: importPending state', () => {
    const records = [queueRecord({ downloadId: 'dl-1', trackedDownloadState: 'importPending' })];
    expect(assessQueue(records, seriesTarget)).toEqual({ state: 'stuck', downloadIds: ['dl-1'] });
  });

  it('stuck: completed + warning status', () => {
    const records = [queueRecord({ downloadId: 'dl-2', status: 'completed', trackedDownloadStatus: 'warning' })];
    expect(assessQueue(records, seriesTarget)).toEqual({ state: 'stuck', downloadIds: ['dl-2'] });
  });

  it('stuck: dedupes downloadIds and drops undefined/empty ones, collecting every stuck record (not just one)', () => {
    const records = [
      queueRecord({ id: 1, downloadId: 'dl-1', trackedDownloadState: 'importPending' }),
      queueRecord({ id: 2, downloadId: 'dl-1', status: 'completed', trackedDownloadStatus: 'warning' }),
      queueRecord({ id: 3, downloadId: undefined, trackedDownloadState: 'importPending' }),
      queueRecord({ id: 4, downloadId: 'dl-2', trackedDownloadState: 'importPending' }),
    ];
    expect(assessQueue(records, seriesTarget)).toEqual({ state: 'stuck', downloadIds: ['dl-1', 'dl-2'] });
  });

  it('movie target matches on movieId, not seriesId', () => {
    const records = [{ id: 1, movieId: 7, status: 'completed', trackedDownloadState: 'importing', title: 'x' }];
    expect(assessQueue(records, { kind: 'movie', id: 7 })).toEqual({ state: 'busy' });
  });
});
