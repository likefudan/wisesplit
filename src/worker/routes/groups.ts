import { Hono } from "hono";
import { INVITE_DAYS, MAX_OPEN_INVITES } from "../../shared/groups";
import { type AppEnv, requireApproved } from "../auth";
import {
  groupDetail,
  groupForMember,
  groupsOf,
  isMember,
  MAY_NOT_LEAVE_SQL,
  mayNotLeaveArgs,
  parseCurrency,
  parseGroupName,
  UNSETTLED_SQL,
  unsettledArgs,
} from "../groups";
import { expenseRoutes } from "./expenses";
import type { Env } from "../env";
import { HttpError, now, readJson, str } from "../http";
import { randomId, randomToken, sha256 } from "../lib/crypto";

/** Groups, their members, and invites (the invite links themselves are used in routes/invites.ts). */
export const groupRoutes = new Hono<AppEnv>();
groupRoutes.use("*", requireApproved);
// Expenses and balances: /:id/expenses, /:id/balances.
groupRoutes.route("/:id", expenseRoutes);

const notSettled = () => new HttpError(409, "group_not_settled", "Everyone in the group must be settled up first");
const userNotFound = () => new HttpError(404, "user_not_found", "No approved user has this email");
const ownerOnly = () => new HttpError(403, "owner_only", "Only the group's owner can do this");

groupRoutes.get("/", async (c) => c.json({ groups: await groupsOf(c.env, c.get("user").id) }));

groupRoutes.post("/", async (c) => {
  const me = c.get("user");
  const body = await readJson(c.req.raw);
  const name = parseGroupName(body.name);
  const currency = parseCurrency(body.currency);
  const id = randomId();
  const at = now();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO groups (id, name, currency, owner_id, created_at) VALUES (?, ?, ?, ?, ?)").bind(
      id,
      name,
      currency,
      me.id,
      at,
    ),
    c.env.DB.prepare("INSERT INTO group_members (group_id, user_id, joined_at, added_by) VALUES (?, ?, ?, ?)").bind(
      id,
      me.id,
      at,
      me.id,
    ),
    c.env.DB.prepare(
      `INSERT INTO activity_log (id, group_id, actor_id, action, subject_id, data, created_at)
       VALUES (?, ?, ?, 'group.created', NULL, ?, ?)`,
    ).bind(randomId(), id, me.id, JSON.stringify({ name, currency }), at),
  ]);
  return c.json({ group: await groupDetail(c.env, { id, name, currency, owner_id: me.id, created_at: at }) });
});

groupRoutes.get("/:id", async (c) => {
  const group = await groupForMember(c.env, c.req.param("id"), c.get("user").id);
  return c.json({ group: await groupDetail(c.env, group) });
});

// Adds an approved user, found by their Google email, straight into the group.
groupRoutes.post("/:id/members", async (c) => {
  const me = c.get("user");
  const group = await groupForMember(c.env, c.req.param("id"), me.id);
  const email = str((await readJson(c.req.raw)).email).trim();
  if (!email || email.length > 254) throw new HttpError(400, "invalid_email", "Enter an email address");
  const user = await c.env.DB.prepare(
    "SELECT id FROM users WHERE lower(email) = lower(?) AND status = 'approved' ORDER BY created_at DESC LIMIT 1",
  )
    .bind(email)
    .first<{ id: string }>();
  if (!user) throw userNotFound();
  let added = false;
  const at = now();
  try {
    const [insert] = await c.env.DB.batch([
      // The one adding must still be in the group, and the one added still approved.
      c.env.DB.prepare(
        `INSERT INTO group_members (group_id, user_id, joined_at, added_by)
         SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?)
           AND EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'approved')
         RETURNING user_id`,
      ).bind(group.id, user.id, at, me.id, group.id, me.id, user.id),
      // Only if the statement above added them, which leaves this exact mark (a second add of the
      // same person fails on the primary key, undoing the whole batch).
      c.env.DB.prepare(
        `INSERT INTO activity_log (id, group_id, actor_id, action, subject_id, data, created_at)
         SELECT ?, ?, ?, 'member.added', ?, NULL, ? WHERE EXISTS (SELECT 1 FROM group_members
           WHERE group_id = ? AND user_id = ? AND joined_at = ? AND added_by = ?)`,
      ).bind(randomId(), group.id, me.id, user.id, at, group.id, user.id, at, me.id),
    ]);
    added = !!insert?.results.length;
  } catch (err) {
    if (!(err instanceof Error && /UNIQUE|PRIMARY KEY/i.test(err.message))) throw err;
    throw new HttpError(409, "already_member", "Already in this group");
  }
  // Not added: either the adder has just left the group (404 below) or the user was deactivated.
  if (!added) {
    await groupForMember(c.env, group.id, me.id);
    throw userNotFound();
  }
  return c.json({ group: await groupDetail(c.env, group), added: user.id });
});

