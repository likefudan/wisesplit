-- Email notifications: the same notifications as under the bell, by email (src/worker/email.ts).
-- On unless the person turns them off on the notification settings page.
ALTER TABLE notification_prefs ADD COLUMN email INTEGER NOT NULL DEFAULT 1 CHECK (email IN (0, 1));

-- Notification emails per UTC day (YYYY-MM-DD), to stay within Resend's free tier of 100 a day,
-- some of which are kept for answers to sign-ups (src/worker/email.ts).
CREATE TABLE email_days (
  day TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);
