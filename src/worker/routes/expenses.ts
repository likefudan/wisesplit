import { Hono } from "hono";
import { EXPENSES_PAGE } from "../../shared/expenses";
import { simplifyDebts } from "../../shared/settlements";
import type { AppEnv } from "../auth";
import { balances, expenseById, expensePage, parseNewExpense } from "../expenses";
import { groupForMember } from "../groups";
import { HttpError, now, readJson } from "../http";
import { randomId } from "../lib/crypto";

/** A group's expenses, balances and suggested payments, under /api/groups/:id (behind requireApproved there). */
export const expenseRoutes = new Hono<AppEnv>();

expenseRoutes.get("/expenses", async (c) => {
  const group = await groupForMember(c.env, c.req.param("id")!, c.get("user").id);
  return c.json(await expensePage(c.env, group.id, c.req.query("before") || null, EXPENSES_PAGE));
});

expenseRoutes.get("/balances", async (c) => {
  const group = await groupForMember(c.env, c.req.param("id")!, c.get("user").id);
  const list = await balances(c.env, group.id);
  return c.json({ balances: list, suggestions: simplifyDebts(list) });
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
       SELECT ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?
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
    ).bind(
      randomId(),
      group.id,
      me.id,
      id,
      JSON.stringify({
        description: e.description,
        amount: e.amount,
        paidBy: e.paidBy,
        date: e.date,
        splitMethod: e.splitMethod,
        shares: Object.fromEntries(e.shares),
      }),
      at,
      id,
    ),
  ]);
  if (!added?.results.length) {
    await groupForMember(c.env, group.id, me.id); // the one adding it has left: 404
    throw new HttpError(400, "not_in_group", "Everyone in an expense must be in the group");
  }
  return c.json({ expense: await expenseById(c.env, group.id, id) });
});
