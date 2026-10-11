/** A group's activity log, as the API shows it (GET /api/groups/:id/activity). */

import type { SplitMethod, SplitParams } from "./expenses";

/** Log entries per page of a group's activity. */
export const ACTIVITY_PAGE = 20;

/**
 * An expense as the log keeps it: what it was when added or deleted. Shares are by user id, in the
 * group currency's smallest unit.
 */
export interface ExpenseSnapshot {
  description: string;
  amount: number;
  paidBy: string;
  date: string;
  splitMethod: SplitMethod;
  /** The split as entered (src/shared/expenses.ts); null for an equal split, missing before PR 4. */
  splitParams?: SplitParams | null;
  shares: Record<string, number>;
}

/** What an edit changed: only the fields that did, before and after. */
export interface ExpenseChange {
  /** The description after the edit, to name the expense by. */
  description: string;
  before: Partial<ExpenseSnapshot>;
  after: Partial<ExpenseSnapshot>;
}

/**
 * One thing that happened in a group. `actorId` did it; `subjectId` is what it is about (the
 * expense, or the member who joined, left or was removed).
 */
export type ActivityEntry = {
  id: string;
  actorId: string;
  subjectId: string | null;
  createdAt: string;
} & (
  | { action: "group.created"; data: { name: string; currency: string } }
  | { action: "expense.added"; data: ExpenseSnapshot }
  | { action: "expense.edited"; data: ExpenseChange }
  | { action: "expense.deleted"; data: ExpenseSnapshot }
  // Added by someone else, by email.
  | { action: "member.added"; data: null }
  // Joined with an invite link someone made.
  | { action: "member.joined"; data: { invitedBy: string } }
  | { action: "member.left"; data: null }
  // Taken out by the owner.
  | { action: "member.removed"; data: null }
);

export interface ActivityPage {
  entries: ActivityEntry[];
  /** The name of everyone the entries mention, by user id. */
  names: Record<string, string>;
  /** Pass as `?before=` for the next page; null on the last one. */
  next: string | null;
}
