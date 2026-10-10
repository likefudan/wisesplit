import { Hono } from "hono";
import { isPaymentMethod, MAX_PENDING_PAYMENTS } from "../../shared/settlements";
import type { AppEnv } from "../auth";
import { parseAmountUnits } from "../expenses";
import { groupForMember, isMember } from "../groups";
import { HttpError, now, readJson, str } from "../http";
import { randomId } from "../lib/crypto";
import { paymentById, paymentList } from "../settlements";

/**
 * Payments that settle up a group, under /api/groups/:id (behind requireApproved there). The payer
 * records a payment; it counts once the payee confirms it. With someone deactivated (who can't
 * sign in to confirm), the other side's word is enough: a payment to them counts as soon as the
 * payer records it, and the payee may record one received from them.
 */
export const settlementRoutes = new Hono<AppEnv>();

const notYours = () =>
  new HttpError(403, "not_your_payment", "Only the payer or the payee can do this to a payment, as it now stands");

settlementRoutes.get("/payments", async (c) => {
  const group = await groupForMember(c.env, c.req.param("id")!, c.get("user").id);
  return c.json(await paymentList(c.env, group.id));
});

settlementRoutes.post("/payments", async (c) => {
  const me = c.get("user");
  const group = await groupForMember(c.env, c.req.param("id")!, me.id);
  const body = await readJson(c.req.raw);
  const from = str(body.from);
  const to = str(body.to);
  if (!from || !to || from === to)
    throw new HttpError(400, "invalid_payee", "Pick who paid and who was paid: two people");
  const amount = parseAmountUnits(body.amount);
  if (!isPaymentMethod(body.method)) throw new HttpError(400, "invalid_method", "Method must be venmo or other");
  if (body.method === "venmo" && group.currency !== "USD")
    throw new HttpError(400, "venmo_usd_only", "Venmo is only for US-dollar groups");
  // Payers record what they paid. The payee records it only when the payer is deactivated.
  if (from !== me.id && to !== me.id) throw notYours();
  const other = from === me.id ? to : from;
  const id = randomId();
  const at = now();
  const [added] = await c.env.DB.batch([
    // Counts at once when the other side is deactivated. Both must be in the group as it is added,
    // so someone leaving at the same moment can't end up in it.
    c.env.DB.prepare(
      `INSERT INTO settlements (id, group_id, from_user, to_user, amount, method, status, created_by, created_at,
         decided_at, decided_by)
       SELECT ?, ?, ?, ?, ?, ?, st, ?, ?, CASE WHEN st = 'confirmed' THEN ? END, CASE WHEN st = 'confirmed' THEN ? END
       FROM (SELECT CASE WHEN (SELECT status FROM users WHERE id = ?) = 'deactivated'
         THEN 'confirmed' ELSE 'pending' END AS st)
       WHERE (SELECT COUNT(*) FROM group_members WHERE group_id = ? AND user_id IN (?, ?)) = 2
         AND (? = ? OR st = 'confirmed')
         AND (st = 'confirmed'
           OR (SELECT COUNT(*) FROM settlements WHERE group_id = ? AND from_user = ? AND status = 'pending') < ?)
       RETURNING id`,
    ).bind(
      id,
      group.id,
      from,
      to,
      amount,
      body.method,
      me.id,
      at,
      at,
      me.id,
      other,
      group.id,
      from,
      to,
      from,
      me.id,
      group.id,
      from,
      MAX_PENDING_PAYMENTS,
    ),
    c.env.DB.prepare(
      `INSERT INTO activity_log (id, group_id, actor_id, action, subject_id, data, created_at)
       SELECT ?, ?, ?, 'settlement.added', id, json_object('from', from_user, 'to', to_user, 'amount', amount,
         'method', method, 'status', status), ?
       FROM settlements WHERE id = ?`,
    ).bind(randomId(), group.id, me.id, at, id),
  ]);
  if (!added?.results.length) {
    await groupForMember(c.env, group.id, me.id); // the one recording it has left: 404
    if (!(await isMember(c.env, group.id, other)))
      throw new HttpError(400, "not_in_group", "Both people in a payment must be in the group");
    if (from !== me.id && to === me.id) {
      const payer = await c.env.DB.prepare("SELECT status FROM users WHERE id = ?")
        .bind(from)
        .first<{ status: string }>();
      if (payer?.status !== "deactivated") throw notYours();
    }
    const open = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM settlements WHERE group_id = ? AND from_user = ? AND status = 'pending'",
    )
      .bind(group.id, from)
      .first<{ n: number }>();
    if ((open?.n ?? 0) >= MAX_PENDING_PAYMENTS)
      throw new HttpError(
        429,
        "too_many_pending",
        `At most ${MAX_PENDING_PAYMENTS} payments by one person may await confirmation`,
      );
    // Something changed meanwhile (someone left, or was deactivated or reactivated).
    throw new HttpError(409, "not_in_group", "Someone in this payment has changed; reload and try again");
  }
  return c.json({ payment: await paymentById(c.env, group.id, id) });
});

/**
 * What may be done to a pending payment, the state it leads to, and who may do it: SQL on the
 * settlements row for user `me`, with its arguments. The payee confirms or declines; the payer
 * may confirm it themselves only when the payee has been deactivated since. The payer withdraws.
 */
const DECISIONS: Record<string, { status: string; who: (me: string) => [string, string[]] }> = {
  confirm: {
    status: "confirmed",
    who: (me) => [
      "(to_user = ? OR (from_user = ? AND (SELECT status FROM users WHERE id = to_user) = 'deactivated'))",
      [me, me],
    ],
  },
  decline: { status: "declined", who: (me) => ["to_user = ?", [me]] },
  withdraw: { status: "withdrawn", who: (me) => ["from_user = ?", [me]] },
};

for (const [action, rule] of Object.entries(DECISIONS)) {
  settlementRoutes.post(`/payments/:paymentId/${action}`, async (c) => {
    const me = c.get("user");
    const group = await groupForMember(c.env, c.req.param("id")!, me.id);
    const paymentId = c.req.param("paymentId");
    const at = now();
    // The row as it must be for this, with the one deciding still in the group. The log entry
    // is written first, under the same condition, so the two happen together or not at all.
    const [who, whoArgs] = rule.who(me.id);
    const where = `id = ? AND group_id = ? AND status = 'pending' AND ${who}
      AND EXISTS (SELECT 1 FROM group_members WHERE group_id = settlements.group_id AND user_id = ?)`;
    const args = [paymentId, group.id, ...whoArgs, me.id];
    const [, updated] = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO activity_log (id, group_id, actor_id, action, subject_id, data, created_at)
         SELECT ?, group_id, ?, ?, id, json_object('from', from_user, 'to', to_user, 'amount', amount,
           'method', method), ?
         FROM settlements WHERE ${where}`,
      ).bind(randomId(), me.id, `settlement.${rule.status}`, at, ...args),
      c.env.DB.prepare(
        `UPDATE settlements SET status = ?, decided_at = ?, decided_by = ? WHERE ${where} RETURNING id`,
      ).bind(rule.status, at, me.id, ...args),
    ]);
    if (!updated?.results.length) {
      await groupForMember(c.env, group.id, me.id);
      const payment = await paymentById(c.env, group.id, paymentId);
      if (!payment) throw new HttpError(404, "payment_not_found", "No such payment in this group");
      if (payment.status !== "pending")
        throw new HttpError(409, "payment_not_pending", "This payment was already confirmed, declined or withdrawn");
      throw notYours();
    }
    return c.json({ payment: await paymentById(c.env, group.id, paymentId) });
  });
}
