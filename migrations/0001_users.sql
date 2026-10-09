-- People who signed in with Google and applied. Identity is Google's stable `sub`, not the email
-- (which can change); the email is refreshed on every sign-in and decides who is an admin.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  picture TEXT,
  venmo TEXT,
  lang TEXT NOT NULL DEFAULT 'en' CHECK (lang IN ('en', 'zh')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'deactivated')),
  created_at TEXT NOT NULL,
  -- The latest application (a rejected user may apply again); counts toward the daily cap.
  applied_at TEXT NOT NULL,
  -- The admin's latest decision (approve, reject, deactivate, reactivate).
  decided_at TEXT,
  decided_by TEXT REFERENCES users (id)
);
CREATE INDEX users_status ON users (status, applied_at);
CREATE INDEX users_applied_at ON users (applied_at);

-- Browser sessions. Only the SHA-256 of the cookie value is stored. A session is a Google identity:
-- it exists before the person has applied, so the sign-up form knows who is signing up.
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  picture TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_expires_at ON sessions (expires_at);

-- A Google sign-in in progress (10 minutes): state (hashed), nonce, PKCE verifier, and the page
-- of this site to land on afterwards.
CREATE TABLE oauth_states (
  id_hash TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  verifier TEXT NOT NULL,
  next TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Site-wide settings the admin can change (see src/worker/settings.ts for keys and defaults).
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
