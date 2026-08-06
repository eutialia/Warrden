import type { ReleaseCandidate } from '../../arr/types.js';

const BYTES_PER_MB = 1_048_576;

export interface PrefilterOpts {
  seederFloor: number;
  minSizeMB: number;
  maxSizeMB: number;
}

export interface PrefilterResult {
  kept: ReleaseCandidate[];
  dropped: { candidate: ReleaseCandidate; reason: string }[];
}

/**
 * Deterministic, arr-agnostic gate applied before any candidate reaches the LLM pick
 * step: drops releases the arr instance already rejected, releases below the seeder
 * floor, and releases outside the configured size window (in MB, size/1_048_576).
 * Sonarr/Radarr omit `seeders`/`leechers` entirely on Usenet releases — at runtime the
 * field can be `undefined` despite the type saying `number | null` — so a missing
 * seeder count is treated exactly like an explicit `null` (indexer doesn't report it)
 * and kept, never coerced into a falsy "0 seeders" drop. Pure: no I/O, no ctx.
 */
export function prefilter(candidates: ReleaseCandidate[], opts: PrefilterOpts): PrefilterResult {
  const kept: ReleaseCandidate[] = [];
  const dropped: { candidate: ReleaseCandidate; reason: string }[] = [];

  for (const c of candidates) {
    if (c.rejected) {
      dropped.push({ candidate: c, reason: `rejected by arr: ${c.rejections.join(', ') || 'unknown reason'}` });
      continue;
    }

    const seeders = c.seeders ?? null;
    if (seeders !== null && seeders < opts.seederFloor) {
      dropped.push({ candidate: c, reason: `seeders ${seeders} below floor ${opts.seederFloor}` });
      continue;
    }

    const sizeMB = c.size / BYTES_PER_MB;
    if (sizeMB < opts.minSizeMB || sizeMB > opts.maxSizeMB) {
      dropped.push({
        candidate: c,
        reason: `size ${sizeMB.toFixed(1)} MB outside [${opts.minSizeMB}, ${opts.maxSizeMB}]`,
      });
      continue;
    }

    kept.push(c);
  }

  return { kept, dropped };
}
