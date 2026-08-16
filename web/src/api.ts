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
  /** Human series/movie title resolved by the API (payload first, else arr lookup). */
  targetTitle?: string;
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
  /** The site's identity — its base URL. */
  base_url: string;
  last_working_tier: AccessTier | null;
  search_url_patterns: string[];
  last_success_at: number | null;
  last_failure_at: number | null;
  fail_count: number;
  /** Set once a human accepted the agent's "this site cannot be automated" verdict — the
   * site-search pass skips it entirely. Cleared by dismissing that attention item. */
  disabled_at: number | null;
  disabled_reason: string;
  created_at: number;
}

/** One step of a site-search run's transcript, in chronological order. Hand-copied from
 * `TranscriptEntry` in `src/db/subtitleRuns.ts`. */
export interface TranscriptEntry {
  ts: number;
  tier: AccessTier;
  action: string;
  detail: string;
  /** Set only on the few steps a human has to see — a refused private/loopback
   * destination. Unset on every ordinary step. */
  level?: 'attention';
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
  /** Which site to write to. A URL cannot survive a path segment, so it travels in
   * the body. */
  baseUrl: string;
  lastWorkingTier?: AccessTier | null;
  searchUrlPatterns?: string[];
  failCount?: number;
  lastFailureAt?: number | null;
  /** Only `null` is accepted server-side — the "re-enable" button. A site can only be
   * disabled through the evidence-gated attention accept route, never through this one. */
  disabledAt?: null;
}

/** A site's learned knowledge file (`src/agent/siteKnowledge.ts`): the rendered markdown,
 * `## Operator notes` and all, plus the rendered length of the agent-owned sections alone
 * (frontmatter, title and operator notes excluded) — what `KNOWLEDGE_CHAR_CAP` below is
 * measured against. `GET`, `PUT` and `POST .../reset` on `/api/site-knowledge` all return
 * this shape. `version` is an opaque compare-and-swap token: hold onto whatever the last
 * response gave you and send it back on the next `PUT` (`updateSiteKnowledge`) so the
 * server can tell whether something else — almost always a reflection run — wrote the file
 * in between and refuse (409) rather than silently overwrite it. */
export interface SiteKnowledge {
  baseUrl: string;
  markdown: string;
  agentChars: number;
  version: string;
}

/** Hand-copied from `KNOWLEDGE_CHAR_CAP` in `src/agent/siteKnowledge.ts` (no shared package
 * between `web/` and the backend) — the ceiling the browse agent's own writes are held to,
 * shown next to `agentChars` so an operator hand-editing the file can see how much room is
 * left before the agent itself can no longer update it. Keep in sync if that cap moves. */
export const KNOWLEDGE_CHAR_CAP = 10_000;

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
export const CALLSITES = ['release-pick', 'sidecar-match', 'bundle-map', 'site-search', 'archive-map', 'site-notes'] as const;

