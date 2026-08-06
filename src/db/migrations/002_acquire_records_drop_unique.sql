-- The (arr_instance, target_kind, target_id, created_at) UNIQUE constraint assumed at
-- most one acquire_records row per millisecond for a given target. That held when a job
-- ever wrote at most one row, but a multi-season series job (src/pipelines/acquire/run.ts)
-- now writes one row per season in a tight loop that can genuinely produce more than one
-- row in the same millisecond for the same series. Recreated without the constraint: `id`
-- is already the real primary key, and nothing else relied on the uniqueness itself.
CREATE TABLE acquire_records_new (
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

INSERT INTO acquire_records_new
  (id, arr_instance, target_kind, target_id, source, status, picked_guid, release_group, reasoning, candidates_json, created_at)
  SELECT id, arr_instance, target_kind, target_id, source, status, picked_guid, release_group, reasoning, candidates_json, created_at
  FROM acquire_records;

DROP TABLE acquire_records;
ALTER TABLE acquire_records_new RENAME TO acquire_records;
