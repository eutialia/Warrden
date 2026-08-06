import type { ArrInstance } from '../config/schema.js';
import type {
  ArrApi,
  MovieResource,
  NotificationSummary,
  ReleaseCandidate,
  ReleaseProfileResource,
  SeriesResource,
  TagResource,
} from './types.js';

/** Thrown for any non-2xx response from a Sonarr/Radarr v3 API call. */
export class ArrApiError extends Error {
  constructor(
    method: string,
    path: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Arr API error: ${method} ${path} -> ${status}: ${body}`);
    this.name = 'ArrApiError';
  }
}

type QueryValue = string | number | boolean | undefined;

// Every arr call gets a hard ceiling: an unreachable/hung arr instance would otherwise
// leave a job (and the runner's single-tick-at-a-time poll loop) stuck forever waiting
// on a `fetch` that never settles.
const REQUEST_TIMEOUT_MS = 30_000;
// Interactive release search fans out to every indexer and routinely runs 30-90s;
// it gets its own, much longer deadline than ordinary API calls.
const SEARCH_TIMEOUT_MS = 180_000;

/**
 * Thin authenticated wrapper around the Sonarr/Radarr v3 HTTP API: every method is a
 * single `fetch` against `{baseUrl}/api/v3/...`. No retries, no caching — callers that
 * need resilience or coalescing build it on top of this.
 */
export class ArrClient implements ArrApi {
  // Trailing slash stripped once here (not touched in the config schema) so a
  // baseUrl like `http://host:8989/` doesn't produce `//api/v3/...` in request().
  private readonly baseUrl: string;

  constructor(private readonly inst: ArrInstance) {
    this.baseUrl = inst.baseUrl.replace(/\/+$/, '');
  }

  listSeries(): Promise<SeriesResource[]> {
    return this.request('GET', '/series');
  }

  listMovies(): Promise<MovieResource[]> {
    return this.request('GET', '/movie');
  }

  getSeries(id: number): Promise<SeriesResource> {
    return this.request('GET', `/series/${id}`);
  }

  // Round-trip a getSeries() result only — PUTting a hand-built partial object
  // would wipe unlisted series fields server-side.
  updateSeries(s: SeriesResource): Promise<SeriesResource> {
    return this.request('PUT', `/series/${s.id}`, { body: s });
  }

  searchReleases(p: { seriesId?: number; seasonNumber?: number; movieId?: number }): Promise<ReleaseCandidate[]> {
    return this.request('GET', '/release', {
      query: { seriesId: p.seriesId, seasonNumber: p.seasonNumber, movieId: p.movieId },
      timeoutMs: SEARCH_TIMEOUT_MS,
    });
  }

  async grabRelease(guid: string, indexerId: number): Promise<void> {
    await this.request('POST', '/release', { body: { guid, indexerId } });
  }

  listTags(): Promise<TagResource[]> {
    return this.request('GET', '/tag');
  }

  createTag(label: string): Promise<TagResource> {
    return this.request('POST', '/tag', { body: { label } });
  }

  async deleteTag(id: number): Promise<void> {
    await this.request('DELETE', `/tag/${id}`);
  }

  listReleaseProfiles(): Promise<ReleaseProfileResource[]> {
    return this.request('GET', '/releaseprofile');
  }

  createReleaseProfile(p: ReleaseProfileResource): Promise<ReleaseProfileResource> {
    return this.request('POST', '/releaseprofile', { body: p });
  }

  // Round-trip an existing profile only (same rationale as updateSeries) — a hand-built
  // partial PUT body would wipe any unlisted release-profile fields server-side.
  updateReleaseProfile(p: ReleaseProfileResource): Promise<ReleaseProfileResource> {
    return this.request('PUT', `/releaseprofile/${p.id}`, { body: p });
  }

  async deleteReleaseProfile(id: number): Promise<void> {
    await this.request('DELETE', `/releaseprofile/${id}`);
  }

  listNotifications(): Promise<NotificationSummary[]> {
    return this.request('GET', '/notification');
  }

  createNotification(body: object): Promise<NotificationSummary> {
    return this.request('POST', '/notification', { body });
  }

  async deleteNotification(id: number): Promise<void> {
    await this.request('DELETE', `/notification/${id}`);
  }

  private async request<T>(
    method: string,
    path: string,
    opts?: { query?: Record<string, QueryValue>; body?: unknown; timeoutMs?: number },
  ): Promise<T> {
    let url = `${this.baseUrl}/api/v3${path}`;
    if (opts?.query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(opts.query)) {
        if (value !== undefined) params.set(key, String(value));
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    const res = await fetch(url, {
      method,
      headers: {
        'X-Api-Key': this.inst.apiKey,
        ...(opts?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts?.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new ArrApiError(method, path, res.status, await res.text());
    }

    const text = await res.text();
    // `undefined as T` is only legitimate for void-returning methods (grab/deletes) —
    // value-returning GETs against the arr v3 API always have a JSON body.
    return (text ? (JSON.parse(text) as unknown) : undefined) as T;
  }
}
