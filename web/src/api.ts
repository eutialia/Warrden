// Typed fetch layer for the `/api/*` routes defined in `src/server/app.ts`. Every shape
// here mirrors a server type by hand (there is no shared package between `web/` and the
// backend) — keep them in sync if the API changes.

export type TargetKind = 'series' | 'movie';
export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface Job {
  id: number;
  pipeline: string;
  target_kind: TargetKind;
  target_id: number;
  arr_instance: string;
  status: JobStatus;
  dirty: 0 | 1;
  attempts: number;
  not_before: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  // Aggregate outcome across every acquire_records row this job's own run produced —
  // `null` for a non-acquire pipeline, or an acquire job with no record yet. See
  // `AcquireRecords.outcomeForJob` (server) for why this is an aggregate, not just the
  // latest record: a multi-season series job can grab one season and not another.
  acquireOutcome?: AcquireStatus | null;
}

export type AcquireStatus = 'no-candidates' | 'none-viable' | 'grabbed';

export interface AcquireRecord {
  id: number;
  arr_instance: string;
  target_kind: TargetKind;
  target_id: number;
  source: string | null;
  status: AcquireStatus | null;
  picked_guid: string | null;
  release_group: string | null;
  reasoning: string | null;
  candidates_json: Record<string, unknown> | null;
  created_at: number;
}

export type PlacedFileKind = 'audio' | 'subtitle';

export interface PlacedFile {
  id: number;
  arr_instance: string;
  target_kind: TargetKind;
  target_id: number;
  kind: PlacedFileKind;
  placed_path: string;
  video_path: string;
  source_path: string;
  job_id: number | null;
  data: Record<string, unknown>;
  created_at: number;
}

export interface JobDetailResponse {
  job: Job;
  acquireRecord: AcquireRecord | null;
  acquireOutcome: AcquireStatus | null;
  placedFiles: PlacedFile[];
  // Per-site agent-run records for a subtitle job — empty for non-subtitle pipelines.
  // Fetched alongside the rest of the job detail; `subtitle.transcript` SSE events
  // trigger a wholesale refetch via `useSseRefetch` (see JobDetail.tsx), so the array
  // stays live as each site's transcript grows.
  subtitleRuns?: SubtitleRunRow[];
}

/** Access ladder tiers, cheapest first. Mirrors `AccessTier` in `src/db/siteProfiles.ts` —
 * the dashboard hand-copies this union (no shared package between `web/` and the backend),
 * keep it in sync if the ladder grows. */
export type AccessTier = 'curl' | 'chromium' | 'camoufox' | 'remote';

/** One `site_profiles` row — the browser agent's per-site memory. Field names are the
 * server's snake_case (the API returns rows verbatim), not the camelCase `UpdateSiteProfileInput`
 * the PUT body uses. Hand-copied from `SiteProfileRow` in `src/db/siteProfiles.ts`. */
export interface SiteProfileRow {
  name: string;
  base_url: string;
  last_working_tier: AccessTier | null;
  search_url_patterns: string[];
  notes: string;
  last_success_at: number | null;
  last_failure_at: number | null;
  fail_count: number;
  created_at: number;
}

/** One step of a site-search run's transcript, in chronological order. Hand-copied from
 * `TranscriptEntry` in `src/db/subtitleRuns.ts`. */
export interface TranscriptEntry {
  ts: number;
  tier: AccessTier;
  action: string;
  detail: string;
}

export interface SubtitleRunRow {
  id: number;
  job_id: number;
  site: string;
  transcript: TranscriptEntry[];
  status: string;
  created_at: number;
  updated_at: number;
}

/** Body for `PUT /api/site-profiles/:name` — every field optional (a PATCH-shaped PUT).
 * `lastWorkingTier: null` clears the stored tier; `lastFailureAt: null` clears the
 * failure timestamp; omitting either leaves it untouched. */
export interface SiteProfileUpdate {
  notes?: string;
  lastWorkingTier?: AccessTier | null;
  searchUrlPatterns?: string[];
  failCount?: number;
  lastFailureAt?: number | null;
}

/** Substituted for every secret value (`llm.keys.*`, `arrs[].apiKey`) by `GET /api/config`.
 * Leaving it untouched on `PUT` preserves the stored secret; sending a new value rotates it. */
export const SECRET_PLACEHOLDER = '•••';

export type ArrKind = 'sonarr' | 'radarr';

export interface ArrInstance {
  name: string;
  kind: ArrKind;
  baseUrl: string;
  apiKey: string;
}

export type Provider = 'openrouter' | 'openai' | 'anthropic' | 'claude-code';

export interface CallsiteModel {
  provider: Provider;
  model: string;
  fallback?: { provider: Provider; model: string };
}

/** Every LLM call-site Warrden knows about, in the order each phase introduced it —
 * `llm.profiles` (a raw JSON editor on the Config page) accepts any string key, so this
 * exists purely as a discoverability hint for what to name one, not a validated list. */
export const CALLSITES = ['release-pick', 'sidecar-match', 'bundle-map', 'site-search', 'archive-map'] as const;

