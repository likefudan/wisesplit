-- What happened that someone should hear about: an expense involving them was added, edited or
-- deleted, a payment to or from them needs or got an answer, they were added to a group, their
-- sign-up was approved. Written by src/worker/notifications.ts, one row per person told; shown
-- under the bell in the header until read. Old ones go in the daily clean-up.
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  -- What happened ("expense.added", "payment.requested", …; src/shared/notifications.ts).
  kind TEXT NOT NULL,
  -- The group it happened in (NULL for the sign-up); deleting the group deletes these too.
  group_id TEXT REFERENCES groups (id) ON DELETE CASCADE,
  -- The expense or payment it is about, if any.
  subject_id TEXT,
  -- Who did it.
  actor_id TEXT REFERENCES users (id),
  -- Its details, as this person sees them (their own share of an expense, …), as JSON.
  data TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX notifications_user ON notifications (user_id, created_at);
CREATE INDEX notifications_unread ON notifications (user_id) WHERE read_at IS NULL;
CREATE INDEX notifications_created ON notifications (created_at);

-- How each person wants to hear about things, one column per channel. No row: the defaults.
-- Email and push come in later PRs, as more columns.
CREATE TABLE notification_prefs (
  user_id TEXT PRIMARY KEY REFERENCES users (id),
  in_app INTEGER NOT NULL DEFAULT 1 CHECK (in_app IN (0, 1))
);
