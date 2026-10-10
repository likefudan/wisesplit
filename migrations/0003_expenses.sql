-- What someone paid for the group. The amount is a whole number of the group currency's smallest
-- unit (cents, yen). One person paid; expense_shares says who shares it.
CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  paid_by TEXT NOT NULL REFERENCES users (id),
  -- The day it happened (YYYY-MM-DD), as entered; not a moment in time.
  date TEXT NOT NULL,
  split_method TEXT NOT NULL CHECK (split_method IN ('equal', 'exact', 'percent', 'shares', 'adjust')),
  -- The split as entered (percentages, shares, adjustments; JSON), so an edit form can show it
  -- again. NULL for an equal split, which needs nothing beyond who takes part.
  split_params TEXT,
  created_by TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL
);
CREATE INDEX expenses_group_date ON expenses (group_id, date, created_at, id);
CREATE INDEX expenses_payer ON expenses (group_id, paid_by);

-- Each person's part of an expense. The parts of one expense add up to its amount.
CREATE TABLE expense_shares (
  expense_id TEXT NOT NULL REFERENCES expenses (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  PRIMARY KEY (expense_id, user_id)
);
CREATE INDEX expense_shares_user ON expense_shares (user_id);

-- What happened in a group, newest last: who did what, when. `action` names the event
-- ("expense.added", …) and `data` holds its details as JSON; later PRs add edits (with the
-- before and after), deletions, payments, joins and leaves.
CREATE TABLE activity_log (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users (id),
  action TEXT NOT NULL,
  -- The expense (or, later, payment or member) it is about.
  subject_id TEXT,
  data TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX activity_log_group ON activity_log (group_id, created_at);
