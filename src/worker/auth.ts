import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Env } from "./env";
import { HttpError, now } from "./http";
import { randomToken, sha256 } from "./lib/crypto";

/** Who a session belongs to: a Google identity, whether or not it has applied yet. */
export interface SessionRow {
  google_sub: string;
  email: string;
  name: string;
  picture: string | null;
}

export type UserStatus = "pending" | "approved" | "rejected" | "deactivated";

export interface UserRow {
  id: string;
  google_sub: string;
  email: string;
  name: string;
  picture: string | null;
  venmo: string | null;
  lang: "en" | "zh";
  status: UserStatus;
  created_at: string;
  applied_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

/** Hono's types for routes behind `requireApproved`: `c.get("user")` is the signed-in, approved user. */
export type AppEnv = { Bindings: Env; Variables: { user: UserRow } };

export const SESSION_COOKIE = "ws_session";
const SESSION_DAYS = 30;

export const cookieOptions = (c: Context<any>) => ({
  path: "/",
  httpOnly: true,
  // Plain http only on a developer's machine (localhost); everywhere else the cookie needs HTTPS.
  secure: new URL(c.req.url).protocol === "https:",
  sameSite: "Lax" as const,
});

/** Signs this browser in as a Google identity, replacing any session it had. */
export async function startSession<E extends { Bindings: Env }>(c: Context<E>, identity: SessionRow): Promise<void> {
  const raw = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  const old = getCookie(c, SESSION_COOKIE);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM sessions WHERE expires_at < ? OR id_hash = ?").bind(
      now(),
      old ? await sha256(old) : "",
    ),
    c.env.DB.prepare(
      "INSERT INTO sessions (id_hash, google_sub, email, name, picture, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      await sha256(raw),
      identity.google_sub,
      identity.email,
      identity.name,
      identity.picture,
      now(),
      expires.toISOString(),
    ),
    // Keep what Google says about an existing user current: the email decides who is an admin.
    c.env.DB.prepare("UPDATE users SET email = ?, picture = ? WHERE google_sub = ?").bind(
      identity.email,
      identity.picture,
      identity.google_sub,
    ),
  ]);
  setCookie(c, SESSION_COOKIE, raw, { ...cookieOptions(c), expires });
}

export async function endSession<E extends { Bindings: Env }>(c: Context<E>): Promise<void> {
  const raw = getCookie(c, SESSION_COOKIE);
  if (raw)
    await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?")
      .bind(await sha256(raw))
      .run();
  deleteCookie(c, SESSION_COOKIE, cookieOptions(c));
}

/** The Google identity this browser is signed in as, or null. */
export async function currentSession<E extends { Bindings: Env }>(c: Context<E>): Promise<SessionRow | null> {
  const raw = getCookie(c, SESSION_COOKIE);
  if (!raw) return null;
  return c.env.DB.prepare("SELECT google_sub, email, name, picture FROM sessions WHERE id_hash = ? AND expires_at > ?")
    .bind(await sha256(raw), now())
    .first<SessionRow>();
}

export const userByGoogle = (env: Env, sub: string) =>
  env.DB.prepare("SELECT * FROM users WHERE google_sub = ?").bind(sub).first<UserRow>();

/** Whether a Google email is one of the admins listed in the ADMIN_EMAILS secret (case doesn't matter). */
export function isAdminEmail(env: Env, email: string): boolean {
  const admins = (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(email.trim().toLowerCase());
}

/** An admin is an approved user with an admin email; deactivating one takes the console away too. */
export const isAdmin = (env: Env, user: Pick<UserRow, "email" | "status">) =>
  user.status === "approved" && isAdminEmail(env, user.email);

/** Why a signed-in Google identity may not use the site yet, by the state of its application. */
const notApproved: Record<Exclude<UserStatus, "approved">, () => HttpError> = {
  pending: () => new HttpError(403, "pending_approval", "Your sign-up is waiting for the admin's approval"),
  rejected: () => new HttpError(403, "account_rejected", "Your sign-up was not approved; you may apply again"),
  deactivated: () => new HttpError(403, "account_deactivated", "This account has been deactivated"),
};

/** Guard for everything a member does: signed in, applied, and approved. Sets `c.get("user")`. */
export const requireApproved: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = await currentSession(c);
  if (!session) throw new HttpError(401, "login_required", "Sign in with Google first");
  const user = await userByGoogle(c.env, session.google_sub);
  if (!user) throw new HttpError(403, "signup_required", "Finish signing up first");
  if (user.status !== "approved") throw notApproved[user.status]();
  c.set("user", user);
  await next();
};

/** Guard for the admin console: an approved user whose Google email is listed in ADMIN_EMAILS. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  await requireApproved(c, async () => {
    if (!isAdmin(c.env, c.get("user"))) throw new HttpError(403, "forbidden", "Admins only");
    await next();
  });
};
