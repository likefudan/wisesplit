import type { Lang } from "../shared/i18n";
import { type SessionRow, type UserRow, userByGoogle } from "./auth";
import type { Env } from "./env";
import { HttpError, now } from "./http";
import { randomId, sha256 } from "./lib/crypto";
import { alreadyRegistered } from "./users";

/** An invite link's token: 43 base64url characters (randomToken). */
export const isInviteToken = (v: string) => /^[\w-]{43}$/.test(v);

export const inviteNotFound = () => new HttpError(404, "invite_not_found", "No such invite link");
export const inviteUnusable = () =>
  new HttpError(410, "invite_unusable", "This invite link has expired or was already used");

export interface InviteRow {
  token_hash: string;
  group_id: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  used_by: string | null;
}

/** The invite for a link's token, with its group's name and the name of the member who made it. */
export async function findInvite(env: Env, token: string) {
  if (!isInviteToken(token)) return null;
  return env.DB.prepare(
    `SELECT i.*, g.name AS group_name, u.name AS inviter_name
     FROM group_invites i JOIN groups g ON g.id = i.group_id JOIN users u ON u.id = i.created_by
     WHERE i.token_hash = ?`,
  )
    .bind(await sha256(token))
    .first<InviteRow & { group_name: string; inviter_name: string }>();
}

// Bound as [tokenHash, now]: the invite can still be used.
const USABLE = "token_hash = ? AND used_at IS NULL AND expires_at > ?";

/**
 * An existing user follows an invite link: they join its group and the link is used up. A user
 * still waiting for approval is approved by it, as a new sign-up through the link would be (the
 * member who sent the link vouches for them). The caller has checked the user is approved or
 * pending, and not yet in the group (so the link stays usable for someone else).
 */
export async function joinByInvite(env: Env, token: string, user: UserRow): Promise<void> {
  const hash = await sha256(token);
  const at = now();
  // Statements 2 and 3 only act if statement 1 used the link, which leaves this exact mark on it.
  const used = "EXISTS (SELECT 1 FROM group_invites WHERE token_hash = ? AND used_by = ? AND used_at = ?)";
  const [use] = await env.DB.batch([
    // Still allowed in: the admin may have rejected or deactivated them since the caller checked.
    env.DB.prepare(
      `UPDATE group_invites SET used_at = ?, used_by = ? WHERE ${USABLE}
       AND EXISTS (SELECT 1 FROM users WHERE id = ? AND status IN ('approved', 'pending'))`,
    ).bind(at, user.id, hash, at, user.id),
    env.DB.prepare(
      `INSERT INTO group_members (group_id, user_id, joined_at, added_by)
       SELECT group_id, ?, ?, created_by FROM group_invites WHERE token_hash = ? AND used_by = ? AND used_at = ?
       ON CONFLICT DO NOTHING`,
    ).bind(user.id, at, hash, user.id, at),
    env.DB.prepare(
      `UPDATE users SET status = 'approved', decided_at = ?, decided_by = NULL
       WHERE id = ? AND status = 'pending' AND ${used}`,
    ).bind(at, user.id, hash, user.id, at),
  ]);
  if (!use?.meta.changes) throw inviteUnusable();
}

/**
 * Signs up a new user through an invite link: approved at once, whatever the approval setting,
 * and without taking a place under the daily or pending caps (the caller still checks Turnstile).
 * The user, the link being used up and the membership are written together or not at all.
 */
export async function registerByInvite(
  env: Env,
  session: SessionRow,
  input: { name: string; lang: Lang },
  token: string,
): Promise<{ user: UserRow; groupId: string }> {
  const hash = await sha256(token);
  const id = randomId();
  const at = now();
  let results: D1Result[];
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, google_sub, email, name, picture, lang, status, created_at, applied_at, decided_at)
         SELECT ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ? WHERE EXISTS (SELECT 1 FROM group_invites WHERE ${USABLE})
         RETURNING *`,
      ).bind(id, session.google_sub, session.email, input.name, session.picture, input.lang, at, at, at, hash, at),
      env.DB.prepare(`UPDATE group_invites SET used_at = ?, used_by = ? WHERE ${USABLE}`).bind(at, id, hash, at),
      env.DB.prepare(
        `INSERT INTO group_members (group_id, user_id, joined_at, added_by)
         SELECT group_id, ?, ?, created_by FROM group_invites WHERE token_hash = ? AND used_by = ?
         RETURNING group_id`,
      ).bind(id, at, hash, id),
    ]);
  } catch (err) {
    // Signed up meanwhile in another tab: the unique Google id.
    if (!(err instanceof Error && /UNIQUE/i.test(err.message))) throw err;
    if (await userByGoogle(env, session.google_sub)) throw alreadyRegistered();
    throw err;
  }
  const user = results[0]?.results[0] as UserRow | undefined;
  const joined = results[2]?.results[0] as { group_id: string } | undefined;
  if (!user || !joined) throw inviteUnusable();
  return { user, groupId: joined.group_id };
}
