import type { ReleaseCandidate } from '../../arr/types.js';
import { BYTES_PER_MB } from '../../util/bytes.js';
import type { SeasonMode } from './seasonMode.js';

export interface PrefilterOpts {
  seederFloor: number;
  minSizeMB: number;
  maxSizeMB: number;
}

export interface DroppedCandidate {
  candidate: ReleaseCandidate;
  reason: string;
}

interface PrefilterResult {
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
 * and, past some size, actively confuses picking. */
const MAX_CANDIDATES_FOR_PICK = 30;

export interface CapCandidatesOpts {
  max?: number;
  mode?: SeasonMode | 'movie';
  missingEpisodeNumbers?: number[];
}

function seedersOf(c: ReleaseCandidate): number {
  return c.seeders ?? -1;
}

function bySeedersDesc(a: ReleaseCandidate, b: ReleaseCandidate): number {
  return seedersOf(b) - seedersOf(a);
}

function isPack(c: ReleaseCandidate): boolean {
  return c.fullSeason === true;
}

function episodeNumbersOf(c: ReleaseCandidate): number[] {
  if (c.mappedEpisodeNumbers && c.mappedEpisodeNumbers.length > 0) return c.mappedEpisodeNumbers;
  return c.episodeNumbers ?? [];
}

function coversMissing(c: ReleaseCandidate, missing: Set<number>): boolean {
  return episodeNumbersOf(c).some((n) => missing.has(n));
}

function rankForMode(c: ReleaseCandidate, mode: SeasonMode | 'movie' | undefined, missing: Set<number>): number {
  if (mode === 'complete') return isPack(c) ? 0 : 1;
  if (mode === 'airing') {
    if (!isPack(c) && missing.size > 0 && coversMissing(c, missing)) return 0;
    if (!isPack(c)) return 1;
    return 2;
  }
  return 0;
}

/**
 * Collapses the same torrent listed on multiple indexers down to the higher-seeded
 * copy. Matching is case-insensitive on `infoHash`; candidates with no hash are left
 * alone (they are not "the same unknown torrent").
 */
export function dedupByInfoHash(candidates: ReleaseCandidate[]): PrefilterResult {
  const bestByHash = new Map<string, ReleaseCandidate>();
  const kept: ReleaseCandidate[] = [];
  const dropped: DroppedCandidate[] = [];

  for (const c of candidates) {
    const hash = c.infoHash?.trim().toLowerCase();
    if (!hash) {
      kept.push(c);
      continue;
    }
    const existing = bestByHash.get(hash);
    if (!existing) {
      bestByHash.set(hash, c);
      kept.push(c);
      continue;
    }
    if (seedersOf(c) > seedersOf(existing)) {
      const idx = kept.indexOf(existing);
      if (idx !== -1) kept[idx] = c;
      bestByHash.set(hash, c);
      dropped.push({ candidate: existing, reason: `duplicate: same infoHash as ${c.guid}` });
    } else {
      dropped.push({ candidate: c, reason: `duplicate: same infoHash as ${existing.guid}` });
    }
  }

  return { kept, dropped };
}

/**
 * Caps an already-prefiltered candidate list. Default (no mode / movie / unknown) is
 * top `max` by seeders. A complete season ranks packs first so weekly rips cannot
 * drown the one season pack; an airing season ranks singles first, and singles that
 * cover a missing episode ahead of the rest. Cut candidates come back as
 * `DroppedCandidate`s with a `capped:` reason rather than silently vanishing.
 */
export function capCandidates(candidates: ReleaseCandidate[], opts: CapCandidatesOpts = {}): PrefilterResult {
  const max = opts.max ?? MAX_CANDIDATES_FOR_PICK;
  const shaped = opts.mode === 'complete' || opts.mode === 'airing';
  if (candidates.length <= max && !shaped) return { kept: candidates, dropped: [] };

  const missing = new Set(opts.missingEpisodeNumbers ?? []);
  const sorted = [...candidates].sort((a, b) => {
    const rank = rankForMode(a, opts.mode, missing) - rankForMode(b, opts.mode, missing);
    if (rank !== 0) return rank;
    return bySeedersDesc(a, b);
  });
  if (candidates.length <= max) return { kept: sorted, dropped: [] };
  const dropped = sorted.slice(max).map((c) => ({
    candidate: c,
    reason: `capped: ${candidates.length} candidates survived prefilter, kept only the top ${max}`,
  }));
  return { kept: sorted.slice(0, max), dropped };
}
