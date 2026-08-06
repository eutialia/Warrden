import { describe, it, expect, vi } from 'vitest';
import { PlacedFiles, type UpsertPlacedFileInput } from '../src/db/placedFiles.js';
import { freshDb } from './helpers.js';

function baseInput(overrides?: Partial<UpsertPlacedFileInput>): UpsertPlacedFileInput {
  return {
    arrInstance: 'sonarr',
    targetKind: 'series',
    targetId: 7,
    kind: 'subtitle',
    placedPath: '/lib/Show/S01/Show - S01E05.zh-Hans.ass',
    videoPath: '/lib/Show/S01/Show - S01E05.mkv',
    sourcePath: '/dl/t/ep05.sc.ass',
    jobId: 1,
    ...overrides,
  };
}

describe('PlacedFiles', () => {
  it('upsert on the same placed_path replaces, never duplicates', () => {
    const files = new PlacedFiles(freshDb());
    const base = baseInput();
    files.upsert(base);
    files.upsert({ ...base, sourcePath: '/dl/t2/ep05.sc.ass', jobId: 2 });
    const rows = files.listByTarget('sonarr', 'series', 7);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source_path: '/dl/t2/ep05.sc.ass', job_id: 2 });
  });

  it('upsert refreshes video_path, data, and created_at on re-placement', () => {
    vi.useFakeTimers();
    try {
      const files = new PlacedFiles(freshDb());
      const base = baseInput({ data: { lang: 'zh-Hans' } });
      vi.setSystemTime(1_000);
      files.upsert(base);

      vi.setSystemTime(2_000);
      files.upsert({
        ...base,
        videoPath: '/lib/Show/S01/Show - S01E05 (renamed).mkv',
        data: { lang: 'zh-Hant' },
      });
      const rows = files.listByTarget('sonarr', 'series', 7);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        video_path: '/lib/Show/S01/Show - S01E05 (renamed).mkv',
        data: { lang: 'zh-Hant' },
        created_at: 2_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('defaults data to {} and jobId to null when not given', () => {
    const files = new PlacedFiles(freshDb());
    files.upsert(baseInput({ jobId: undefined, data: undefined }));
    const row = files.findByPlacedPath(baseInput().placedPath);
    expect(row).toMatchObject({ job_id: null, data: {} });
  });

  it('listByTarget scopes to (arrInstance, targetKind, targetId)', () => {
    const files = new PlacedFiles(freshDb());
    files.upsert(baseInput({ placedPath: '/a.ass' }));
    files.upsert(baseInput({ placedPath: '/b.ass', targetId: 8 }));
    files.upsert(baseInput({ placedPath: '/c.ass', arrInstance: 'radarr', targetKind: 'movie' }));

    expect(files.listByTarget('sonarr', 'series', 7)).toHaveLength(1);
    expect(files.listByTarget('sonarr', 'series', 8)).toHaveLength(1);
    expect(files.listByTarget('radarr', 'movie', 7)).toHaveLength(1);
    expect(files.listByTarget('sonarr', 'series', 99)).toHaveLength(0);
  });

  it('listByJob returns every file written by that job', () => {
    const files = new PlacedFiles(freshDb());
    files.upsert(baseInput({ placedPath: '/a.ass', jobId: 1 }));
    files.upsert(baseInput({ placedPath: '/b.ass', jobId: 1, targetId: 8 }));
    files.upsert(baseInput({ placedPath: '/c.ass', jobId: 2 }));

    expect(files.listByJob(1)).toHaveLength(2);
    expect(files.listByJob(2)).toHaveLength(1);
    expect(files.listByJob(99)).toHaveLength(0);
  });

  it('findByPlacedPath returns null on a miss', () => {
    const files = new PlacedFiles(freshDb());
    expect(files.findByPlacedPath('/nope.ass')).toBeNull();
  });

  it('deleteById removes the row', () => {
    const files = new PlacedFiles(freshDb());
    files.upsert(baseInput());
    const row = files.findByPlacedPath(baseInput().placedPath)!;
    files.deleteById(row.id);
    expect(files.findByPlacedPath(baseInput().placedPath)).toBeNull();
  });
});
