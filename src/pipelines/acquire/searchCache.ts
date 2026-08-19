import type { ReleaseCandidate } from '../../arr/types.js';

/**
 * In-memory cache of one job's interactive search results, so a retry after a transient
 * failure (an LLM hiccup, an arr blip once the search itself already succeeded) does not
 * re-sweep every indexer for candidates it just fetched. Keyed per (job, target): a series
 * searches once per season, and each season's candidates are its own entry.
 *
 * Process-local, and nothing outside it prunes it. `clearJob` covers a job that finishes
 * cleanly, but a job that fails terminally (a permanent error, or the last attempt of a
 * retryable one) never comes back to read or clear its entries, so `set` sweeps everything
 * past the TTL first. That is the only write path and it runs at most once per interactive
 * search, which bounds the map to the entries of jobs still inside their TTL window.
 *
 * A re-trigger that coalesces into a job still sitting in retry backoff reuses that job's id,
 * so it replays the cached candidates rather than searching fresh, until the TTL lapses or the
 * job finishes and clears them.
 */
export class SearchCache {
  private readonly entries = new Map<string, { at: number; results: ReleaseCandidate[] }>();

  constructor(
    private readonly ttlMs: number = 30 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Live entry count, for tests to assert the sweep actually reclaims (nothing in
   * production reads it: `get`/`set`/`clearJob` are the whole production surface). */
  get size(): number {
    return this.entries.size;
  }

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
    this.sweepExpired();
    this.entries.set(entryKey(jobId, key), { at: this.now(), results });
  }

  clearJob(jobId: number): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(`${jobId}:`)) this.entries.delete(key);
    }
  }

  /** Same staleness test `get` applies, over every entry: `at < now - ttlMs`. */
  private sweepExpired(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.at < cutoff) this.entries.delete(key);
    }
  }
}

function entryKey(jobId: number, key: string): string {
  return `${jobId}:${key}`;
}
