import { type Payment, type PaymentList, RECENT_PAYMENTS } from "../shared/settlements";
import type { Env } from "./env";

interface PaymentRow {
  id: string;
  from_user: string;
  from_name: string;
  to_user: string;
  to_name: string;
  amount: number;
  method: Payment["method"];
  status: Payment["status"];
  created_by: string;
  created_at: string;
  decided_at: string | null;
}

const PAYMENT_SELECT = `SELECT s.id, s.from_user, f.name AS from_name, s.to_user, t.name AS to_name, s.amount, s.method,
    s.status, s.created_by, s.created_at, s.decided_at
  FROM settlements s JOIN users f ON f.id = s.from_user JOIN users t ON t.id = s.to_user`;

const toPayment = (r: PaymentRow): Payment => ({
  id: r.id,
  fromId: r.from_user,
  fromName: r.from_name,
  toId: r.to_user,
  toName: r.to_name,
  amount: r.amount,
  method: r.method,
  status: r.status,
  createdBy: r.created_by,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
});

export async function paymentById(env: Env, groupId: string, id: string): Promise<Payment | null> {
  const row = await env.DB.prepare(`${PAYMENT_SELECT} WHERE s.group_id = ? AND s.id = ?`)
    .bind(groupId, id)
    .first<PaymentRow>();
  return row ? toPayment(row) : null;
}

/**
 * The group's payments awaiting confirmation (newest first), and the latest ones that were
 * confirmed, declined or withdrawn.
 */
export async function paymentList(env: Env, groupId: string): Promise<PaymentList> {
  const [pending, recent] = await env.DB.batch<PaymentRow>([
    env.DB.prepare(
      `${PAYMENT_SELECT} WHERE s.group_id = ? AND s.status = 'pending' ORDER BY s.created_at DESC, s.id`,
    ).bind(groupId),
    env.DB.prepare(
      `${PAYMENT_SELECT} WHERE s.group_id = ? AND s.status <> 'pending' ORDER BY s.decided_at DESC, s.id LIMIT ?`,
    ).bind(groupId, RECENT_PAYMENTS),
  ]);
  return { pending: pending!.results.map(toPayment), recent: recent!.results.map(toPayment) };
}

/** What each payer has sent each payee in the group that awaits confirmation, keyed "from to". */
export async function pendingByPair(env: Env, groupId: string): Promise<Map<string, number>> {
  const { results } = await env.DB.prepare(
    `SELECT from_user, to_user, SUM(amount) AS amount FROM settlements
     WHERE group_id = ? AND status = 'pending' GROUP BY from_user, to_user`,
  )
    .bind(groupId)
    .all<{ from_user: string; to_user: string; amount: number }>();
  return new Map(results.map((r) => [`${r.from_user} ${r.to_user}`, r.amount]));
}
