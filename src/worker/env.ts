export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Public site address, for links in messages sent without a request (emails, push). */
  SITE_ORIGIN: string;
  /** "production" or "staging" (the test site). */
  ENVIRONMENT?: string;
}

/** The test site (staging.…) shows a banner and is hidden from search engines. */
export const isStaging = (env: Env) => env.ENVIRONMENT === "staging";
