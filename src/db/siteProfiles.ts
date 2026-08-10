import type Database from 'better-sqlite3';

/** Site access tiers, cheapest first. `camoufox` and `remote` are declared seams for the
 * escalation ladder's full shape — v1 implements `curl` and `chromium` only, but a profile
 * row can already record them so the ladder's data model doesn't change when they land. */
export type AccessTier = 'curl' | 'chromium' | 'camoufox' | 'remote';

export interface SiteProfileRow {
  /** The site's identity — unique by construction, unlike a name nothing enforced. */
  base_url: string;
  last_working_tier: AccessTier | null;
  search_url_patterns: string[];
  notes: string;
  last_success_at: number | null;
  last_failure_at: number | null;
  fail_count: number;
  created_at: number;
}

interface SiteProfileRowRaw extends Omit<SiteProfileRow, 'search_url_patterns'> {
  search_url_patterns: string;
}

function parseRow(row: SiteProfileRowRaw): SiteProfileRow {
  return { ...row, search_url_patterns: JSON.parse(row.search_url_patterns) as string[] };
}

export interface UpdateSiteProfileInput {
  /** `null` clears the stored known-good tier (dashboard "forget this floor"). */
  lastWorkingTier?: AccessTier | null;
  searchUrlPatterns?: string[];
  notes?: string;
  lastSuccessAt?: number | null;
  lastFailureAt?: number | null;
  failCount?: number;
}

/**
 * Typed wrapper over the `site_profiles` table — the browser agent's memory: one row per
 * configured subtitle site, carrying the cheapest tier known to work, any search-URL
 * patterns it discovered, freeform quirk notes, and success/failure bookkeeping that drives
 * both the escalation floor and the cooldown between runs. Dashboard-editable (the Sites
 * view), so nothing here assumes the writer is the agent.
 */
export class SiteProfiles {
  constructor(private readonly db: Database.Database) {}

  /** Registers a site (from config) if new; an existing row keeps every learned field. */
  upsert(o: { baseUrl: string }): void {
    this.db
      .prepare(`INSERT INTO site_profiles (base_url, created_at) VALUES (?, ?) ON CONFLICT(base_url) DO NOTHING`)
      .run(o.baseUrl, Date.now());
  }

  get(baseUrl: string): SiteProfileRow | null {
    const row = this.db.prepare(`SELECT * FROM site_profiles WHERE base_url = ?`).get(baseUrl) as
      | SiteProfileRowRaw
      | undefined;
    return row ? parseRow(row) : null;
  }

  list(): SiteProfileRow[] {
    const rows = this.db.prepare(`SELECT * FROM site_profiles ORDER BY base_url ASC`).all() as SiteProfileRowRaw[];
    return rows.map(parseRow);
  }

  update(baseUrl: string, patch: UpdateSiteProfileInput): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.lastWorkingTier !== undefined) { sets.push('last_working_tier = ?'); params.push(patch.lastWorkingTier); }
    if (patch.searchUrlPatterns !== undefined) { sets.push('search_url_patterns = ?'); params.push(JSON.stringify(patch.searchUrlPatterns)); }
    if (patch.notes !== undefined) { sets.push('notes = ?'); params.push(patch.notes); }
    if (patch.lastSuccessAt !== undefined) { sets.push('last_success_at = ?'); params.push(patch.lastSuccessAt); }
    if (patch.lastFailureAt !== undefined) { sets.push('last_failure_at = ?'); params.push(patch.lastFailureAt); }
    if (patch.failCount !== undefined) { sets.push('fail_count = ?'); params.push(patch.failCount); }
    if (sets.length === 0) return;
    params.push(baseUrl);
    this.db.prepare(`UPDATE site_profiles SET ${sets.join(', ')} WHERE base_url = ?`).run(...params);
  }

}
