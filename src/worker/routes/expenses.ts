import { Hono } from "hono";
import { ACTIVITY_PAGE, type ExpenseSnapshot } from "../../shared/activity";
import { EXPENSES_PAGE, netOf } from "../../shared/expenses";
import { activityPage } from "../activity";
import type { AppEnv } from "../auth";
import type { Env } from "../env";
import { balances, changeOf, expenseById, expensePage, parseNewExpense, snapshot } from "../expenses";
import { groupForMember } from "../groups";
import { HttpError, now, readJson } from "../http";
import { randomId } from "../lib/crypto";

/** A group's expenses, balances and activity log, under /api/groups/:id (behind requireApproved there). */
export const expenseRoutes = new Hono<AppEnv>();

const expenseNotFound = () => new HttpError(404, "expense_not_found", "No such expense; it may have been deleted");
const expenseChanged = () =>
  new HttpError(409, "expense_changed", "Someone else changed this expense meanwhile; load it again");
const notInGroup = () => new HttpError(400, "not_in_group", "Everyone in an expense must be in the group");

expenseRoutes.get("/expenses", async (c) => {
  const group = await groupForMember(c.env, c.req.param("id")!, c.get("user").id);
  return c.json(await expensePage(c.env, group.id, c.req.query("before") || null, EXPENSES_PAGE));
});

expenseRoutes.get("/expenses/:expenseId", async (c) => {
  const group = await groupForMember(c.env, c.req.param("id")!, c.get("user").id);
  const expense = await expenseById(c.env, group.id, c.req.param("expenseId"));
  if (!expense) throw expenseNotFound();
  return c.json({ expense });
});

expenseRoutes.get("/balances", async (c) => {
  const group = await groupForMember(c.env, c.req.param("id")!, c.get("user").id);
  return c.json({ balances: await balances(c.env, group.id) });
});

expenseRoutes.get("/activity", async (c) => {
  const group = await groupForMember(c.env, c.req.param("id")!, c.get("user").id);
  return c.json(await activityPage(c.env, group.id, c.req.query("before") || null, ACTIVITY_PAGE));
});

