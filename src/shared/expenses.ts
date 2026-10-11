import { MAX_AMOUNT } from "./money";

/** Expenses and balances, as the API shows them (src/worker/routes/expenses.ts). */

export const DESCRIPTION_MAX = 100;

/** Expenses per page of a group's list. */
export const EXPENSES_PAGE = 20;

/**
 * Ways to split an expense:
 * - equal: everyone taking part pays the same;
 * - exact: each person's amount is given, and they add up to the total;
 * - percent: each person's percentage is given, and they add up to 100%;
 * - shares: each person counts for a whole number of shares (2 pays twice what 1 does);
 * - adjust: everyone pays the same, except some pay a fixed amount more (or less) than the rest.
 */
export const SPLIT_METHODS = ["equal", "exact", "percent", "shares", "adjust"] as const;
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
  splitParams: SplitParams | null;
  /** Everyone sharing it, by user id; the amounts add up to `amount`. */
  shares: Share[];
  createdBy: string;
  createdAt: string;
}

/** What POST /api/groups/:id/expenses takes. */
export interface NewExpense {
  description: string;
  amount: number;
  paidBy: string;
  date: string;
  splitMethod: SplitMethod;
  /** Everyone sharing it, by user id. */
  participants: string[];
  /** The split as entered, by user id; see `SplitParams`. Left out (or null) for an equal split. */
  splitParams?: SplitParams | null;
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

/**
 * What a split takes beyond who shares it, by user id, as entered:
 * - exact: each person's amount, in smallest units (≥ 1);
 * - percent: each person's percentage in hundredths of a percent (3333 is 33.33%; ≥ 1);
 * - shares: each person's number of shares (1 to MAX_SHARES);
 * - adjust: how much more (or, below 0, less) than the others a person pays, in smallest units;
 *   only for those it applies to, never 0.
 * For exact, percent and shares the keys are exactly the people sharing it; for adjust, some of them.
 */
export type SplitParams = Record<string, number>;

/** 100%, in the hundredths of a percent that percentage splits are given in. */
export const FULL_PERCENT = 10_000;

/** The most shares one person may count for: plenty for a split, small enough to stay exact. */
export const MAX_SHARES = 100;

/** Why a split doesn't work; the API reports the code (error.<code> in src/shared/i18n.ts). */
export type SplitErrorCode =
  | "invalid_split"
  | "split_exact_total"
  | "split_percent_total"
  | "split_adjust_too_large"
  | "split_adjust_negative";

export class SplitError extends Error {
  constructor(public code: SplitErrorCode) {
    super(code);
  }
}

const isWhole = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;

/**
 * Each person's share of `amount` (smallest units) split by `method`; throws a SplitError when the
 * split doesn't add up or `params` don't fit the method. Shared by the form, which shows the shares
 * as they are typed, and the server, which works them out again for itself. `participants` must be
 * distinct, non-empty ids; whether they are in the group is up to the caller.
 */
export function splitShares(
  method: SplitMethod,
  amount: number,
  participants: readonly string[],
  params: SplitParams | null | undefined,
): Map<string, number> {
  const entries = params == null ? null : Object.entries(params);
  if (method === "equal") {
    if (entries?.length) throw new SplitError("invalid_split");
    return splitEqual(amount, participants);
  }
  if (!entries) throw new SplitError("invalid_split");
  const taking = new Set(participants);
  if (method === "adjust") {
    if (!entries.every(([id, v]) => taking.has(id) && v !== 0 && isWhole(v, -MAX_AMOUNT, MAX_AMOUNT)))
      throw new SplitError("invalid_split");
    const rest = amount - entries.reduce((a, [, v]) => a + v, 0);
    if (rest < 0) throw new SplitError("split_adjust_too_large");
    // Only reachable with absurdly large reductions; keeps the sums below exact-integer limits.
    if (rest > MAX_AMOUNT) throw new SplitError("invalid_split");
    const shares = splitEqual(rest, participants);
    for (const [id, v] of entries) shares.set(id, shares.get(id)! + v);
    if ([...shares.values()].some((v) => v < 0)) throw new SplitError("split_adjust_negative");
    return shares;
  }
  // exact, percent, shares: one value for each person taking part, and no one else.
  const max = method === "exact" ? MAX_AMOUNT : method === "percent" ? FULL_PERCENT : MAX_SHARES;
  if (entries.length !== taking.size || !entries.every(([id, v]) => taking.has(id) && isWhole(v, 1, max)))
    throw new SplitError("invalid_split");
  const ids = entries.map(([id]) => id);
  const values = entries.map(([, v]) => v);
  const total = values.reduce((a, b) => a + b, 0);
  if (method === "exact") {
    if (total !== amount) throw new SplitError("split_exact_total");
    return new Map(entries);
  }
  if (method === "percent" && total !== FULL_PERCENT) throw new SplitError("split_percent_total");
  return spread(amount, values, ids);
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
