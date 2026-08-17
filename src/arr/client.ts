import type { ArrInstance } from '../config/schema.js';
import type {
  ArrApi,
  ArrPingStatus,
  EpisodeFileResource,
  EpisodeResource,
  HistoryRecord,
  ManualImportFile,
  ManualImportItem,
  MovieFileResource,
  MovieResource,
  NotificationSummary,
  QueueRecord,
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
// The paged /history endpoint binds eventType as int[] (unlike /history/series and
// /history/movie, which take the enum by name) — 3 = downloadFolderImported on both
// Sonarr and Radarr.
const IMPORT_EVENT_TYPE = 3;
// A health probe answers a settings page an operator is staring at, so it fails fast
// instead of inheriting the 30s ceiling pipeline calls get: an instance that hasn't said
// anything in four seconds is, for the purpose of that indicator, down.
const PING_TIMEOUT_MS = 4_000;

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

  /**
   * `/system/status` is the cheapest authenticated endpoint both Sonarr and Radarr serve,
   * so a 2xx proves reachability and the api key in one call. The one place in this class
   * that swallows `ArrApiError` rather than propagating it: the caller is an indicator,
   * and "down" is a legitimate answer, not an error to report.
   */
  async ping(): Promise<ArrPingStatus> {
    try {
      await this.request('GET', '/system/status', { timeoutMs: PING_TIMEOUT_MS });
      return 'ok';
    } catch (err) {
      // Anything that isn't an HTTP answer — DNS, refused connection, TLS, the timeout
      // abort — never reached the instance, which is indistinguishable from it being down.
      if (!(err instanceof ArrApiError)) return 'unreachable';
      return err.status === 401 || err.status === 403 ? 'unauthorized' : 'unreachable';
    }
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

  async listQueue(): Promise<QueueRecord[]> {
    const res = await this.request<{ records: QueueRecord[] }>('GET', '/queue', {
      // One page big enough to hold any realistic queue; the arr has no unpaged variant.
      // Sonarr and Radarr spell the include-unknown flag differently; each ignores the
      // other's name, so sending both keeps this method kind-agnostic.
      query: { page: 1, pageSize: 1000, includeUnknownSeriesItems: true, includeUnknownMovieItems: true },
    });
    return res.records;
  }

  async listSeriesHistory(seriesId: number): Promise<HistoryRecord[]> {
    const records = await this.request<HistoryRecord[]>('GET', '/history/series', {
      query: { seriesId, eventType: 'downloadFolderImported' },
    });
    // Re-filter client-side so a binding change on the arr side can't silently widen this
    // (same rationale as listRecentImports).
    return records.filter((r) => r.eventType === 'downloadFolderImported');
  }

  async listMovieHistory(movieId: number): Promise<HistoryRecord[]> {
    const records = await this.request<HistoryRecord[]>('GET', '/history/movie', {
      query: { movieId, eventType: 'downloadFolderImported' },
    });
    // Re-filter client-side so a binding change on the arr side can't silently widen this
    // (same rationale as listRecentImports).
    return records.filter((r) => r.eventType === 'downloadFolderImported');
  }

  async listRecentImports(pageSize: number): Promise<HistoryRecord[]> {
    const res = await this.request<{ records: HistoryRecord[] }>('GET', '/history', {
      query: { page: 1, pageSize, sortKey: 'date', sortDirection: 'descending', eventType: IMPORT_EVENT_TYPE },
    });
    // Re-filter client-side so a binding change on the arr side can't silently widen this.
    return res.records.filter((r) => r.eventType === 'downloadFolderImported');
  }

  listEpisodes(seriesId: number): Promise<EpisodeResource[]> {
    return this.request('GET', '/episode', { query: { seriesId } });
  }

  listEpisodeFiles(seriesId: number): Promise<EpisodeFileResource[]> {
    return this.request('GET', '/episodefile', { query: { seriesId } });
  }

  listMovieFiles(movieId: number): Promise<MovieFileResource[]> {
    return this.request('GET', '/moviefile', { query: { movieId } });
  }

  listManualImport(p: {
    folder?: string;
    downloadId?: string;
    seriesId?: number;
    movieId?: number;
    filterExistingFiles?: boolean;
  }): Promise<ManualImportItem[]> {
    return this.request('GET', '/manualimport', { query: { ...p } });
  }

  async executeManualImport(files: ManualImportFile[], importMode: 'copy' | 'move'): Promise<void> {
    await this.request('POST', '/command', { body: { name: 'ManualImport', files, importMode } });
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
