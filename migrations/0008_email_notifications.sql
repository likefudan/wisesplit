-- Email notifications: the same notifications as under the bell, by email (src/worker/email.ts).
-- On unless the person turns them off on the notification settings page.
ALTER TABLE notification_prefs ADD COLUMN email INTEGER NOT NULL DEFAULT 1 CHECK (email IN (0, 1));
