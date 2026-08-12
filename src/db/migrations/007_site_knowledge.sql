-- Site prose moved out of the database and into one markdown file per site under the data
-- directory, where the agent maintains it from its own runs. The column is dropped rather
-- than kept in sync: two sources of truth for the same text is how they diverge.

ALTER TABLE site_profiles DROP COLUMN notes;

-- A site the agent has judged unautomatable, after a human accepted that verdict. Kept
-- beside fail_count because it is health state, not configuration: the configured site
-- list stays the operator's declared intent.
ALTER TABLE site_profiles ADD COLUMN disabled_at INTEGER;
ALTER TABLE site_profiles ADD COLUMN disabled_reason TEXT NOT NULL DEFAULT '';