/**
 * Takes someone out of a group, if they may go (`MAY_NOT_LEAVE_SQL`), with the invite links they
 * made for it that are still unused: a link stops working with its maker (src/worker/invites.ts),
 * and stays dead if they come back. `by` is who does it: themselves (leaving) or the owner. Whether
 * they were taken out.
 */
async function removeMember(env: Env, groupId: string, userId: string, by: string): Promise<boolean> {
  // Checked by the log entry and then by the removal, so the entry is written only with it.
  const mayGo = `EXISTS (SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?) AND NOT ${MAY_NOT_LEAVE_SQL}`;
  const mayGoArgs = [groupId, userId, ...mayNotLeaveArgs(groupId, userId)];
  const [, removed] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO activity_log (id, group_id, actor_id, action, subject_id, data, created_at)
       SELECT ?, ?, ?, ?, ?, NULL, ? WHERE ${mayGo}`,
    ).bind(randomId(), groupId, by, by === userId ? "member.left" : "member.removed", userId, now(), ...mayGoArgs),
    env.DB.prepare(`DELETE FROM group_members WHERE group_id = ? AND user_id = ? AND ${mayGo} RETURNING user_id`).bind(
      groupId,
      userId,
      ...mayGoArgs,
    ),
    env.DB.prepare(
      `DELETE FROM group_invites WHERE group_id = ? AND created_by = ? AND used_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?)`,
    ).bind(groupId, userId, groupId, userId),
  ]);
  return !!removed?.results.length;
}

// The owner removes someone else.
groupRoutes.post("/:id/members/:userId/remove", async (c) => {
  const me = c.get("user");
  const group = await groupForMember(c.env, c.req.param("id"), me.id);
  const userId = c.req.param("userId");
  if (group.owner_id !== me.id) throw ownerOnly();
  if (userId === me.id) throw new HttpError(400, "owner_cannot_leave", "The owner can't leave the group");
  if (!(await removeMember(c.env, group.id, userId, me.id))) {
    if (await isMember(c.env, group.id, userId)) throw notSettled();
    throw new HttpError(404, "not_a_member", "Not in this group");
  }
  return c.json({ group: await groupDetail(c.env, group) });
});

groupRoutes.post("/:id/leave", async (c) => {
  const me = c.get("user");
  const group = await groupForMember(c.env, c.req.param("id"), me.id);
  if (group.owner_id === me.id) throw new HttpError(400, "owner_cannot_leave", "The owner can't leave the group");
  // Not taken out and still there: not settled. (Gone anyway: removed meanwhile, which is fine.)
  if (!(await removeMember(c.env, group.id, me.id, me.id)) && (await isMember(c.env, group.id, me.id)))
    throw notSettled();
  return c.body(null, 204);
});

// Deletes the group, once settled up, with its members, invites, expenses and activity log.
groupRoutes.post("/:id/delete", async (c) => {
  const me = c.get("user");
  const group = await groupForMember(c.env, c.req.param("id"), me.id);
  if (group.owner_id !== me.id) throw ownerOnly();
  const deleted = await c.env.DB.prepare(
    `DELETE FROM groups WHERE id = ? AND owner_id = ? AND NOT ${UNSETTLED_SQL} RETURNING id`,
  )
    .bind(group.id, me.id, ...unsettledArgs(group.id))
    .first();
  if (!deleted) {
    await groupForMember(c.env, group.id, me.id); // deleted meanwhile: 404
    throw notSettled();
  }
  return c.body(null, 204);
});

// A new invite link. The token is returned once; only its hash is kept.
groupRoutes.post("/:id/invites", async (c) => {
  const me = c.get("user");
  const group = await groupForMember(c.env, c.req.param("id"), me.id);
  const token = randomToken();
  const at = now();
  const expiresAt = new Date(Date.parse(at) + INVITE_DAYS * 86400_000).toISOString();
  const [, insert] = await c.env.DB.batch([
    // Expired links are of no further interest (used ones are kept until then, to say so).
    c.env.DB.prepare("DELETE FROM group_invites WHERE group_id = ? AND expires_at <= ?").bind(group.id, at),
    // Counted in the statement that adds the link, so parallel requests can't get past the limit;
    // and its maker still in the group, so a link can't slip past removeMember's clean-up.
    c.env.DB.prepare(
      `INSERT INTO group_invites (token_hash, group_id, created_by, created_at, expires_at)
       SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM group_invites
         WHERE created_by = ? AND used_at IS NULL AND expires_at > ?) < ?
         AND EXISTS (SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?)
       RETURNING token_hash`,
    ).bind(await sha256(token), group.id, me.id, at, expiresAt, me.id, at, MAX_OPEN_INVITES, group.id, me.id),
  ]);
  if (!insert?.results.length) {
    await groupForMember(c.env, group.id, me.id);
    throw new HttpError(429, "too_many_invites", `At most ${MAX_OPEN_INVITES} unused invite links per member`);
  }
  return c.json({ token, expiresAt });
});
