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
