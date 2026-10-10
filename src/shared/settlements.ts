import type { Balance } from "./expenses";
import { amountInput } from "./money";

/** Payments that settle up a group, as the API shows them (src/worker/routes/settlements.ts). */

/** How a payment was made. Venmo only in US-dollar groups, since Venmo only moves dollars. */
export const PAYMENT_METHODS = ["venmo", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const isPaymentMethod = (v: unknown): v is PaymentMethod =>
  typeof v === "string" && (PAYMENT_METHODS as readonly string[]).includes(v);

/**
 * Where a payment stands. Pending: the payer says they paid, the payee hasn't confirmed. Only
 * confirmed payments count toward balances; declined (by the payee) and withdrawn (by the payer)
 * ones count for nothing and stay listed for the record.
 */
export type PaymentStatus = "pending" | "confirmed" | "declined" | "withdrawn";

/**
 * Payments one person may have awaiting confirmation in a group at a time. (error.too_many_pending
 * in i18n.ts names the number.)
 */
export const MAX_PENDING_PAYMENTS = 20;

/** Finished payments listed on the group page, newest first. */
export const RECENT_PAYMENTS = 20;

export interface Payment {
  id: string;
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  /** In the group currency's smallest unit. */
  amount: number;
  method: PaymentMethod;
  status: PaymentStatus;
  createdBy: string;
  createdAt: string;
  /** When it was confirmed, declined or withdrawn; null while pending. */
  decidedAt: string | null;
}

/** GET /api/groups/:id/payments. */
export interface PaymentList {
  pending: Payment[];
  recent: Payment[];
}

/** One payment that, with the others suggested, settles the whole group. */
export interface Transfer {
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  amount: number;
}

/** A suggested payment, with what its payer has already sent its payee that awaits confirmation. */
export interface Suggestion extends Transfer {
  pending: number;
}

const byId = (a: { userId: string }, b: { userId: string }) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);

/**
 * The payments that settle everyone up, few of them: the one who owes most pays the one owed
 * most as much as they can, and so on until no one owes anything. A chain (A owes B, B owes C)
 * becomes one payment (A pays C), and there are never more payments than people with a balance,
 * less one. Ties go to the smaller user id, so the same balances always give the same
 * suggestions. Balances must add up to 0, which they do: every expense and payment adds as much
 * as it takes away.
 */
export function simplifyDebts(balances: readonly Balance[]): Transfer[] {
  if (balances.reduce((sum, b) => sum + b.net, 0) !== 0) throw new RangeError("balances must add up to 0");
  const most = (a: { left: number; userId: string }, b: { left: number; userId: string }) =>
    b.left - a.left || byId(a, b);
  const debtors = balances.filter((b) => b.net < 0).map((b) => ({ ...b, left: -b.net }));
  const creditors = balances.filter((b) => b.net > 0).map((b) => ({ ...b, left: b.net }));
  const transfers: Transfer[] = [];
  while (debtors.length > 0 && creditors.length > 0) {
    debtors.sort(most);
    creditors.sort(most);
    const from = debtors[0]!;
    const to = creditors[0]!;
    const amount = Math.min(from.left, to.left);
    transfers.push({ fromId: from.userId, fromName: from.name, toId: to.userId, toName: to.name, amount });
    from.left -= amount;
    to.left -= amount;
    if (from.left === 0) debtors.shift();
    if (to.left === 0) creditors.shift();
  }
  return transfers;
}

/** The note a Venmo payment is prefilled with. */
export const venmoNote = (groupName: string) => `wisesplit: ${groupName}`;

/**
 * A link that opens Venmo (the app on a phone, the website elsewhere) ready to pay `username`
 * `cents` US cents with `note`. The payer still checks it and presses Pay themselves.
 */
export function venmoLink(username: string, cents: number, note: string): string {
  const params = {
    txn: "pay",
    audience: "private",
    recipients: username,
    amount: amountInput(cents, "USD"),
    note,
  };
  // Spaces as %20, not "+", which Venmo would show in the note as it is.
  const query = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return `https://venmo.com/?${query}`;
}
