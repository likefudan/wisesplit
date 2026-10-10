import { isLang, type Lang } from "../shared/i18n";
import type { PublicUser } from "../shared/users";
import { isAdmin, isAdminEmail, type SessionRow, type UserRow, userByGoogle } from "./auth";
import type { Env } from "./env";
import { HttpError, now } from "./http";
import { randomId } from "./lib/crypto";
import { getSettings } from "./settings";

export const NAME_MAX = 50;

/** A name as stored: trimmed, inner whitespace (control characters included) collapsed to one space. */
const tidyName = (value: unknown) => (typeof value === "string" ? value.replace(/[\s\p{Cc}]+/gu, " ").trim() : "");

/** A display name: tidied, then 1 to 50 characters. */
export function parseName(value: unknown): string {
  const name = tidyName(value);
  if (!name || [...name].length > NAME_MAX)
    throw new HttpError(400, "invalid_name", `Display name must be 1 to ${NAME_MAX} characters`);
  return name;
}

/**
 * A Venmo username, stored without the "@" people often type: 5 to 30 letters, digits, "-" or "_"
 * (Venmo's own rule). Empty clears it.
 */
export function parseVenmo(value: unknown): string | null {
  const venmo = typeof value === "string" ? value.trim().replace(/^@/, "") : "";
  if (!venmo) return null;
  if (!/^[A-Za-z0-9_-]{5,30}$/.test(venmo))
    throw new HttpError(400, "invalid_venmo", "Venmo username must be 5 to 30 letters, digits, - or _");
  return venmo;
}

export function parseLang(value: unknown): Lang {
  if (!isLang(value)) throw new HttpError(400, "invalid_lang", "Language must be en or zh");
  return value;
}

/** The name Google gives, cut to fit; the sign-up form shows it for the person to keep or change. */
export function googleName(name: unknown, email: string): string {
  const text = tidyName(name) || tidyName(email.split("@")[0]) || "?";
  return [...text].slice(0, NAME_MAX).join("").trim();
}

/** What a user may see about themselves (and the admin about everyone). */
export function publicUser(env: Env, user: UserRow): PublicUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    picture: user.picture,
    venmo: user.venmo,
    lang: user.lang,
    status: user.status,
    isAdmin: isAdmin(env, user),
  };
}

export const alreadyRegistered = () =>
  new HttpError(409, "already_registered", "This Google account has already signed up");

/**
 * Signs up the Google identity of `session` (`existing` null), or re-applies after a rejection
 * (`existing` is the rejected user; the caller has checked it is one).
 *
 * A new sign-up is approved at once when the admin has turned approval off; a re-application
 * always waits for the admin, who rejected it before. Admins are approved at once and skip both
 * caps, so they can never be locked out. Everyone else takes one of the day's places (the daily
 * cap), and applications that will wait also need room on the pending list (the pending cap).
 * Each limit is checked in the same statement that uses it, so parallel sign-ups can't all slip in.
 */
export async function register(
  env: Env,
  session: SessionRow,
  existing: UserRow | null,
  input: { name: string; lang: Lang },
): Promise<UserRow> {
  const settings = await getSettings(env);
  const admin = isAdminEmail(env, session.email);
  const status = admin || (!existing && !settings.requireApproval) ? "approved" : "pending";
  const day = now().slice(0, 10);
  if (!admin) {
    const place = await env.DB.prepare(
      `INSERT INTO signup_days (day, count) SELECT ?, 1 WHERE ? > 0
       ON CONFLICT (day) DO UPDATE SET count = count + 1 WHERE count < ? RETURNING count`,
    )
      .bind(day, settings.dailySignupCap, settings.dailySignupCap)
      .first();
    if (!place) throw new HttpError(429, "signup_cap_reached", "Today's sign-ups are full; try again tomorrow");
  }
  const at = now();
  // Room on the pending list, bound as [status, pendingCap]; admins never wait, so never need it.
  const room = `(? <> 'pending' OR (SELECT COUNT(*) FROM users WHERE status = 'pending') < ?)`;
  let saved: UserRow | null = null;
  try {
    saved = existing
      ? await env.DB.prepare(
          `UPDATE users SET status = ?, name = ?, lang = ?, applied_at = ?, decided_at = NULL, decided_by = NULL
           WHERE id = ? AND status = 'rejected' AND ${room} RETURNING *`,
        )
          .bind(status, input.name, input.lang, at, existing.id, status, settings.pendingCap)
          .first<UserRow>()
      : await env.DB.prepare(
          `INSERT INTO users (id, google_sub, email, name, picture, lang, status, created_at, applied_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${room} RETURNING *`,
        )
          .bind(
            randomId(),
            session.google_sub,
            session.email,
            input.name,
            session.picture,
            input.lang,
            status,
            at,
            at,
            status,
            settings.pendingCap,
          )
          .first<UserRow>();
  } catch (err) {
    // Two tabs signing up the same account at once: the second hits the unique Google id.
    if (!(err instanceof Error && /UNIQUE/i.test(err.message))) throw err;
  } finally {
    // Nothing was written: give the day's place back.
    if (!saved && !admin)
      await env.DB.prepare("UPDATE signup_days SET count = count - 1 WHERE day = ? AND count > 0").bind(day).run();
  }
  if (saved) return saved;
  const current = await userByGoogle(env, session.google_sub);
  if (current && current.status !== "rejected") throw alreadyRegistered();
  throw new HttpError(429, "pending_full", "Too many sign-ups are waiting for approval; try again later");
}