export interface SubtitleSite {
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
  subtitle: { languages: string[]; preferredGroups: string[]; sites: SubtitleSite[] };
  browser: { stepBudget: number; siteCooldownSeconds: number };
  llm: {
    activeProfile: 'dev' | 'prod';
    profiles: Record<string, Record<string, CallsiteModel>>;
    keys: { openrouter?: string; openai?: string; anthropic?: string };
  };
  reconcileIntervalMinutes: number;
  /** Days of event history to keep; 0 keeps everything. */
  eventRetentionDays: number;
  debug: { enabled: boolean };
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
    // A validation 400's `error` is often a generic label ("invalid request") with the
    // actual reason living only in `issues` — folding the issue text into the message
    // itself means every caller of `apiErrorMessage` (toasts included) shows the operator
    // what was actually wrong, not just that something was, without each page having to
    // know `ApiError` carries a separate `issues` array at all.
    if (issues && issues.length > 0) {
      message = `${message}: ${issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message)).join('; ')}`;
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
export function updateSiteProfile(patch: SiteProfileUpdate): Promise<SiteProfileRow> {
  return fetchJson<SiteProfileRow>('/api/site-profiles', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

/** `GET /api/site-knowledge?baseUrl=…` — the site's current knowledge file, seeded from
 * `seeds/sites` on first read if a local copy doesn't exist yet. 404s for a site not in
 * `config.subtitle.sites`. */
export function fetchSiteKnowledge(baseUrl: string): Promise<SiteKnowledge> {
  return fetchJson<SiteKnowledge>(`/api/site-knowledge?baseUrl=${encodeURIComponent(baseUrl)}`);
}

/** `PUT /api/site-knowledge` — a hand-edit. The response is the post-normalization
 * markdown actually saved (bullets reflowed, sections reordered), not an echo of what was
 * sent — the editor should replace its contents with it. `agentChars` is server-computed
 * and never part of the request body, hence `Pick`, not the full `SiteKnowledge`.
 *
 * `version` is the token from the `GET` (or prior `PUT`/`reset`) this edit started from.
 * The server 409s, leaving the file untouched, when it no longer matches what's on disk —
 * the caller should reload and let the operator re-apply their edit rather than retry
 * blind. */
export function updateSiteKnowledge(input: Pick<SiteKnowledge, 'baseUrl' | 'markdown' | 'version'>): Promise<SiteKnowledge> {
  return fetchJson<SiteKnowledge>('/api/site-knowledge', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/** `POST /api/site-knowledge/reset` — discards the local file (including everything the
 * agent has learned) and copies the shipped seed in its place. 404s when the site has no
 * seed to reset to. */
export function resetSiteKnowledge(baseUrl: string): Promise<SiteKnowledge> {
  return fetchJson<SiteKnowledge>('/api/site-knowledge/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseUrl }),
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

export type StorageCheckStatus = 'ok' | 'missing' | 'unreadable' | 'unwritable' | 'not-mounted';

export interface StorageCheck {
  id: string;
  label: string;
  path: string;
  localPath: string;
  role: 'series' | 'anime' | 'movies' | 'downloads';
  status: StorageCheckStatus;
  detail: string;
  immutable: boolean;
  /** Absent when the mount is unreachable, or when the filesystem won't report a
   * size — "unknown" and "full" must not look the same. */
  usage?: { totalBytes: number; usedBytes: number };
}

export function fetchStorageHealth(): Promise<{ checks: StorageCheck[] }> {
  return fetchJson('/api/health/storage');
}

/** Everything the home screen needs in one request. Mirrors `OverviewCounts` in
 * `src/db/overview.ts` plus the storage probe the same route folds in. */
export interface Overview {
  attention: { open: number };
  jobs: { running: number; pending: number; failedRecent: number; doneRecent: number };
  placed: { subtitle: number; audio: number };
  recent: { webhooks: number; refined: number; subtitles: number; escalated: number };
  week: { done: number; failed: number };
  storage: StorageCheck[];
  debugEnabled: boolean;
}

export function fetchOverview(): Promise<Overview> {
  return fetchJson<Overview>('/api/overview');
}

/** `GET /api/traces`: one row per job that has produced trace entries, newest first. */
export interface TraceSummary {
  jobId: number;
  pipeline: string;
  targetTitle: string;
  jobStatus: string;
  // The target triple: identical across the acquire/ingest/subtitle traces of one target,
  // which is how the debug page links a trace to the other phases of the same target. All
  // three are null when the job row is gone and the header had to be synthesized, so such
  // a trace links to nothing rather than matching every other headless trace.
  arrInstance: string | null;
  targetKind: string | null;
  targetId: number | null;
  entryCount: number;
  firstTs: number;
  lastTs: number;
}

/** One `job_trace` row without its (often large) payload. `GET /api/traces/:jobId` returns
 * these; fetch the full row with `fetchTraceEntry` when the payload is actually needed. */
export interface TraceEntry {
  id: number;
  job_id: number;
  seq: number;
  parent_seq: number | null;
  kind: string;
  summary: string;
  side_effect: 0 | 1;
  status: 'running' | 'ok' | 'error';
  ts_start: number;
  ts_end: number | null;
  hasPayload: boolean;
}

export function fetchTraces(): Promise<{ traces: TraceSummary[] }> {
  return fetchJson('/api/traces');
}

/** `jobTerminal` is what turns a still-`running` entry on a finished job into "interrupted"
 * rather than live work: the job crashed before that step could be closed. */
export function fetchTrace(
  jobId: number | string,
): Promise<{ jobId: number; jobStatus: string | null; jobTerminal: boolean; entries: TraceEntry[] }> {
  return fetchJson(`/api/traces/${jobId}`);
}

export function fetchTraceEntry(jobId: number | string, seq: number): Promise<TraceEntry & { payload: unknown }> {
  return fetchJson(`/api/traces/${jobId}/entries/${seq}`);
}

