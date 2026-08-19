import type { ReleaseCandidate } from '../../arr/types.js';

/**
 * In-memory cache of one job's interactive search results, so a retry after a transient
 * failure (an LLM hiccup, an arr blip once the search itself already succeeded) does not
 * re-sweep every indexer for candidates it just fetched. Keyed per (job, target) — a series
 * searches once per season, and each season's candidates are its own entry.
 *
 * Deliberately process-local and unbounded: entries only live for the span of one job's
 * retries, expiring on read past the TTL, and `clearJob` covers the normal end of a job.
 */
export class SearchCache {
  private readonly entries = new Map<string, { at: number; results: ReleaseCandidate[] }>();

  constructor(
    private readonly ttlMs: number = 30 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  get(jobId: number, key: string): ReleaseCandidate[] | undefined {
    const entry = this.entries.get(entryKey(jobId, key));
    if (!entry) return undefined;
    if (this.now() - entry.at > this.ttlMs) {
      this.entries.delete(entryKey(jobId, key));
      return undefined;
    }
    return entry.results;
  }

  set(jobId: number, key: string, results: ReleaseCandidate[]): void {
    this.entries.set(entryKey(jobId, key), { at: this.now(), results });
  }

  clearJob(jobId: number): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(`${jobId}:`)) this.entries.delete(key);
    }
  }
}

function entryKey(jobId: number, key: string): string {
  return `${jobId}:${key}`;
}
