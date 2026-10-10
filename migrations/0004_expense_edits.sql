-- Expenses can be edited and deleted by any member of their group.
--
-- `version` goes up by one with every edit: a save names the version it started from, and is
-- turned down if someone else saved in between, instead of overwriting their change.
ALTER TABLE expenses ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE expenses ADD COLUMN updated_at TEXT;
ALTER TABLE expenses ADD COLUMN updated_by TEXT REFERENCES users (id);
-- Deleted expenses are kept (with their shares) for the activity log, but count for nothing:
-- every list, balance and settled-up check leaves them out.
ALTER TABLE expenses ADD COLUMN deleted_at TEXT;
ALTER TABLE expenses ADD COLUMN deleted_by TEXT REFERENCES users (id);

