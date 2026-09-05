import type Database from 'better-sqlite3';

/** Rolling window for the "what happened lately" counters on the dashboard home. */
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const WEEK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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
  /** What the last day of work consisted of — one line per stage of the pipeline,
   * so the dashboard can say what Warrden has been doing, not just how much. */
  recent: {
    webhooks: number;
    refined: number;
    subtitles: number;
    escalated: number;
  };
  /** Terminal job outcomes over the week, for the share that finished cleanly. Both
   * counts travel rather than a ratio: a percentage of nothing is not 100%, and only
   * the caller knows how it wants to say so. */
  week: {
    done: number;
    failed: number;
  };
}

/**
 * The single aggregate read behind `GET /api/overview`. Every number is a plain
 * COUNT the indexes in `001_init.sql` cover, so the home screen costs
 * one round of cheap queries rather than pulling whole tables into the API layer to
 * length them. Adding a count here means checking there is an index for it.
 */
export class Overview {
  constructor(private readonly db: Database.Database) {}

  counts(now = Date.now()): OverviewCounts {
    const recentSince = now - RECENT_WINDOW_MS;
    const weekSince = now - WEEK_WINDOW_MS;

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
        subtitle: countOf(`SELECT COUNT(*) AS n FROM placed_files WHERE kind = 'subtitle' AND created_at >= ?`, weekSince),
        audio: countOf(`SELECT COUNT(*) AS n FROM placed_files WHERE kind = 'audio' AND created_at >= ?`, weekSince),
      },
      recent: {
        webhooks: countOf(`SELECT COUNT(*) AS n FROM events WHERE kind = 'webhook.received' AND ts >= ?`, recentSince),
        refined: countOf(`SELECT COUNT(*) AS n FROM acquire_records WHERE created_at >= ?`, recentSince),
        subtitles: countOf(
          `SELECT COUNT(*) AS n FROM placed_files WHERE kind = 'subtitle' AND created_at >= ?`,
          recentSince,
        ),
        escalated: countOf(`SELECT COUNT(*) AS n FROM attention_items WHERE ts >= ?`, recentSince),
      },
      week: {
        done: countOf(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'done' AND updated_at >= ?`, weekSince),
        failed: countOf(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed' AND updated_at >= ?`, weekSince),
      },
    };
  }
}
