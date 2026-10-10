export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Public site address, for links in messages sent without a request (emails, push). */
  SITE_ORIGIN: string;
  /** "production", "staging" (the test site) or "local" (a developer's machine and the browser tests). */
  ENVIRONMENT?: string;
  /** Google OAuth web client (secrets). Without both, Google sign-in is shown as not set up yet. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Cloudflare Turnstile keys for the sign-up form. Only a local site may run without them. */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  /** Comma-separated Google emails of the site admins (secret, so the address stays out of the repo). */
  ADMIN_EMAILS?: string;
  /**
   * Turns on POST /api/test/login, which signs in as any Google identity without Google, for the
   * browser tests. Ignored unless ENVIRONMENT is "local" or "staging"; never works in production.
   */
  TEST_LOGIN_SECRET?: string;
}

/** The test site (staging.…) shows a banner and is hidden from search engines. */
export const isStaging = (env: Env) => env.ENVIRONMENT === "staging";

/** A developer's machine or the browser tests: the only place Turnstile may be missing. */
export const isLocal = (env: Env) => env.ENVIRONMENT === "local";
