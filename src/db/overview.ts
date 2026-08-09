import type Database from 'better-sqlite3';

/** Rolling window for the "what happened lately" counters on the dashboard home. */
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const PLACED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface OverviewCounts {
  attention: {
    /** Items waiting on a human — the dashboard's headline number. */
    open: number;
  };
  jobs: {
    /** Live queue depth, not a time window. */
    running: number;
    pending: number;
    /** Terminal outcomes inside `RECENT_WINDOW_MS`. */
    failedRecent: number;
    doneRecent: number;
  };
  /** Files Warrden placed itself in the last week, by kind. */
  placed: {
    subtitle: number;
    audio: number;
  };
}

/**
 * The single aggregate read behind `GET /api/overview`. Every number is a plain
 * COUNT over an indexed column, so the home screen costs one round of cheap
 * queries rather than pulling whole tables into the API layer to length them.
 */
export class Overview {
  constructor(private readonly db: Database.Database) {}

  counts(now = Date.now()): OverviewCounts {
    const recentSince = now - RECENT_WINDOW_MS;
    const placedSince = now - PLACED_WINDOW_MS;

    const countOf = (sql: string, ...params: unknown[]): number =>
      (this.db.prepare(sql).get(...params) as { n: number }).n;

    return {
      attention: {
        open: countOf(`SELECT COUNT(*) AS n FROM attention_items WHERE status = 'open'`),
      },
      jobs: {
        running: countOf(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'`),
        pending: countOf(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'`),
        failedRecent: countOf(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed' AND updated_at >= ?`, recentSince),
        doneRecent: countOf(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'done' AND updated_at >= ?`, recentSince),
      },
      placed: {
        subtitle: countOf(`SELECT COUNT(*) AS n FROM placed_files WHERE kind = 'subtitle' AND created_at >= ?`, placedSince),
        audio: countOf(`SELECT COUNT(*) AS n FROM placed_files WHERE kind = 'audio' AND created_at >= ?`, placedSince),
      },
    };
  }
}
