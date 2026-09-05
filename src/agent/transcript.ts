import type { AccessTier } from '../db/siteProfiles.js';

/** One step of a site-search run: what the agent did, at which tier, and why. `ts` is
 * first so the JSON array reads top-down as a timeline, matching dashboard order. */
export interface TranscriptEntry {
  ts: number;
  tier: AccessTier;
  action: string;
  detail: string;
  /** Set only on the few steps a human has to see — a refused private/loopback
   * destination. The runner raises the step's `subtitle.transcript` event to this level,
   * which files it as an attention item; every ordinary step leaves it unset. */
  level?: 'attention';
}