// Any member adds an expense, paid by any member and shared by any of them.
expenseRoutes.post("/expenses", async (c) => {
  const me = c.get("user");
  const group = await groupForMember(c.env, c.req.param("id")!, me.id);
  const e = parseNewExpense(await readJson(c.req.raw));
  const id = randomId();
  const at = now();
  // Everyone it names, and whoever adds it, must be in the group as it is added: checked in the
  // statement that adds it, so someone leaving at the same moment can't end up in it.
  const people = [...new Set([e.paidBy, ...e.participants, me.id])];
  const [added] = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO expenses (id, group_id, description, amount, paid_by, date, split_method, split_params,
         created_by, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM group_members WHERE group_id = ? AND user_id IN (SELECT value FROM json_each(?))) = ?
       RETURNING id`,
    ).bind(
      id,
      group.id,
      e.description,
      e.amount,
      e.paidBy,
      e.date,
      e.splitMethod,
      e.splitParams === null ? null : JSON.stringify(e.splitParams),
      me.id,
      at,
      group.id,
      JSON.stringify(people),
      people.length,
    ),
    c.env.DB.prepare(
      `INSERT INTO expense_shares (expense_id, user_id, amount)
       SELECT ?, key, value FROM json_each(?) WHERE EXISTS (SELECT 1 FROM expenses WHERE id = ?)`,
    ).bind(id, JSON.stringify(Object.fromEntries(e.shares)), id),
    c.env.DB.prepare(
      `INSERT INTO activity_log (id, group_id, actor_id, action, subject_id, data, created_at)
       SELECT ?, ?, ?, 'expense.added', ?, ?, ? WHERE EXISTS (SELECT 1 FROM expenses WHERE id = ?)`,
    ).bind(randomId(), group.id, me.id, id, JSON.stringify(snapshot(e)), at, id),
  ]);
  if (!added?.results.length) {
    await groupForMember(c.env, group.id, me.id); // the one adding it has left: 404
    throw notInGroup();
  }
  return c.json({ expense: await expenseById(c.env, group.id, id) });
});

/**
 * SQL that is true while expense ? of group ? is still at version ? and not deleted, and everyone
 * in the JSON list ? (? people) is in the group. Each statement of an edit or deletion checks it,
 * the last one being the change to the expense itself, so they all happen or none do.
 */
const UNCHANGED_SQL = `EXISTS (SELECT 1 FROM expenses WHERE id = ? AND group_id = ? AND version = ? AND deleted_at IS NULL)
  AND (SELECT COUNT(*) FROM group_members WHERE group_id = ? AND user_id IN (SELECT value FROM json_each(?))) = ?`;
const unchangedArgs = (groupId: string, id: string, version: number, people: string[]) => [
  id,
  groupId,
  version,
  groupId,
  JSON.stringify(people),
  people.length,
];

/**
 * Who must be in the group for `before` to become `after` (null: deleted): whoever does it, anyone
 * new to the expense, and anyone whose balance it changes. Someone who has left may stay in an
 * expense as they are, but can't be made to owe or be owed anything more: they could only leave
 * once the group was settled (src/worker/groups.ts), and can no longer settle up.
 */
function mustBeMembers(me: string, before: ExpenseSnapshot, after: ExpenseSnapshot | null): string[] {
  const was = netOf(before);
  const will = after ? netOf(after) : new Map<string, number>();
  const people = new Set([me]);
  for (const id of new Set([...was.keys(), ...will.keys()])) if (was.get(id) !== (will.get(id) ?? 0)) people.add(id);
  return [...people];
}

/** Why an edit or deletion checked by UNCHANGED_SQL did not happen. */
async function whyNot(
  env: Env,
  groupId: string,
  me: string,
  id: string,
  version: number,
  people: string[],
  before: ExpenseSnapshot,
): Promise<never> {
  await groupForMember(env, groupId, me); // the one making it has left: 404
  const row = await env.DB.prepare("SELECT version, deleted_at FROM expenses WHERE id = ? AND group_id = ?")
    .bind(id, groupId)
    .first<{ version: number; deleted_at: string | null }>();
  if (!row || row.deleted_at) throw expenseNotFound();
  if (row.version !== version) throw expenseChanged();
  const { results } = await env.DB.prepare(
    "SELECT user_id FROM group_members WHERE group_id = ? AND user_id IN (SELECT value FROM json_each(?))",
  )
    .bind(groupId, JSON.stringify(people))
    .all<{ user_id: string }>();
  const members = new Set(results.map((r) => r.user_id));
  const was = netOf(before);
  if (people.some((p) => !members.has(p) && was.has(p)))
    throw new HttpError(
      409,
      "former_member_involved",
      "This would change what someone who has left the group owes or is owed",
    );
  throw notInGroup();
}

function parseVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new HttpError(400, "invalid_version", "Say which version of the expense this changes");
  return value;
}

/** The expense as it is now, if it is still at `version`. */
async function currentExpense(env: Env, groupId: string, id: string, version: number) {
  const expense = await expenseById(env, groupId, id);
  if (!expense) throw expenseNotFound();
  if (expense.version !== version) throw expenseChanged();
  return expense;
}

// Any member edits an expense: the whole of it again, with the version they started from. If
// someone else saved in between, it is turned down (409 expense_changed) rather than overwriting.
expenseRoutes.post("/expenses/:expenseId", async (c) => {
  const me = c.get("user");
  const group = await groupForMember(c.env, c.req.param("id")!, me.id);
  const body = await readJson(c.req.raw);
  const e = parseNewExpense(body);
  const version = parseVersion(body.version);
  const id = c.req.param("expenseId");
  const current = await currentExpense(c.env, group.id, id, version);
  const before = snapshot(current);
  const after = snapshot(e);
  const change = changeOf(before, after);
  if (!change) return c.json({ expense: current });
  const people = mustBeMembers(me.id, before, after);
  const args = unchangedArgs(group.id, id, version, people);
  const at = now();
  const results = await c.env.DB.batch([
    // The shares again, if they changed.
    ...(change.after.shares
      ? [
          c.env.DB.prepare(`DELETE FROM expense_shares WHERE expense_id = ? AND ${UNCHANGED_SQL}`).bind(id, ...args),
          c.env.DB.prepare(
            `INSERT INTO expense_shares (expense_id, user_id, amount)
             SELECT ?, key, value FROM json_each(?) WHERE ${UNCHANGED_SQL}`,
          ).bind(id, JSON.stringify(after.shares), ...args),
        ]
      : []),
    c.env.DB.prepare(
      `INSERT INTO activity_log (id, group_id, actor_id, action, subject_id, data, created_at)
       SELECT ?, ?, ?, 'expense.edited', ?, ?, ? WHERE ${UNCHANGED_SQL}`,
    ).bind(randomId(), group.id, me.id, id, JSON.stringify(change), at, ...args),
    c.env.DB.prepare(
      `UPDATE expenses SET description = ?, amount = ?, paid_by = ?, date = ?, split_method = ?, split_params = ?,
         version = version + 1, updated_at = ?, updated_by = ?
       WHERE id = ? AND ${UNCHANGED_SQL} RETURNING id`,
    ).bind(
      e.description,
      e.amount,
      e.paidBy,
      e.date,
      e.splitMethod,
      e.splitParams === null ? null : JSON.stringify(e.splitParams),
      at,
      me.id,
      id,
      ...args,
    ),
  ]);
  if (!results.at(-1)?.results.length) await whyNot(c.env, group.id, me.id, id, version, people, before);
  return c.json({ expense: await expenseById(c.env, group.id, id) });
});

// Any member deletes an expense, as it was at `version`. It is kept, marked deleted, for the log.
expenseRoutes.post("/expenses/:expenseId/delete", async (c) => {
  const me = c.get("user");
  const group = await groupForMember(c.env, c.req.param("id")!, me.id);
  const version = parseVersion((await readJson(c.req.raw)).version);
  const id = c.req.param("expenseId");
  const before = snapshot(await currentExpense(c.env, group.id, id, version));
  const people = mustBeMembers(me.id, before, null);
  const args = unchangedArgs(group.id, id, version, people);
  const at = now();
  const [, deleted] = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO activity_log (id, group_id, actor_id, action, subject_id, data, created_at)
       SELECT ?, ?, ?, 'expense.deleted', ?, ?, ? WHERE ${UNCHANGED_SQL}`,
    ).bind(randomId(), group.id, me.id, id, JSON.stringify(before), at, ...args),
    c.env.DB.prepare(
      `UPDATE expenses SET deleted_at = ?, deleted_by = ? WHERE id = ? AND ${UNCHANGED_SQL} RETURNING id`,
    ).bind(at, me.id, id, ...args),
  ]);
  if (!deleted?.results.length) await whyNot(c.env, group.id, me.id, id, version, people, before);
  return c.body(null, 204);
});
