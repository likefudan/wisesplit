import { Hono } from "hono";
import { startSession } from "../auth";
import type { Env } from "../env";
import { HttpError, readJson, str } from "../http";
import { timingSafeEqual } from "../lib/crypto";
import { googleName } from "../users";

/**
 * Sign in as any Google identity without going through Google, so browser tests can run. Only on a
 * local site or staging, and only with TEST_LOGIN_SECRET set; production never has it, whatever
 * its secrets say (test/testLogin.test.ts checks that).
 */
export const testLoginEnabled = (env: Env) =>
  (env.ENVIRONMENT === "local" || env.ENVIRONMENT === "staging") && !!env.TEST_LOGIN_SECRET;

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
  // The Google id is derived from the email unless given, so the same test user signs in again.
  const sub = str(body.sub) || `test:${email.toLowerCase()}`;
  await startSession(c, { google_sub: sub, email, name: googleName(body.name, email), picture: null });
  return c.body(null, 204);
});
