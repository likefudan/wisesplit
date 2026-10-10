import type { InviteInfo } from "../shared/groups";
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

// Whoever made the link still vouches for it: still in its group, and still allowed on the site.
// Used inside a statement on group_invites.
const VOUCHED = `EXISTS (SELECT 1 FROM group_members m JOIN users u ON u.id = m.user_id
  WHERE m.group_id = group_invites.group_id AND m.user_id = group_invites.created_by AND u.status = 'approved')`;

// Bound as [tokenHash, now]: the invite can still be used.
const USABLE = `token_hash = ? AND used_at IS NULL AND expires_at > ? AND ${VOUCHED}`;

export type InviteState = InviteInfo["state"];

/**
 * The invite for a link's token, with its group's name, the name of the member who made it, and
 * whether it can be used: not yet used, not expired, and its maker still in the group and approved
 * ("revoked" otherwise, so a removed or deactivated member's links stop working).
 */
export async function findInvite(env: Env, token: string) {
  if (!isInviteToken(token)) return null;
  const row = await env.DB.prepare(
    `SELECT group_invites.*, g.name AS group_name, u.name AS inviter_name, ${VOUCHED} AS vouched
     FROM group_invites JOIN groups g ON g.id = group_invites.group_id JOIN users u ON u.id = group_invites.created_by
     WHERE group_invites.token_hash = ?`,
  )
    .bind(await sha256(token))
    .first<InviteRow & { group_name: string; inviter_name: string; vouched: number }>();
  if (!row) return null;
  const state: InviteState = row.used_at
    ? "used"
    : row.expires_at <= now()
      ? "expired"
      : row.vouched
        ? "valid"
        : "revoked";
  return { ...row, state };
}

/**
 * An approved user follows an invite link: they join its group and the link is used up. Throws
 * `inviteUnusable` if the link can't be used, the user is no longer approved, or is in the group
 * already. (Someone still waiting for approval is not let in by a link: they may be waiting
 * because the admin rejected them once. Only new sign-ups skip the queue, registerByInvite.)
 */
export async function joinByInvite(env: Env, token: string, user: UserRow): Promise<void> {
  const hash = await sha256(token);
  const at = now();
  const [use] = await env.DB.batch([
    // Still approved: the admin may have deactivated them since the caller checked. Not already in
    // the group either (added by email meanwhile): then the link stays for someone else.
    env.DB.prepare(
      `UPDATE group_invites SET used_at = ?, used_by = ? WHERE ${USABLE}
       AND EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'approved')
       AND NOT EXISTS (SELECT 1 FROM group_members WHERE group_id = group_invites.group_id AND user_id = ?)`,
    ).bind(at, user.id, hash, at, user.id, user.id),
    // Only if the statement above used the link, which leaves this exact mark on it.
    env.DB.prepare(
      `INSERT INTO group_members (group_id, user_id, joined_at, added_by)
       SELECT group_id, ?, ?, created_by FROM group_invites WHERE token_hash = ? AND used_by = ? AND used_at = ?`,
    ).bind(user.id, at, hash, user.id, at),
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
