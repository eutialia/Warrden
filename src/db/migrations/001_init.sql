CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  arr_instance TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  dirty INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One active job per target per pipeline; completed rows are free to pile up.
CREATE UNIQUE INDEX jobs_singleton
  ON jobs (pipeline, arr_instance, target_kind, target_id)
  WHERE status IN ('pending', 'running');

CREATE INDEX jobs_status_updated ON jobs (status, updated_at);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  job_id INTEGER,
  message TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}'
);

-- `events` is append-only and never pruned, so the home screen's per-kind counts over a
-- recent window would otherwise scan the whole install's history.
CREATE INDEX events_kind_ts ON events (kind, ts);

-- Debug traces. One row per step; parent_seq nests voluminous children (LLM attempts,
-- agent steps) under a top-level timeline entry. seq is allocated per job in SQL because
-- ingest re-runs the same job id across settle-wait reschedules.
CREATE TABLE trace_entries (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  parent_seq INTEGER,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  side_effect INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',
  ts_start INTEGER NOT NULL,
  ts_end INTEGER,
  payload TEXT,
  UNIQUE (job_id, seq)
);

CREATE INDEX idx_trace_entries_job ON trace_entries (job_id);

-- Deliberately not unique on (target, created_at): a multi-season series job writes one
-- row per season in a tight loop and can land two in the same millisecond.
CREATE TABLE acquire_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  arr_instance TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  source TEXT,
  status TEXT,
  picked_guid TEXT,
  release_group TEXT,
  reasoning TEXT,
  candidates_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX acquire_records_target
  ON acquire_records (arr_instance, target_kind, target_id, created_at);

CREATE INDEX acquire_records_created ON acquire_records (created_at);

CREATE TABLE managed_objects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  arr_instance TEXT NOT NULL,
  kind TEXT NOT NULL,
  external_id INTEGER NOT NULL,
  name TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE (arr_instance, kind, external_id)
);

CREATE TABLE placed_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  arr_instance TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  placed_path TEXT NOT NULL,
  video_path TEXT NOT NULL,
  source_path TEXT NOT NULL,
  job_id INTEGER,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE (placed_path)
);

CREATE INDEX placed_files_target ON placed_files (arr_instance, target_kind, target_id);

CREATE INDEX placed_files_kind_created ON placed_files (kind, created_at);

CREATE TABLE attention_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  job_id INTEGER,
  data TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open',
  resolved_at INTEGER
);

CREATE INDEX attention_items_status ON attention_items (status);

CREATE INDEX attention_items_ts ON attention_items (ts);

CREATE TABLE archive_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  arr_instance TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  source_url TEXT NOT NULL,
  path TEXT NOT NULL,
  files TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  UNIQUE (arr_instance, target_kind, target_id, path)
);

CREATE INDEX archive_cache_target ON archive_cache (arr_instance, target_kind, target_id);

-- A subtitle site is identified by its base URL, which is unique by construction. Site
-- prose lives in one markdown file per site under the data directory, not here.
CREATE TABLE site_profiles (
  base_url TEXT PRIMARY KEY,
  last_working_tier TEXT,
  search_url_patterns TEXT NOT NULL DEFAULT '[]',
  last_success_at INTEGER,
  last_failure_at INTEGER,
  fail_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  -- Set when the agent has judged the site unautomatable and a human accepted that
  -- verdict. Health state, beside fail_count: the configured site list stays the
  -- operator's declared intent.
  disabled_at INTEGER,
  disabled_reason TEXT NOT NULL DEFAULT ''
);

CREATE TABLE sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
