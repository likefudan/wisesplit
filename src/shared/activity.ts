/** A group's activity log, as the API shows it (GET /api/groups/:id/activity). */

import type { SplitMethod, SplitParams } from "./expenses";
import type { PaymentMethod, PaymentStatus } from "./settlements";

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

/** A payment as the log keeps it (src/worker/routes/settlements.ts). */
export interface PaymentSnapshot {
  from: string;
  to: string;
  amount: number;
  method: PaymentMethod;
}

/**
 * One thing that happened in a group. `actorId` did it; `subjectId` is what it is about (the
 * expense, the payment, or the member who joined, left or was removed).
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
  // Recorded: pending, or confirmed at once when the other side is deactivated.
  | { action: "settlement.added"; data: PaymentSnapshot & { status: PaymentStatus } }
  | { action: "settlement.confirmed"; data: PaymentSnapshot }
  | { action: "settlement.declined"; data: PaymentSnapshot }
  | { action: "settlement.withdrawn"; data: PaymentSnapshot }
  // A receipt photo of the expense `subjectId` (src/worker/routes/receipts.ts).
  | { action: "receipt.added" | "receipt.replaced" | "receipt.removed"; data: { description: string } }
);

export interface ActivityPage {
  entries: ActivityEntry[];
  /** The name of everyone the entries mention, by user id. */
  names: Record<string, string>;
  /** Pass as `?before=` for the next page; null on the last one. */
  next: string | null;
}
