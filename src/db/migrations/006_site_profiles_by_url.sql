-- A subtitle site is identified by its base URL, which is unique by construction. The
-- name beside it was a second identity nothing enforced: two sites could share one, and
-- editing or deleting either then hit both.
--
-- Rows are folded on base_url in case a config ever produced duplicates; the oldest of a
-- pair keeps the learned tier and notes.

CREATE TABLE site_profiles_new (
  base_url TEXT PRIMARY KEY,
  last_working_tier TEXT,
  search_url_patterns TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  last_success_at INTEGER,
  last_failure_at INTEGER,
  fail_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

INSERT INTO site_profiles_new
SELECT base_url, last_working_tier, search_url_patterns, notes, last_success_at, last_failure_at, fail_count,
       MIN(created_at)
FROM site_profiles
GROUP BY base_url;

DROP TABLE site_profiles;
ALTER TABLE site_profiles_new RENAME TO site_profiles;
