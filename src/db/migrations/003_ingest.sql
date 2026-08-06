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
