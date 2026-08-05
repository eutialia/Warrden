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
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX jobs_singleton
  ON jobs (pipeline, arr_instance, target_kind, target_id)
  WHERE status IN ('pending', 'running');

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  job_id INTEGER,
  message TEXT,
  data TEXT NOT NULL DEFAULT '{}'
);

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
  created_at INTEGER NOT NULL,
  UNIQUE (arr_instance, target_kind, target_id, created_at)
);

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

CREATE TABLE sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
