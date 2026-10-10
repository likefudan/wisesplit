-- Groups of people who share costs. The currency is fixed at creation (src/shared/currencies.ts);
-- the owner is whoever created the group and never changes (owners can't leave, only delete it).
CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL
);

-- Who is in which group. The owner is a member too.
CREATE TABLE group_members (
  group_id TEXT NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id),
  joined_at TEXT NOT NULL,
  -- Who added them: the owner at creation, the member who invited them by email, or the member
  -- whose invite link they used.
  added_by TEXT REFERENCES users (id),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_user ON group_members (user_id);

-- Invite links: single use, 7 days. Only the SHA-256 of the link's token is stored; the link itself
-- is shown once, to the member who made it.
CREATE TABLE group_invites (
  token_hash TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT REFERENCES users (id)
);
CREATE INDEX group_invites_group ON group_invites (group_id, expires_at);
