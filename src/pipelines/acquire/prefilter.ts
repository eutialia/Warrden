import type { ReleaseCandidate } from '../../arr/types.js';
import { BYTES_PER_MB } from '../../util/bytes.js';

export interface PrefilterOpts {
  seederFloor: number;
  minSizeMB: number;
  maxSizeMB: number;
}

export interface DroppedCandidate {
  candidate: ReleaseCandidate;
  reason: string;
}

export interface PrefilterResult {
  kept: ReleaseCandidate[];
  dropped: DroppedCandidate[];
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
  const dropped: DroppedCandidate[] = [];

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

/** Cap on how many prefiltered candidates ever reach the LLM pick step (and get persisted
 * in `acquire_records.candidates_json`) — an unbounded list is both a needless token cost
 * and, past some size, actively confuses picking. One constant, used by both the cap
 * itself and `run.ts`'s cap-notice event. */
export const MAX_CANDIDATES_FOR_PICK = 30;

/**
 * Caps an already-prefiltered candidate list to the top `max` by seeders (highest first;
 * missing/`null` seeders sort last, same as prefilter's own treatment of an indexer that
 * doesn't report them). Pure, like `prefilter` itself — cut candidates come back as
 * `DroppedCandidate`s with a `capped:` reason rather than silently vanishing, so the full
 * audit trail survives in `acquire_records.candidates_json` even though only the kept
 * ones are shown to the LLM.
 */
export function capCandidates(candidates: ReleaseCandidate[], max: number = MAX_CANDIDATES_FOR_PICK): PrefilterResult {
  if (candidates.length <= max) return { kept: candidates, dropped: [] };

  const sorted = [...candidates].sort((a, b) => (b.seeders ?? -1) - (a.seeders ?? -1));
  const dropped = sorted.slice(max).map((c) => ({
    candidate: c,
    reason: `capped: ${candidates.length} candidates survived prefilter, kept only the top ${max} by seeders`,
  }));
  return { kept: sorted.slice(0, max), dropped };
}
