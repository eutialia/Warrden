-- The dashboard's home screen asks for ten counts on every poll, and until now only one
-- of them had an index behind it. `events` in particular is append-only and never pruned,
-- so counting the last day's webhooks meant scanning the whole install's history.

CREATE INDEX IF NOT EXISTS events_kind_ts ON events (kind, ts);
CREATE INDEX IF NOT EXISTS jobs_status_updated ON jobs (status, updated_at);
CREATE INDEX IF NOT EXISTS placed_files_kind_created ON placed_files (kind, created_at);
CREATE INDEX IF NOT EXISTS attention_items_ts ON attention_items (ts);
CREATE INDEX IF NOT EXISTS acquire_records_created ON acquire_records (created_at);
