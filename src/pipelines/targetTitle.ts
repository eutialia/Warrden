import type { ArrApi } from '../arr/types.js';
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
  const payloadTitle = resolvePayloadTitle(job);
  if (payloadTitle) return payloadTitle;
  if (job.target_kind === 'movie') {
    const movies = await client.listMovies();
    return movies.find((m) => m.id === job.target_id)?.title ?? `movie #${job.target_id}`;
  }
  const series = await client.getSeries(job.target_id);
  return series.title;
}
