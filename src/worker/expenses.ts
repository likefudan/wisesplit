import {
  type Balance,
  DESCRIPTION_MAX,
  type Expense,
  type NewExpense,
  type Share,
  SPLIT_METHODS,
  isSplitMethod,
  splitEqual,
} from "../shared/expenses";
import { MAX_AMOUNT } from "../shared/money";
import type { Env } from "./env";
import { LEDGER_SQL, ledgerArgs } from "./groups";
import { HttpError } from "./http";
import { tidyName } from "./users";

/** More than any group has; stops a request from making the server split among millions. */
const MAX_PARTICIPANTS = 1000;

/** An expense's description: tidied like a name, then 1 to 100 characters. */
export function parseDescription(value: unknown): string {
  const text = tidyName(value);
  if (!text || [...text].length > DESCRIPTION_MAX)
    throw new HttpError(400, "invalid_description", `Description must be 1 to ${DESCRIPTION_MAX} characters`);
  return text;
}

/** A whole number of the currency's smallest unit, from 1 to MAX_AMOUNT. */
export function parseAmountUnits(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_AMOUNT)
    throw new HttpError(
      400,
      "invalid_amount",
      `Amount must be a whole number of the smallest unit, 1 to ${MAX_AMOUNT}`,
    );
  return value;
}

/** A calendar day, YYYY-MM-DD, from 1970 to 2100. */
export function parseDay(value: unknown): string {
  const m = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  const [y, mo, d] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (!m || y < 1970 || y > 2100 || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d)
    throw new HttpError(400, "invalid_date", "Date must be a day written YYYY-MM-DD");
  return value as string;
}

/**
 * The expense in a request body, checked on its own; whether the people in it are in the group is
 * checked as it is added. Each person's share is worked out here, from the split.
 */
export function parseNewExpense(body: Record<string, unknown>): NewExpense & { shares: Map<string, number> } {
  const description = parseDescription(body.description);
  const amount = parseAmountUnits(body.amount);
  const paidBy = typeof body.paidBy === "string" && body.paidBy ? body.paidBy : null;
  if (!paidBy) throw new HttpError(400, "invalid_payer", "Pick who paid");
  const date = parseDay(body.date);
  if (!isSplitMethod(body.splitMethod))
    throw new HttpError(400, "invalid_split_method", `Split method must be one of ${SPLIT_METHODS.join(", ")}`);
  const participants = body.participants;
  if (
    !Array.isArray(participants) ||
    participants.length === 0 ||
    participants.length > MAX_PARTICIPANTS ||
    !participants.every((p) => typeof p === "string" && p) ||
    new Set(participants).size !== participants.length
  )
    throw new HttpError(400, "invalid_participants", "Pick who shares the expense, each person once");
  return {
    description,
    amount,
    paidBy,
    date,
    splitMethod: body.splitMethod,
    participants,
    shares: splitEqual(amount, participants),
  };
}

interface ExpenseRow {
  id: string;
  description: string;
  amount: number;
  paid_by: string;
  paid_by_name: string;
  date: string;
  split_method: Expense["splitMethod"];
  created_by: string;
  created_at: string;
  shares: string;
}

const EXPENSE_SELECT = `SELECT e.id, e.description, e.amount, e.paid_by, p.name AS paid_by_name, e.date,
    e.split_method, e.created_by, e.created_at,
    (SELECT json_group_array(json_object('userId', s.user_id, 'name', u.name, 'amount', s.amount))
      FROM expense_shares s JOIN users u ON u.id = s.user_id WHERE s.expense_id = e.id) AS shares
  FROM expenses e JOIN users p ON p.id = e.paid_by`;

const ORDER = "ORDER BY e.date DESC, e.created_at DESC, e.id DESC";

const toExpense = (r: ExpenseRow): Expense => ({
  id: r.id,
  description: r.description,
  amount: r.amount,
  paidBy: r.paid_by,
  paidByName: r.paid_by_name,
  date: r.date,
  splitMethod: r.split_method,
  shares: (JSON.parse(r.shares) as Share[]).sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0)),
  createdBy: r.created_by,
  createdAt: r.created_at,
});

export async function expenseById(env: Env, groupId: string, id: string): Promise<Expense | null> {
  const row = await env.DB.prepare(`${EXPENSE_SELECT} WHERE e.group_id = ? AND e.id = ?`)
    .bind(groupId, id)
    .first<ExpenseRow>();
  return row ? toExpense(row) : null;
}

/**
 * One page of a group's expenses, newest day first (and, within a day, the last added first).
 * `before` is the id of the last expense on the previous page.
 */
export async function expensePage(
  env: Env,
  groupId: string,
  before: string | null,
  size: number,
): Promise<{ expenses: Expense[]; next: string | null }> {
  let statement: D1PreparedStatement;
  if (before) {
    const after = await env.DB.prepare("SELECT date, created_at, id FROM expenses WHERE group_id = ? AND id = ?")
      .bind(groupId, before)
      .first<{ date: string; created_at: string; id: string }>();
    if (!after) throw new HttpError(400, "invalid_cursor", "No such expense to list from");
    statement = env.DB.prepare(
      `${EXPENSE_SELECT} WHERE e.group_id = ? AND (e.date, e.created_at, e.id) < (?, ?, ?) ${ORDER} LIMIT ?`,
    ).bind(groupId, after.date, after.created_at, after.id, size + 1);
  } else {
    statement = env.DB.prepare(`${EXPENSE_SELECT} WHERE e.group_id = ? ${ORDER} LIMIT ?`).bind(groupId, size + 1);
  }
  const { results } = await statement.all<ExpenseRow>();
  const expenses = results.slice(0, size).map(toExpense);
  return { expenses, next: results.length > size ? expenses[expenses.length - 1]!.id : null };
}

/**
 * Everyone's balance in the group: what they paid minus their shares, plus the confirmed payments
 * they made minus those they received. Lists every member (in the order they joined), and anyone
 * who has left with a balance that is not 0 (which leaving rules out, but the numbers must add up
 * whatever happened).
 */
export async function balances(env: Env, groupId: string): Promise<Balance[]> {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.name, SUM(b.net) AS net, MIN(b.joined_at) AS joined_at FROM (
       SELECT user_id, net, NULL AS joined_at FROM (${LEDGER_SQL})
       UNION ALL
       SELECT user_id, 0, joined_at FROM group_members WHERE group_id = ?
     ) b JOIN users u ON u.id = b.user_id
     GROUP BY u.id
     HAVING MIN(b.joined_at) IS NOT NULL OR SUM(b.net) != 0
     ORDER BY MIN(b.joined_at) IS NULL, MIN(b.joined_at), u.id`,
  )
    .bind(...ledgerArgs(groupId), groupId)
    .all<{ id: string; name: string; net: number }>();
  return results.map((r) => ({ userId: r.id, name: r.name, net: r.net }));
}
