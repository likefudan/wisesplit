/** Expenses and balances, as the API shows them (src/worker/routes/expenses.ts). */

export const DESCRIPTION_MAX = 100;

/** Expenses per page of a group's list. */
export const EXPENSES_PAGE = 20;

/**
 * Ways to split an expense. Only "equal" exists so far; the others come with their forms (PR 4),
 * and the database already accepts them so that needs no migration.
 */
export const SPLIT_METHODS = ["equal"] as const;
export type SplitMethod = (typeof SPLIT_METHODS)[number];

export const isSplitMethod = (v: unknown): v is SplitMethod =>
  typeof v === "string" && (SPLIT_METHODS as readonly string[]).includes(v);

/** One person's part of an expense, in the group currency's smallest unit. */
export interface Share {
  userId: string;
  name: string;
  amount: number;
}

export interface Expense {
  id: string;
  description: string;
  /** In the group currency's smallest unit. */
  amount: number;
  paidBy: string;
  paidByName: string;
  /** The day it happened, YYYY-MM-DD, as the person entering it chose. */
  date: string;
  splitMethod: SplitMethod;
  /** Everyone sharing it, by user id; the amounts add up to `amount`. */
  shares: Share[];
  createdBy: string;
  createdAt: string;
  /** The receipt photo's version (see `receiptPath` in receipts.ts), or null when there is none. */
  receipt: string | null;
}

/** What POST /api/groups/:id/expenses takes. */
export interface NewExpense {
  description: string;
  amount: number;
  paidBy: string;
  date: string;
  splitMethod: SplitMethod;
  participants: string[];
}

export interface ExpensePage {
  expenses: Expense[];
  /** Pass as `?before=` for the next page; null on the last one. */
  next: string | null;
}

/**
 * Where someone stands in a group: what they paid minus their shares. Positive means the others
 * owe them; negative, they owe; 0, settled up.
 */
export interface Balance {
  userId: string;
  name: string;
  net: number;
}

/** Splits `amount` equally among `userIds`; see `spread`. */
export const splitEqual = (amount: number, userIds: readonly string[]) =>
  spread(
    amount,
    userIds.map(() => 1),
    userIds,
  );

/**
 * Splits `amount` (whole smallest units) in proportion to `weights`, so the parts always add up to
 * `amount`: each gets the rounded-down part, and the units left over go one each to the largest
 * remainders, ties to the smallest user id. With equal weights that is "the first few by user id
 * get one more cent". The fixed order means the same expense always splits the same way.
 */
export function spread(amount: number, weights: readonly number[], userIds: readonly string[]): Map<string, number> {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError("amount must be a whole number ≥ 0");
  if (weights.length !== userIds.length || userIds.length === 0) throw new RangeError("one weight per person");
  if (new Set(userIds).size !== userIds.length) throw new RangeError("each person once");
  const total = weights.reduce((a, b) => a + b, 0);
  if (!weights.every((w) => Number.isSafeInteger(w) && w >= 0) || total <= 0 || !Number.isSafeInteger(total * amount))
    throw new RangeError("weights must be whole numbers ≥ 0, not all 0");
  const parts = userIds.map((id, i) => {
    const exact = amount * weights[i]!;
    return { id, units: Math.floor(exact / total), rest: exact % total };
  });
  let left = amount - parts.reduce((a, p) => a + p.units, 0);
  const order = [...parts].sort((a, b) => b.rest - a.rest || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const p of order) {
    if (left === 0) break;
    p.units++;
    left--;
  }
  return new Map(parts.map((p) => [p.id, p.units]));
}
