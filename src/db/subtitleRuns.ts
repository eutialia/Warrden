import type Database from 'better-sqlite3';
import type { AccessTier } from './siteProfiles.js';

/** One step of a site-search run: what the agent did, at which tier, and why. `ts` is
 * first so the JSON array reads top-down as a timeline, matching dashboard order. */
export interface TranscriptEntry {
  ts: number;
  tier: AccessTier;
  action: string;
  detail: string;
}

export interface SubtitleRunRow {
  id: number;
  job_id: number;
  site: string;
  transcript: TranscriptEntry[];
  status: string;
  created_at: number;
  updated_at: number;
}

interface SubtitleRunRowRaw extends Omit<SubtitleRunRow, 'transcript'> {
  transcript: string;
}

function parseRow(row: SubtitleRunRowRaw): SubtitleRunRow {
  return { ...row, transcript: JSON.parse(row.transcript) as TranscriptEntry[] };
}

/** Typed wrapper over `subtitle_runs` — the durable record of one site-search attempt's
 * step-by-step transcript, shown on the dashboard's job detail page. Transcript entries
 * append as JSON-array rewrites (runs are ≤ stepBudget entries, so this stays cheap). */
export class SubtitleRuns {
  constructor(private readonly db: Database.Database) {}

  start(jobId: number, site: string): number {
    const now = Date.now();
    const info = this.db
      .prepare(`INSERT INTO subtitle_runs (job_id, site, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(jobId, site, now, now);
    return Number(info.lastInsertRowid);
  }

  appendTranscript(id: number, entries: TranscriptEntry[]): void {
    const row = this.db.prepare(`SELECT transcript FROM subtitle_runs WHERE id = ?`).get(id) as { transcript: string } | undefined;
    if (!row) throw new Error(`SubtitleRuns: run ${id} not found`);
    const merged = [...(JSON.parse(row.transcript) as TranscriptEntry[]), ...entries];
    this.db.prepare(`UPDATE subtitle_runs SET transcript = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(merged), Date.now(), id);
  }

  finish(id: number, status: 'done' | 'failed'): void {
    this.db.prepare(`UPDATE subtitle_runs SET status = ?, updated_at = ? WHERE id = ?`).run(status, Date.now(), id);
  }

  listByJob(jobId: number): SubtitleRunRow[] {
    const rows = this.db.prepare(`SELECT * FROM subtitle_runs WHERE job_id = ? ORDER BY id ASC`).all(jobId) as SubtitleRunRowRaw[];
    return rows.map(parseRow);
  }
}
