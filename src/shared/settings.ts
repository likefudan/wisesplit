/** What the admin can change on the settings page (stored by src/worker/settings.ts). */
export interface Settings {
  /** New sign-ups wait for the admin; when off they are approved at once (Turnstile and the daily cap still apply). */
  requireApproval: boolean;
  /** Sign-ups accepted per UTC day, re-applications included. */
  dailySignupCap: number;
  /** Sign-ups pause while this many applications wait for the admin. */
  pendingCap: number;
}

export const DEFAULT_SETTINGS: Settings = { requireApproval: true, dailySignupCap: 20, pendingCap: 30 };

/** The highest either cap may be set to; it only exists to catch typos. */
export const MAX_CAP = 1000;
