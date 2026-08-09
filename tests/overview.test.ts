import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { Overview } from '../src/db/overview.js';
import { AttentionItems } from '../src/db/attention.js';
import { PlacedFiles } from '../src/db/placedFiles.js';
import { SiteProfiles } from '../src/db/siteProfiles.js';
import { freshDb } from './helpers.js';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Jobs are written directly: the queue's own API can't produce an arbitrary
 * `updated_at`, and the windowing is exactly what these tests are about. Each row
 * gets its own `target_id` because `jobs_singleton` allows only one job per
 * (pipeline, instance, kind, target). */
function insertJobs(db: Database.Database, jobs: { status: string; updatedAt: number }[]): void {
  const stmt = db.prepare(
    `INSERT INTO jobs (pipeline, target_kind, target_id, arr_instance, status, dirty, attempts, not_before, payload, created_at, updated_at)
     VALUES ('subtitle', 'series', ?, 'sonarr', ?, 0, 0, 0, '{}', ?, ?)`,
  );
  jobs.forEach((job, i) => stmt.run(i + 1, job.status, job.updatedAt, job.updatedAt));
}

describe('Overview.counts', () => {
  it('counts the live queue by state and recent terminals inside the 24h window', () => {
    const db = freshDb();
    insertJobs(db, [
      { status: 'running', updatedAt: NOW },
      { status: 'pending', updatedAt: NOW },
      { status: 'pending', updatedAt: NOW - 30 * DAY }, // still queued, however old
      { status: 'done', updatedAt: NOW - HOUR },
      { status: 'failed', updatedAt: NOW - 2 * HOUR },
      // Terminal but outside the window — must not inflate "today".
      { status: 'done', updatedAt: NOW - 2 * DAY },
      { status: 'failed', updatedAt: NOW - 2 * DAY },
    ]);

    expect(new Overview(db).counts(NOW).jobs).toEqual({
      running: 1,
      pending: 2,
      doneRecent: 1,
      failedRecent: 1,
    });
  });

  it('counts only open attention items, not dismissed or resolved ones', () => {
    const db = freshDb();
    const attention = new AttentionItems(db);
    const open = attention.open({ kind: 'subtitle.unresolved', message: 'a', data: { targetId: 1 } });
    attention.open({ kind: 'acquire.none-viable', message: 'b', data: { targetId: 2 } });
    const dismissed = attention.open({ kind: 'ingest.settle-timeout', message: 'c', data: { targetId: 3 } });
    attention.setStatus(dismissed.id, 'dismissed');

    expect(new Overview(db).counts(NOW).attention.open).toBe(2);
    expect(open.status).toBe('open');
  });

  it('splits placed files by kind across a 7-day window', () => {
    const db = freshDb();
    const files = new PlacedFiles(db);
    const place = (kind: 'subtitle' | 'audio', path: string) =>
      files.upsert({
        arrInstance: 'sonarr',
        targetKind: 'series',
        targetId: 1,
        kind,
        placedPath: path,
        videoPath: '/lib/v.mkv',
        sourcePath: '/dl/s',
        jobId: null,
      });
    place('subtitle', '/lib/a.ass');
    place('subtitle', '/lib/b.ass');
    place('audio', '/lib/c.mka');

    // `created_at` is stamped with the wall clock by the writer, so restate every
    // row's age relative to this test's own NOW — one of them outside the window.
    const age = db.prepare(`UPDATE placed_files SET created_at = ? WHERE placed_path = ?`);
    age.run(NOW - 2 * DAY, '/lib/a.ass');
    age.run(NOW - 30 * DAY, '/lib/b.ass');
    age.run(NOW - HOUR, '/lib/c.mka');

    const counts = new Overview(db).counts(NOW);
    expect(counts.placed).toEqual({ subtitle: 1, audio: 1 });
  });

  it('reports site memory and how many sites are currently failing', () => {
    const db = freshDb();
    const profiles = new SiteProfiles(db);
    profiles.upsert({ name: 'alpha', baseUrl: 'https://a.example' });
    profiles.upsert({ name: 'beta', baseUrl: 'https://b.example' });
    profiles.update('beta', { failCount: 3 });

    expect(new Overview(db).counts(NOW).sites).toEqual({ known: 2, failing: 1 });
  });

  it('returns zeroes rather than throwing on an empty database', () => {
    const counts = new Overview(freshDb()).counts(NOW);
    expect(counts).toEqual({
      attention: { open: 0 },
      jobs: { running: 0, pending: 0, failedRecent: 0, doneRecent: 0 },
      placed: { subtitle: 0, audio: 0 },
      sites: { known: 0, failing: 0 },
    });
  });
});
