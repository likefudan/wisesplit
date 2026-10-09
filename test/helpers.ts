import { exports } from "cloudflare:workers";
import { env } from "cloudflare:workers";
import worker from "../src/worker/index";
import type { UserStatus } from "../src/shared/users";
import type { Env } from "../src/worker/env";
import { randomId, sha256 } from "../src/worker/lib/crypto";

export const ORIGIN = "https://wisesplit.test";

/** A request to the Worker as the browser would send it. */
export const call = (path: string, init?: RequestInit) => exports.default.fetch(`${ORIGIN}${path}`, init);

/** The admin every test site has (see `send`). */
export const ADMIN_EMAIL = "admin@example.com";

/**
 * Calls the Worker directly with the given bindings on top of the test ones (the production
 * config), the way a browser on this site would: GET without a body, POST with a JSON one and the
 * site's Origin. Runs in the test's own isolate, so `vi.spyOn(globalThis, "fetch")` sees the
 * Worker's outgoing requests (Google, Turnstile).
 */
export function send(
  path: string,
  options: {
    body?: unknown;
    cookie?: string;
    origin?: string | null;
    env?: Partial<Env>;
    headers?: Record<string, string>;
  } = {},
) {
  const headers: Record<string, string> = { ...options.headers };
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    if (options.origin !== null) headers.Origin = options.origin ?? ORIGIN;
  }
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: options.body === undefined ? "GET" : "POST",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    { ...env, SITE_ORIGIN: ORIGIN, ADMIN_EMAILS: ADMIN_EMAIL, ...options.env },
    {} as ExecutionContext,
  );
}

/** A unique email, so tests sharing the database don't meet. */
export const uniqueEmail = (name = "user") => `${name}-${crypto.randomUUID().slice(0, 8)}@example.com`;

/** A signed-in browser for a Google identity (no user row unless `withUser`). Returns its cookie. */
export async function signIn(email: string, sub = `sub-${email}`, name = "Test User"): Promise<string> {
  const token = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO sessions (id_hash, google_sub, email, name, picture, created_at, expires_at) VALUES (?, ?, ?, ?, NULL, ?, ?)",
  )
    .bind(
      await sha256(token),
      sub,
      email,
      name,
      new Date().toISOString(),
      new Date(Date.now() + 3600_000).toISOString(),
    )
    .run();
  return `ws_session=${token}`;
}

/** A user in the given state with a signed-in browser. */
export async function makeUser(status: UserStatus, email = uniqueEmail(), name = "Test User") {
  const id = randomId();
  const sub = `sub-${email}`;
  const at = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO users (id, google_sub, email, name, lang, status, created_at, applied_at) VALUES (?, ?, ?, ?, 'en', ?, ?, ?)",
  )
    .bind(id, sub, email, name, status, at, at)
    .run();
  return { id, email, cookie: await signIn(email, sub, name) };
}

/** The approved admin (ADMIN_EMAIL), created once per test file's database. */
export async function admin() {
  const row = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(ADMIN_EMAIL).first<{ id: string }>();
  if (row) return { id: row.id, email: ADMIN_EMAIL, cookie: await signIn(ADMIN_EMAIL, `sub-${ADMIN_EMAIL}`) };
  return makeUser("approved", ADMIN_EMAIL, "Admin");
}

export const json = async (res: Response) => (await res.json()) as any;
