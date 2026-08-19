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

  it('busy: a clean importPending record is the arr queueing its own import, not a stuck one', () => {
    const records = [queueRecord({ status: 'completed', trackedDownloadState: 'importPending', trackedDownloadStatus: 'ok' })];
    expect(assessQueue(records, seriesTarget)).toEqual({ state: 'busy' });
  });

  it('busy: importing wins over a warning on the SAME record (Sonarr keeps stale statusMessages while importing)', () => {
    const records = [
      queueRecord({ downloadId: 'dl-9', status: 'completed', trackedDownloadState: 'importing', trackedDownloadStatus: 'warning' }),
    ];
    expect(assessQueue(records, seriesTarget)).toEqual({ state: 'busy' });
  });

  it('stuck: completed + importBlocked state', () => {
    const records = [queueRecord({ downloadId: 'dl-1', status: 'completed', trackedDownloadState: 'importBlocked' })];
    expect(assessQueue(records, seriesTarget)).toEqual({ state: 'stuck', downloadIds: ['dl-1'] });
  });

  it('stuck: completed + warning status, even while the state still says importPending', () => {
    const records = [
      queueRecord({ downloadId: 'dl-2', status: 'completed', trackedDownloadState: 'importPending', trackedDownloadStatus: 'warning' }),
    ];
    expect(assessQueue(records, seriesTarget)).toEqual({ state: 'stuck', downloadIds: ['dl-2'] });
  });

  it('stuck: completed + error status (Sonarr\'s "Waiting to Import (Error)" path-mapping failure)', () => {
    const records = [
      queueRecord({ downloadId: 'dl-err', status: 'completed', trackedDownloadState: 'importPending', trackedDownloadStatus: 'error' }),
    ];
    expect(assessQueue(records, seriesTarget)).toEqual({ state: 'stuck', downloadIds: ['dl-err'] });
  });

  it('busy: importing wins over an error on the SAME record, exactly as it does over a warning', () => {
    const records = [
      queueRecord({ downloadId: 'dl-err', status: 'completed', trackedDownloadState: 'importing', trackedDownloadStatus: 'error' }),
    ];
    expect(assessQueue(records, seriesTarget)).toEqual({ state: 'busy' });
  });

  it('settled: a still-downloading record carrying a warning is not stuck (nothing has been handed to the importer yet)', () => {
    const records = [queueRecord({ downloadId: 'dl-3', status: 'downloading', trackedDownloadStatus: 'warning' })];
    expect(assessQueue(records, seriesTarget)).toEqual({ state: 'settled' });
  });

  it('stuck: dedupes downloadIds and drops undefined/empty ones, collecting every stuck record (not just one)', () => {
    const records = [
      queueRecord({ id: 1, downloadId: 'dl-1', status: 'completed', trackedDownloadState: 'importBlocked' }),
      queueRecord({ id: 2, downloadId: 'dl-1', status: 'completed', trackedDownloadStatus: 'warning' }),
      queueRecord({ id: 3, downloadId: undefined, status: 'completed', trackedDownloadState: 'importBlocked' }),
      queueRecord({ id: 4, downloadId: 'dl-2', status: 'completed', trackedDownloadState: 'importBlocked' }),
    ];
    expect(assessQueue(records, seriesTarget)).toEqual({ state: 'stuck', downloadIds: ['dl-1', 'dl-2'] });
  });

  it('movie target matches on movieId, not seriesId', () => {
    const records = [{ id: 1, movieId: 7, status: 'completed', trackedDownloadState: 'importing', title: 'x' }];
    expect(assessQueue(records, { kind: 'movie', id: 7 })).toEqual({ state: 'busy' });
  });
});
