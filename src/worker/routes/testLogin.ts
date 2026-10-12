import { Hono } from "hono";
import { startSession } from "../auth";
import type { Env } from "../env";
import { HttpError, readJson, str } from "../http";
import { timingSafeEqual } from "../lib/crypto";
import { googleName } from "../users";

/**
 * Sign in as any Google identity without going through Google, so browser tests can run. Only on a
 * local site or staging, and only with TEST_LOGIN_SECRET set; production never has it, whatever
 * its secrets say (test/testLogin.test.ts checks that). Whoever holds the secret can still sign
 * up as an admin email, since the browser tests need an admin: keep the staging secret private.
 */
export const testLoginEnabled = (env: Env) =>
  (env.ENVIRONMENT === "local" || env.ENVIRONMENT === "staging") && !!env.TEST_LOGIN_SECRET;

/** The start of every test-login identity's Google id; Google's own ids are digits only. */
const TEST_SUB = "test:";

/**
 * A browser signed in through the test login (on a site where it works), whose sign-up skips
 * Turnstile: a robot check can't be passed by the browser tests that run against staging, and
 * whoever can sign in this way holds the secret already.
 */
export const isTestIdentity = (env: Env, session: { google_sub: string } | null) =>
  !!session && testLoginEnabled(env) && session.google_sub.startsWith(TEST_SUB);

export const testLoginRoutes = new Hono<{ Bindings: Env }>();

testLoginRoutes.post("/login", async (c) => {
  if (!testLoginEnabled(c.env)) throw new HttpError(404, "not_found", "Not found");
  const secret = c.req.header("X-Test-Login-Secret") ?? "";
  if (!timingSafeEqual(secret, c.env.TEST_LOGIN_SECRET!))
    throw new HttpError(403, "forbidden", "Wrong test login secret");
  const body = await readJson(c.req.raw);
  const email = str(body.email).trim();
  if (!/^[^@\s]+@[^@\s]+$/.test(email) || email.length > 254)
    throw new HttpError(400, "invalid_input", "email is required");
  // A Google id of its own ("test:" + email), so the same test user signs in again and a real
  // Google account can never be signed into (or have its email rewritten) through here.
  const sub = `${TEST_SUB}${email.toLowerCase()}`;
  await startSession(c, { google_sub: sub, email, name: googleName(body.name, email), picture: null });
  return c.body(null, 204);
});
