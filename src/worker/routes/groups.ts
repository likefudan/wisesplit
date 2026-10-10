import { Hono } from "hono";
import { INVITE_DAYS } from "../../shared/groups";
import { type AppEnv, requireApproved } from "../auth";
import {
  groupDetail,
  groupForMember,
  groupsOf,
  mayDelete,
  mayLeave,
  noSuchGroup,
  parseCurrency,
  parseGroupName,
} from "../groups";
import { HttpError, now, readJson, str } from "../http";
import { randomId, randomToken, sha256 } from "../lib/crypto";

/** Groups, their members, and invites (the invite links themselves are used in routes/invites.ts). */
export const groupRoutes = new Hono<AppEnv>();
groupRoutes.use("*", requireApproved);

const notSettled = () => new HttpError(409, "group_not_settled", "Everyone in the group must be settled up first");
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
  ]);
  return c.json({ group: await groupDetail(c.env, await groupForMember(c.env, id, me.id)) });
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
  if (!user) throw new HttpError(404, "user_not_found", "No approved user has this email");
  let added: unknown = null;
  try {
    // The one adding must still be in the group, and the one added still approved.
    added = await c.env.DB.prepare(
      `INSERT INTO group_members (group_id, user_id, joined_at, added_by)
       SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?)
         AND EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'approved')
       RETURNING user_id`,
    )
      .bind(group.id, user.id, now(), me.id, group.id, me.id, user.id)
      .first();
  } catch (err) {
    if (!(err instanceof Error && /UNIQUE|PRIMARY KEY/i.test(err.message))) throw err;
    throw new HttpError(409, "already_member", "Already in this group");
  }
  if (!added) throw noSuchGroup();
  return c.json({ group: await groupDetail(c.env, group) });
});

// The owner removes someone else.
groupRoutes.post("/:id/members/:userId/remove", async (c) => {
  const me = c.get("user");
  const group = await groupForMember(c.env, c.req.param("id"), me.id);
  const userId = c.req.param("userId");
  if (group.owner_id !== me.id) throw ownerOnly();
  if (userId === me.id) throw new HttpError(400, "owner_cannot_leave", "The owner can't leave the group");
  if (!(await mayLeave(c.env, group.id, userId))) throw notSettled();
  const removed = await c.env.DB.prepare(
    "DELETE FROM group_members WHERE group_id = ? AND user_id = ? RETURNING user_id",
  )
    .bind(group.id, userId)
    .first();
  if (!removed) throw new HttpError(404, "not_a_member", "Not in this group");
  return c.json({ group: await groupDetail(c.env, group) });
});

groupRoutes.post("/:id/leave", async (c) => {
  const me = c.get("user");
  const group = await groupForMember(c.env, c.req.param("id"), me.id);
  if (group.owner_id === me.id) throw new HttpError(400, "owner_cannot_leave", "The owner can't leave the group");
  if (!(await mayLeave(c.env, group.id, me.id))) throw notSettled();
  await c.env.DB.prepare("DELETE FROM group_members WHERE group_id = ? AND user_id = ?").bind(group.id, me.id).run();
  return c.body(null, 204);
});

// Deletes the group with its members and invites (and, from PR 3 on, its records).
groupRoutes.post("/:id/delete", async (c) => {
  const me = c.get("user");
  const group = await groupForMember(c.env, c.req.param("id"), me.id);
  if (group.owner_id !== me.id) throw ownerOnly();
  if (!(await mayDelete(c.env, group.id))) throw notSettled();
  await c.env.DB.prepare("DELETE FROM groups WHERE id = ? AND owner_id = ?").bind(group.id, me.id).run();
  return c.body(null, 204);
});

// A new invite link. The token is returned once; only its hash is kept.
groupRoutes.post("/:id/invites", async (c) => {
  const me = c.get("user");
  const group = await groupForMember(c.env, c.req.param("id"), me.id);
  const token = randomToken();
  const at = new Date();
  const expiresAt = new Date(at.getTime() + INVITE_DAYS * 86400_000).toISOString();
  await c.env.DB.batch([
    // Expired links are of no further interest (used ones are kept until then, to say so).
    c.env.DB.prepare("DELETE FROM group_invites WHERE group_id = ? AND expires_at <= ?").bind(
      group.id,
      at.toISOString(),
    ),
    c.env.DB.prepare(
      "INSERT INTO group_invites (token_hash, group_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(await sha256(token), group.id, me.id, at.toISOString(), expiresAt),
  ]);
  return c.json({ token, expiresAt });
});
