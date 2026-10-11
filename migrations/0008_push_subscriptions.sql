-- Browsers (phones, computers) that get push notifications, one row per browser that turned them on
-- (src/worker/push.ts). Turning push off on that browser, or the push service saying the
-- subscription is gone, removes the row. Signing in as someone else and turning push on there
-- moves the row to them.
CREATE TABLE push_subscriptions (
  -- Where the push service takes messages for this browser (an https URL).
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  -- The browser's keys for encrypting messages to it (base64url): its P-256 public key and
  -- 16-byte secret.
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id, created_at);
