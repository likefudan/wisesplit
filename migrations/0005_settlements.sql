-- Payments between two members of a group, to settle up. The amount is in the group currency's
-- smallest unit. Only confirmed payments count toward balances; a pending one waits for the payee
-- to say it arrived (or, when the payee has been deactivated, counts as soon as it is recorded).
CREATE TABLE settlements (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  -- Who paid and who was paid.
  from_user TEXT NOT NULL REFERENCES users (id),
  to_user TEXT NOT NULL REFERENCES users (id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('venmo', 'other')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'declined', 'withdrawn')),
  created_by TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL,
  -- When and by whom it stopped being pending (confirmed, declined or withdrawn).
  decided_at TEXT,
  decided_by TEXT REFERENCES users (id),
  CHECK (from_user <> to_user)
);
CREATE INDEX settlements_group ON settlements (group_id, status, created_at);
CREATE INDEX settlements_from ON settlements (group_id, from_user);
CREATE INDEX settlements_to ON settlements (group_id, to_user);
