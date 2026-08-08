CREATE TABLE site_profiles (
  name TEXT PRIMARY KEY,
  base_url TEXT NOT NULL,
  last_working_tier TEXT,
  search_url_patterns TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  last_success_at INTEGER,
  last_failure_at INTEGER,
  fail_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

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

CREATE TABLE subtitle_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  site TEXT NOT NULL,
  transcript TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'running',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX subtitle_runs_job ON subtitle_runs (job_id);
