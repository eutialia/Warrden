import type { SubtitleSiteConfig } from '../../config/schema.js';
import { SubhdAdapter } from './subhd.js';
import type { SiteAdapter } from './types.js';

const BUILTIN: SiteAdapter[] = [new SubhdAdapter()];

/** First matching adapter for a configured site, or null → generic browse loop. */
export function resolveSiteAdapter(site: SubtitleSiteConfig, extras: SiteAdapter[] = []): SiteAdapter | null {
  for (const a of [...extras, ...BUILTIN]) {
    if (a.matches(site)) return a;
  }
  return null;
}
