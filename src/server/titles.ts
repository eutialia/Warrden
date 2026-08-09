import type { ArrApi } from '../arr/types.js';
import type { TargetKind } from '../jobs/queue.js';

/** Short-lived title cache for dashboard list enrichment (avoids N arr round-trips per refresh). */
const TITLE_TTL_MS = 5 * 60_000;

interface CacheEntry {
  title: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export function jobTitleKey(arrInstance: string, targetKind: TargetKind, targetId: number): string {
  return `${arrInstance}:${targetKind}:${targetId}`;
}

export function fallbackTargetLabel(targetKind: TargetKind, targetId: number): string {
  return targetKind === 'movie' ? `Movie #${targetId}` : `Series #${targetId}`;
}

function payloadTitle(payload: Record<string, unknown>): string | undefined {
  const t = payload.title;
  return typeof t === 'string' && t.trim().length > 0 ? t.trim() : undefined;
}

function cacheGet(key: string): string | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.title;
}

function cacheSet(key: string, title: string): void {
  cache.set(key, { title, expiresAt: Date.now() + TITLE_TTL_MS });
}

/** Payload title when present; otherwise a cached arr lookup. Never throws — falls back to a readable id label. */
export async function resolveJobTitle(input: {
  client: ArrApi | undefined;
  arrInstance: string;
  targetKind: TargetKind;
  targetId: number;
  payload: Record<string, unknown>;
}): Promise<string> {
  const fromPayload = payloadTitle(input.payload);
  if (fromPayload) return fromPayload;

  const key = jobTitleKey(input.arrInstance, input.targetKind, input.targetId);
  const cached = cacheGet(key);
  if (cached) return cached;

  const fallback = fallbackTargetLabel(input.targetKind, input.targetId);
  if (!input.client) return fallback;

  try {
    let title = fallback;
    if (input.targetKind === 'movie') {
      const movie = (await input.client.listMovies()).find((m) => m.id === input.targetId);
      if (movie?.title) title = movie.title;
    } else {
      const series = await input.client.getSeries(input.targetId);
      if (series.title) title = series.title;
    }
    cacheSet(key, title);
    return title;
  } catch {
    return fallback;
  }
}

/** Resolve titles for a batch of jobs; one concurrent lookup per unique target. */
export async function resolveJobTitles(
  jobs: { arr_instance: string; target_kind: TargetKind; target_id: number; payload: Record<string, unknown> }[],
  clients: Map<string, ArrApi>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const pending = new Map<string, Promise<string>>();

  // Prefer any payload title for a target before scheduling arr lookups.
  for (const job of jobs) {
    const key = jobTitleKey(job.arr_instance, job.target_kind, job.target_id);
    if (out.has(key)) continue;
    const fromPayload = payloadTitle(job.payload);
    if (fromPayload) {
      out.set(key, fromPayload);
      cacheSet(key, fromPayload);
    }
  }

  for (const job of jobs) {
    const key = jobTitleKey(job.arr_instance, job.target_kind, job.target_id);
    if (out.has(key) || pending.has(key)) continue;
    pending.set(
      key,
      resolveJobTitle({
        client: clients.get(job.arr_instance),
        arrInstance: job.arr_instance,
        targetKind: job.target_kind,
        targetId: job.target_id,
        payload: job.payload,
      }).then((title) => {
        out.set(key, title);
        return title;
      }),
    );
  }

  await Promise.all(pending.values());
  return out;
}
