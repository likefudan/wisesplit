import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { UserStatus } from "../shared/users";
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

/**
 * A cookie's name on this site. Over HTTPS it carries the __Host- prefix, which browsers only accept
 * from this exact host (Secure, Path=/, no Domain), so another *.llmat.dev site can't plant one.
 * Plain http is a developer's localhost, where the prefix can't be used.
 */
export const cookieName = (c: Context<any>, base: string) =>
  new URL(c.req.url).protocol === "https:" ? `__Host-${base}` : base;
const sessionCookie = (c: Context<any>) => cookieName(c, "ws_session");
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
  const old = getCookie(c, sessionCookie(c));
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
  setCookie(c, sessionCookie(c), raw, { ...cookieOptions(c), expires });
}

export async function endSession<E extends { Bindings: Env }>(c: Context<E>): Promise<void> {
  const raw = getCookie(c, sessionCookie(c));
  if (raw)
    await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?")
      .bind(await sha256(raw))
      .run();
  deleteCookie(c, sessionCookie(c), cookieOptions(c));
}

/**
 * Who this browser is, in one query: its Google identity (null when signed out) and the user that
 * identity signed up as (null before signing up).
 *
 * A user named in ADMIN_EMAILS is always approved: one who signed up before being named (and is
 * still pending, or was rejected or deactivated) is approved here, on their first request after.
 * The console can't change admins (routes/admin.ts), so the admin can never be locked out.
 */
export async function signedIn<E extends { Bindings: Env }>(
  c: Context<E>,
): Promise<{ session: SessionRow | null; user: UserRow | null }> {
  const raw = getCookie(c, sessionCookie(c));
  if (!raw) return { session: null, user: null };
  const row = await c.env.DB.prepare(
    `SELECT s.google_sub AS s_sub, s.email AS s_email, s.name AS s_name, s.picture AS s_picture, u.*
     FROM sessions s LEFT JOIN users u ON u.google_sub = s.google_sub
     WHERE s.id_hash = ? AND s.expires_at > ?`,
  )
    .bind(await sha256(raw), now())
    .first<UserRow & { s_sub: string; s_email: string; s_name: string; s_picture: string | null }>();
  if (!row) return { session: null, user: null };
  const { s_sub, s_email, s_name, s_picture, ...user } = row;
  const session = { google_sub: s_sub, email: s_email, name: s_name, picture: s_picture };
  if (!user.id) return { session, user: null };
  if (user.status !== "approved" && isAdminEmail(c.env, user.email)) {
    // Approved by being named admin, not by anyone in the console.
    const promoted = await c.env.DB.prepare(
      "UPDATE users SET status = 'approved', decided_at = ?, decided_by = NULL WHERE id = ? AND status <> 'approved' RETURNING *",
    )
      .bind(now(), user.id)
      .first<UserRow>();
    return { session, user: promoted ?? (await userByGoogle(c.env, s_sub)) };
  }
  return { session, user };
}

export const userByGoogle = (env: Env, sub: string) =>
  env.DB.prepare("SELECT * FROM users WHERE google_sub = ?").bind(sub).first<UserRow>();

/** Whether a Google email is one of the admins listed in the ADMIN_EMAILS secret (case doesn't matter). */
export function isAdminEmail(env: Env, email: string): boolean {
  return adminEmails(env).includes(email.trim().toLowerCase());
}

/** The ADMIN_EMAILS list, lowercased. */
export const adminEmails = (env: Env) =>
  (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

/**
 * An admin is an approved user with an admin email. Admins can't be rejected or deactivated (the
 * console refuses, and signedIn() re-approves them): removing the email from ADMIN_EMAILS is how
 * someone stops being one.
 */
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
  const { session, user } = await signedIn(c);
  if (!session) throw new HttpError(401, "login_required", "Sign in with Google first");
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
