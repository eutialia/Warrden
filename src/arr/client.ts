import type { ArrInstance } from '../config/schema.js';
import type {
  MovieResource,
  ReleaseCandidate,
  ReleaseProfileResource,
  SeriesResource,
  TagResource,
} from './types.js';

/** A notification resource, as returned by Sonarr/Radarr's `/notification` endpoint. */
export interface NotificationSummary {
  id: number;
  name: string;
}

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

/**
 * Thin authenticated wrapper around the Sonarr/Radarr v3 HTTP API: every method is a
 * single `fetch` against `{baseUrl}/api/v3/...`. No retries, no caching — callers that
 * need resilience or coalescing build it on top of this.
 */
export class ArrClient {
  constructor(private readonly inst: ArrInstance) {}

  systemStatus(): Promise<unknown> {
    return this.request('GET', '/system/status');
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

  updateSeries(s: SeriesResource): Promise<SeriesResource> {
    return this.request('PUT', `/series/${s.id}`, { body: s });
  }

  searchReleases(p: { seriesId?: number; seasonNumber?: number; movieId?: number }): Promise<ReleaseCandidate[]> {
    return this.request('GET', '/release', {
      query: { seriesId: p.seriesId, seasonNumber: p.seasonNumber, movieId: p.movieId },
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
    opts?: { query?: Record<string, QueryValue>; body?: unknown },
  ): Promise<T> {
    let url = `${this.inst.baseUrl}/api/v3${path}`;
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
    });

    if (!res.ok) {
      throw new ArrApiError(method, path, res.status, await res.text());
    }

    const text = await res.text();
    return (text ? (JSON.parse(text) as unknown) : undefined) as T;
  }
}