export interface SubtitleSite {
  name: string;
  baseUrl: string;
  /** Search page URL with `{query}` where the search term goes. Optional: without it the
   * agent discovers the search endpoint itself. */
  searchUrlTemplate?: string;
}

export interface Config {
  server: { port: number; publicUrl: string };
  arrs: ArrInstance[];
  pathMappings: { from: string; to: string }[];
  picking: { tags: string[]; seederFloor: number; minSizeMB: number; maxSizeMB: number };
  ingest: { mountMarkers: string[]; downloadRoots: string[] };
  subtitle: { languages: string[]; sites: SubtitleSite[] };
  browser: { stepBudget: number; siteCooldownSeconds: number };
  llm: {
    activeProfile: 'dev' | 'prod';
    profiles: Record<string, Record<string, CallsiteModel>>;
    keys: { openrouter?: string; openai?: string; anthropic?: string };
  };
  reconcileIntervalMinutes: number;
}

export interface SaveConfigResponse {
  saved: boolean;
  restartRequired: boolean;
}

export interface ApiIssue {
  path: (string | number)[];
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly issues?: ApiIssue[];

  constructor(message: string, status: number, issues?: ApiIssue[]) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.issues = issues;
  }
}

/** A `fetchJson` failure's human-readable message — the `ApiError`'s own message when it
 * is one, otherwise `fallback` for anything else (a network failure, a JS error thrown
 * before the request even went out, ...). Every page's error/toast handling funnels
 * through this instead of repeating `err instanceof ApiError ? err.message : fallback`. */
export function apiErrorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    let issues: ApiIssue[] | undefined;
    try {
      const body: unknown = await res.json();
      if (body && typeof body === 'object') {
        if ('error' in body && typeof body.error === 'string') message = body.error;
        if ('issues' in body && Array.isArray(body.issues)) issues = body.issues as ApiIssue[];
      }
    } catch {
      // Non-JSON error body — fall back to the status line above.
    }
    throw new ApiError(message, res.status, issues);
  }
  // 200s from these routes are always JSON.
  return res.json() as Promise<T>;
}

export function fetchJobs(limit = 50): Promise<Job[]> {
  return fetchJson<Job[]>(`/api/jobs?limit=${limit}`);
}

export function fetchJob(id: number | string): Promise<JobDetailResponse> {
  return fetchJson<JobDetailResponse>(`/api/jobs/${id}`);
}

/** `GET /api/site-profiles` — one row per configured subtitle site, merged over stored rows:
 * a configured site with no stored row yet still shows up with default fields. */
export function fetchSiteProfiles(): Promise<{ profiles: SiteProfileRow[] }> {
  return fetchJson('/api/site-profiles');
}

/** `PUT /api/site-profiles/:name` — PATCH-shaped: only the supplied fields are written. 404s
 * for a name not in `config.subtitle.sites`. The returned row is the post-update state. */
export function updateSiteProfile(name: string, patch: SiteProfileUpdate): Promise<SiteProfileRow> {
  return fetchJson<SiteProfileRow>(`/api/site-profiles/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export function fetchConfig(): Promise<Config> {
  return fetchJson<Config>('/api/config');
}

export function saveConfig(config: Config): Promise<SaveConfigResponse> {
  return fetchJson<SaveConfigResponse>('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  });
}

export function postAcquire(input: {
  arrInstance: string;
  targetKind: TargetKind;
  targetId: number;
  title?: string;
}): Promise<{ outcome: string }> {
  return fetchJson('/api/acquire', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export type AttentionStatus = 'open' | 'dismissed' | 'resolved';

export interface AttentionItem {
  id: number;
  ts: number;
  kind: string;
  message: string;
  job_id: number | null;
  data: Record<string, unknown>;
  status: AttentionStatus;
  resolved_at: number | null;
}

export function fetchAttention(status: string): Promise<{ items: AttentionItem[] }> {
  return fetchJson(`/api/attention?status=${encodeURIComponent(status)}`);
}

export function dismissAttention(id: number): Promise<{ ok: boolean }> {
  return fetchJson(`/api/attention/${id}/dismiss`, { method: 'POST', headers: { 'content-type': 'application/json' } });
}

export function retryAttention(id: number): Promise<{ ok: boolean }> {
  return fetchJson(`/api/attention/${id}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' } });
}

export function repickAttention(id: number, hint?: string): Promise<{ ok: boolean }> {
  return fetchJson(`/api/attention/${id}/repick`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hint }),
  });
}

export function acceptAttention(id: number): Promise<{ ok: boolean }> {
  return fetchJson(`/api/attention/${id}/accept`, { method: 'POST', headers: { 'content-type': 'application/json' } });
}

export type ManagedObjectKind = 'notification' | 'tag' | 'release_profile';

export interface ManagedObject {
  id: number;
  arr_instance: string;
  kind: ManagedObjectKind;
  external_id: number;
  name: string | null;
  data: Record<string, unknown>;
  created_at: number;
}

export function fetchManagedObjects(): Promise<{ objects: ManagedObject[] }> {
  return fetchJson('/api/managed-objects');
}

export function deleteManagedObject(id: number): Promise<{ ok: boolean; deletedInArr: boolean }> {
  return fetchJson(`/api/managed-objects/${id}`, { method: 'DELETE' });
}

