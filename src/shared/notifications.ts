/** Notifications as the API shows them (GET /api/notifications; src/worker/notifications.ts). */

import type { Currency } from "./currencies";
import { type Lang, type MessageKey, translate } from "./i18n";
import { formatAmount } from "./money";
import type { PaymentMethod } from "./settlements";

/** Notifications per page of the list. */
export const NOTIFICATIONS_PAGE = 20;

/** The unread count stops here; the bell shows "99+". */
export const UNREAD_MAX = 99;

/** A payment, as a notification about it keeps it. */
export interface PaymentNote {
  from: string;
  to: string;
  amount: number;
  method: PaymentMethod;
}

/**
 * What a notification says, by kind. Amounts are in the group currency's smallest unit; `share`
 * is the reader's own part of the expense (missing when they have none), `paidBy` a user id.
 */
export type NotificationData =
  | { kind: "expense.added"; data: { description: string; amount: number; paidBy: string; share?: number } }
  | {
      kind: "expense.edited";
      // The reader's share before and after, each missing when they had or have none.
      data: { description: string; shareBefore?: number; shareAfter?: number };
    }
  | { kind: "expense.deleted"; data: { description: string; amount: number } }
  // The payer says they paid the reader: confirm it, or say it never arrived.
  | { kind: "payment.requested"; data: PaymentNote }
  // The reader's payment was confirmed, said never to have arrived, or (to the payee) withdrawn.
  | { kind: "payment.confirmed" | "payment.declined" | "payment.withdrawn"; data: PaymentNote }
  // The reader was added to the group by someone in it.
  | { kind: "member.added"; data: null }
  // The admin approved the reader's sign-up, or turned it down. (Only approved users are told on
  // the site, so a rejection is only ever sent by email, from PR 9.)
  | { kind: "signup.approved" | "signup.rejected"; data: null };

export type NotificationKind = NotificationData["kind"];

export type AppNotification = {
  id: string;
  /** Who did it. */
  actorId: string | null;
  /** The group it happened in, as it is now; null for the sign-up. */
  group: { id: string; name: string; currency: Currency } | null;
  /** The expense or payment it is about. */
  subjectId: string | null;
  createdAt: string;
  read: boolean;
} & NotificationData;

export interface NotificationPage {
  notifications: AppNotification[];
  /** The name of everyone the notifications mention, by user id. */
  names: Record<string, string>;
  /** Pass as `?before=` for the next page; null on the last one. */
  next: string | null;
  /** Unread notifications in all, up to UNREAD_MAX + 1. */
  unread: number;
}

/** How someone wants to hear about things (GET/POST /api/notifications/settings). */
export interface NotificationSettings {
  /** Notifications under the bell, on this site. */
  inApp: boolean;
}

/**
 * What a notification says, in `lang`: the line itself and, for an expense, the reader's share.
 * The bell's list and push messages both use it. `name` gives a user id's name ("you" for the
 * reader); null for a kind with nothing to show (a rejection, or one from a newer version).
 */
export function notificationText(
  n: NotificationData & { actorId: string | null; group: { currency: Currency } | null },
  lang: Lang,
  name: (id: string | null | undefined) => string,
): { text: string; detail: string | null } | null {
  const t = (key: MessageKey, params?: Record<string, string | number>) => translate(lang, key, params);
  const money = (units: number | undefined) =>
    units === undefined ? "—" : n.group ? formatAmount(units, n.group.currency, lang) : String(units);
  const actor = name(n.actorId);
  switch (n.kind) {
    case "expense.added":
      return {
        // Said only when someone other than whoever added it paid.
        text: t(n.data.paidBy === n.actorId ? "notify.expense.added" : "notify.expense.addedPaidBy", {
          actor,
          description: n.data.description,
          amount: money(n.data.amount),
          payer: name(n.data.paidBy),
        }),
        detail: n.data.share === undefined ? null : t("notify.share", { share: money(n.data.share) }),
      };
    case "expense.edited":
      return {
        text: t("notify.expense.edited", { actor, description: n.data.description }),
        detail:
          n.data.shareBefore === n.data.shareAfter
            ? null
            : t("notify.shareChange", { before: money(n.data.shareBefore), after: money(n.data.shareAfter) }),
      };
    case "expense.deleted":
      return {
        text: t("notify.expense.deleted", { actor, description: n.data.description, amount: money(n.data.amount) }),
        detail: null,
      };
    case "payment.requested":
    case "payment.confirmed":
    case "payment.declined":
    case "payment.withdrawn":
      return { text: t(`notify.${n.kind}`, { actor, amount: money(n.data.amount) }), detail: null };
    case "member.added":
      return { text: t("notify.member.added", { actor }), detail: null };
    case "signup.approved":
      return { text: t("notify.signup.approved"), detail: null };
    default:
      // A rejection (only ever sent by email), or something a newer version of the site sends.
      return null;
  }
}
