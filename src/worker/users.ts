import { isLang, type Lang } from "../shared/i18n";
import { isAdmin, isAdminEmail, type SessionRow, type UserRow, userByGoogle } from "./auth";
import type { Env } from "./env";
import { HttpError, now } from "./http";
import { randomId } from "./lib/crypto";
import { getSettings } from "./settings";

export const NAME_MAX = 50;

/** A display name: trimmed, inner whitespace collapsed, 1 to 50 characters, no control characters. */
export function parseName(value: unknown): string {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (!name || [...name].length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(name))
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
  const text = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
  return [...(text || email.split("@")[0] || email)].slice(0, NAME_MAX).join("");
}

/** What a user may see about themselves (and the admin about everyone). */
export function publicUser(env: Env, user: UserRow) {
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

/** Midnight UTC today: the daily sign-up cap counts applications from here on. */
const startOfDay = () => `${now().slice(0, 10)}T00:00:00.000Z`;

/**
 * Signs up the Google identity of `session` (`existing` null), or re-applies after a rejection
 * (`existing` is the rejected user; the caller has checked it is one). The application is
 * approved at once when the admin has turned approval off, or when the applicant is an admin;
 * otherwise it waits in the pending list. The daily cap applies either way, the pending cap only
 * to applications that will wait; admins skip both so they can never be locked out.
 *
 * The caps are checked in the same statement that writes the row, so parallel sign-ups can't
 * all slip in under the limit.
 */
export async function register(
  env: Env,
  session: SessionRow,
  existing: UserRow | null,
  input: { name: string; lang: Lang },
): Promise<UserRow> {
  const settings = await getSettings(env);
  const admin = isAdminEmail(env, session.email);
  const status = admin || !settings.requireApproval ? "approved" : "pending";
  const today = startOfDay();
  const at = now();
  // Bound as: [admin, today, dailyCap, status, pendingCap].
  const room = `(? OR ((SELECT COUNT(*) FROM users WHERE applied_at >= ?) < ?
    AND (? <> 'pending' OR (SELECT COUNT(*) FROM users WHERE status = 'pending') < ?)))`;
  const roomArgs = [admin ? 1 : 0, today, settings.dailySignupCap, status, settings.pendingCap];
  let saved: UserRow | null;
  try {
    saved = existing
      ? await env.DB.prepare(
          `UPDATE users SET status = ?, name = ?, lang = ?, applied_at = ?, decided_at = NULL, decided_by = NULL
           WHERE id = ? AND status = 'rejected' AND ${room} RETURNING *`,
        )
          .bind(status, input.name, input.lang, at, existing.id, ...roomArgs)
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
            ...roomArgs,
          )
          .first<UserRow>();
  } catch (err) {
    // Two tabs signing up the same account at once: the second hits the unique Google id.
    if (err instanceof Error && /UNIQUE/i.test(err.message))
      throw new HttpError(409, "already_registered", "This Google account has already signed up");
    throw err;
  }
  if (!saved) {
    const current = await userByGoogle(env, session.google_sub);
    if (current && current.status !== "rejected")
      throw new HttpError(409, "already_registered", "This Google account has already signed up");
    const daily = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE applied_at >= ?")
      .bind(today)
      .first<{ n: number }>();
    if ((daily?.n ?? 0) >= settings.dailySignupCap)
      throw new HttpError(429, "signup_cap_reached", "Today's sign-ups are full; try again tomorrow");
    throw new HttpError(429, "pending_full", "Too many sign-ups are waiting for approval; try again later");
  }
  return saved;
}
