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

export interface JobDetailResponse {
  job: Job;
  acquireRecord: AcquireRecord | null;
  acquireOutcome: AcquireStatus | null;
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

export interface Config {
  server: { port: number; publicUrl: string };
  arrs: ArrInstance[];
  pathMappings: { from: string; to: string }[];
  picking: { tags: string[]; seederFloor: number; minSizeMB: number; maxSizeMB: number };
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

