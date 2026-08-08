import type { ArrApi, MovieResource, SeriesResource } from '../arr/types.js';
import type { JobRow } from '../jobs/queue.js';

/** The webhook-supplied title (`job.payload.title`), if the enqueuer set a non-empty one.
 * Shared by every pipeline that wants a human-readable label for its target without a
 * network round-trip when the trigger already carried one. */
export function resolvePayloadTitle(job: JobRow): string | undefined {
  const payloadTitle = job.payload.title;
  return typeof payloadTitle === 'string' && payloadTitle.length > 0 ? payloadTitle : undefined;
}

/** Prefers the webhook-supplied title (`resolvePayloadTitle`); falls back to a fresh arr
 * lookup when a job was enqueued without one (e.g. a reconciliation job) —
 * `listMovies()` for a movie target, `getSeries()` for a series one. Callers that already
 * have a `SeriesResource` on hand (e.g. acquire's series branch, which fetches one
 * unconditionally for its `seasons`) should prefer `resolvePayloadTitle(job) ??
 * series.title` directly instead, to avoid this refetching it. */
export async function resolveTargetTitle(client: ArrApi, job: JobRow): Promise<string> {
  const meta = await resolveTargetMeta(client, job);
  return meta.title;
}

/** Title + alternate search strings from the arr (and payload title when present). */
export interface TargetMeta {
  title: string;
  alternates: string[];
}

function alternatesFromSeries(s: SeriesResource): string[] {
  return (s.alternateTitles ?? []).map((a) => a.title).filter((t) => t.trim().length > 0);
}

function alternatesFromMovie(m: MovieResource): string[] {
  const out: string[] = [];
  if (m.originalTitle && m.originalTitle.trim().length > 0) out.push(m.originalTitle.trim());
  for (const a of m.alternateTitles ?? []) {
    if (a.title.trim().length > 0) out.push(a.title.trim());
  }
  return out;
}

/**
 * Loads the canonical title (payload first) plus arr alternate titles for subtitle search
 * query variants. One arr round-trip when payload is missing; when payload is present still
 * fetches alternates so CJK/romaji forms aren't lost just because the webhook carried a title.
 */
export async function resolveTargetMeta(client: ArrApi, job: JobRow): Promise<TargetMeta> {
  const payloadTitle = resolvePayloadTitle(job);
  if (job.target_kind === 'movie') {
    const movies = await client.listMovies();
    const movie = movies.find((m) => m.id === job.target_id);
    const title = payloadTitle ?? movie?.title ?? `movie #${job.target_id}`;
    return { title, alternates: movie ? alternatesFromMovie(movie) : [] };
  }
  const series = await client.getSeries(job.target_id);
  const title = payloadTitle ?? series.title;
  return { title, alternates: alternatesFromSeries(series) };
}
