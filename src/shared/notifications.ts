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
  // the site, so a rejection is only ever sent by email.)
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
  /** The same notifications by email, to the user's Google address. */
  email: boolean;
}

/** What a notification says in `lang`: its line, and a second one with the reader's share, if any. */
export interface NotificationText {
  text: string;
  detail: string | null;
}

/**
 * What `n` says to its reader (`readerId`) in `lang`, for the list under the bell and for emails.
 * `names` has the name of everyone it mentions, by user id; amounts are in `currency`, the group's.
 * Null for a kind this version has no words for.
 */
export function notificationText(
  n: Pick<AppNotification, "kind" | "data" | "actorId">,
  lang: Lang,
  readerId: string,
  names: Record<string, string>,
  currency: Currency | null,
): NotificationText | null {
  const t = (key: MessageKey, params?: Record<string, string>) => translate(lang, key, params);
  const name = (id: string | null | undefined) =>
    id === readerId ? t("notifications.you") : (id && names[id]) || t("activity.someone");
  const money = (units: number | undefined) =>
    units === undefined ? "—" : currency ? formatAmount(units, currency, lang) : String(units);
  const actor = name(n.actorId);
  const note = n as NotificationData;
  switch (note.kind) {
    case "expense.added":
      return {
        // Said only when someone other than whoever added it paid.
        text: t(note.data.paidBy === n.actorId ? "notify.expense.added" : "notify.expense.addedPaidBy", {
          actor,
          description: note.data.description,
          amount: money(note.data.amount),
          payer: name(note.data.paidBy),
        }),
        detail: note.data.share === undefined ? null : t("notify.share", { share: money(note.data.share) }),
      };
    case "expense.edited":
      return {
        text: t("notify.expense.edited", { actor, description: note.data.description }),
        detail:
          note.data.shareBefore === note.data.shareAfter
            ? null
            : t("notify.shareChange", { before: money(note.data.shareBefore), after: money(note.data.shareAfter) }),
      };
    case "expense.deleted":
      return {
        text: t("notify.expense.deleted", {
          actor,
          description: note.data.description,
          amount: money(note.data.amount),
        }),
        detail: null,
      };
    case "payment.requested":
    case "payment.confirmed":
    case "payment.declined":
    case "payment.withdrawn":
      return { text: t(`notify.${note.kind}`, { actor, amount: money(note.data.amount) }), detail: null };
    case "member.added":
      return { text: t("notify.member.added", { actor }), detail: null };
    case "signup.approved":
    case "signup.rejected":
      return { text: t(`notify.${note.kind}`), detail: null };
    default:
      // Something a newer version of the site sends.
      return null;
  }
}
