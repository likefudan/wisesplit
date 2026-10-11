import { waitUntil } from "cloudflare:workers";
import type { ExpenseSnapshot } from "../shared/activity";
import type { Currency } from "../shared/currencies";
import {
  type AppNotification,
  type NotificationData,
  type NotificationPage,
  type NotificationSettings,
  type PaymentNote,
  UNREAD_MAX,
} from "../shared/notifications";
import type { Env } from "./env";
import { HttpError, now } from "./http";
import { randomId } from "./lib/crypto";
import { pushNotes } from "./push";

/**
 * Something that happened that people should hear about, as the route that did it describes it.
 * `notify` works out who is told and what each of them reads.
 */
export type NotifyEvent = { actorId: string } & (
  | { kind: "expense.added" | "expense.deleted"; groupId: string; expenseId: string; expense: ExpenseSnapshot }
  | { kind: "expense.edited"; groupId: string; expenseId: string; before: ExpenseSnapshot; after: ExpenseSnapshot }
  | {
      kind: "payment.requested" | "payment.confirmed" | "payment.declined" | "payment.withdrawn";
      groupId: string;
      paymentId: string;
      payment: PaymentNote;
    }
  | { kind: "member.added"; groupId: string; userId: string }
  | { kind: "signup.approved" | "signup.rejected"; userId: string }
);

/** One person to tell, and what they read. */
type Note = { userId: string } & NotificationData;

/** Who an expense involves: who paid it and who shares it. */
const involved = (e: ExpenseSnapshot) => [e.paidBy, ...Object.keys(e.shares)];

/** Everyone the event concerns, each with what they read; the one who did it is left out later. */
function notesFor(event: NotifyEvent): Note[] {
  switch (event.kind) {
    case "expense.added":
      return [...new Set(involved(event.expense))].map((userId) => ({
        userId,
        kind: "expense.added",
        data: {
          description: event.expense.description,
          amount: event.expense.amount,
          paidBy: event.expense.paidBy,
          share: event.expense.shares[userId],
        },
      }));
    case "expense.deleted":
      return [...new Set(involved(event.expense))].map((userId) => ({
        userId,
        kind: "expense.deleted",
        data: { description: event.expense.description, amount: event.expense.amount },
      }));
    case "expense.edited": {
      const { before, after } = event;
      return [...new Set([...involved(before), ...involved(after)])].map((userId) => ({
        userId,
        kind: event.kind,
        data: { description: after.description, shareBefore: before.shares[userId], shareAfter: after.shares[userId] },
      }));
    }
    case "payment.requested":
      return [{ userId: event.payment.to, kind: event.kind, data: event.payment }];
    // Withdrawn: the payee was asked to confirm it, and needn't any more.
    case "payment.withdrawn":
    case "payment.confirmed":
    case "payment.declined": {
      const userId = event.kind === "payment.withdrawn" ? event.payment.to : event.payment.from;
      return [{ userId, kind: event.kind, data: event.payment }];
    }
    case "member.added":
    case "signup.approved":
    case "signup.rejected":
      return [{ userId: event.userId, kind: event.kind, data: null }];
  }
}

/**
 * Tells everyone `event` concerns, apart from whoever did it: under the bell, for those who can
 * see it there (approved, still in the group, and with in-app notifications on), and by push to
 * every browser they turned push on in (src/worker/push.ts). A notification is
 * a side effect of something already done, so a failure here is logged and never undoes or blocks
 * it. Push messages go out after the answer (`waitUntil`), so a slow push service never holds it
 * up. Email (PR 9) goes out from here too.
 */
export async function notify(env: Env, event: NotifyEvent): Promise<void> {
  try {
    const notes = notesFor(event).filter((n) => n.userId !== event.actorId);
    if (!notes.length) return;
    const groupId = "groupId" in event ? event.groupId : null;
    const subjectId = "expenseId" in event ? event.expenseId : "paymentId" in event ? event.paymentId : null;
    waitUntil(pushNotes(env, { actorId: event.actorId, groupId, subjectId }, notes));
    const at = now();
    // Each recipient is checked in the statement that tells them, so someone who has just left the
    // group, been deactivated or turned notifications off isn't told.
    await env.DB.batch(
      notes.map((n) =>
        env.DB.prepare(
          `INSERT INTO notifications (id, user_id, kind, group_id, subject_id, actor_id, data, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'approved')
             AND (? IS NULL OR EXISTS (SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?))
             AND NOT EXISTS (SELECT 1 FROM notification_prefs WHERE user_id = ? AND in_app = 0)`,
        ).bind(
          randomId(),
          n.userId,
          n.kind,
          groupId,
          subjectId,
          event.actorId,
          n.data === null ? null : JSON.stringify(n.data),
          at,
          n.userId,
          groupId,
          groupId,
          n.userId,
          n.userId,
        ),
      ),
    );
  } catch (err) {
    console.error("notifying failed:", event.kind, err);
  }
}

interface NotificationRow {
  id: string;
  kind: AppNotification["kind"];
  group_id: string | null;
  group_name: string | null;
  group_currency: Currency;
  subject_id: string | null;
  actor_id: string | null;
  data: string | null;
  created_at: string;
  read_at: string | null;
}

/** Unread notifications of `userId`, counted up to UNREAD_MAX + 1 (the bell shows "99+"). */
export async function unreadCount(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM (SELECT 1 FROM notifications WHERE user_id = ? AND read_at IS NULL LIMIT ?)",
  )
    .bind(userId, UNREAD_MAX + 1)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Ids a notification mentions: who did it, and who paid or was paid. */
function mentioned(n: AppNotification): string[] {
  const ids = n.actorId ? [n.actorId] : [];
  if (n.kind === "expense.added") ids.push(n.data.paidBy);
  if (n.kind.startsWith("payment.")) {
    const p = n.data as PaymentNote;
    ids.push(p.from, p.to);
  }
  return ids;
}

/**
 * One page of `userId`'s notifications, newest first. `before` is the id of the last one on the
 * previous page.
 */
export async function notificationPage(
  env: Env,
  userId: string,
  before: string | null,
  size: number,
): Promise<NotificationPage> {
  const columns = `SELECT n.id, n.kind, n.group_id, g.name AS group_name, g.currency AS group_currency, n.subject_id,
      n.actor_id, n.data, n.created_at, n.read_at
    FROM notifications n LEFT JOIN groups g ON g.id = n.group_id`;
  let statement: D1PreparedStatement;
  if (before) {
    const after = await env.DB.prepare(
      "SELECT created_at, rowid AS seq FROM notifications WHERE user_id = ? AND id = ?",
    )
      .bind(userId, before)
      .first<{ created_at: string; seq: number }>();
    if (!after) throw new HttpError(400, "invalid_cursor", "No such notification to list from");
    statement = env.DB.prepare(
      `${columns} WHERE n.user_id = ? AND (n.created_at, n.rowid) < (?, ?)
       ORDER BY n.created_at DESC, n.rowid DESC LIMIT ?`,
    ).bind(userId, after.created_at, after.seq, size + 1);
  } else {
    statement = env.DB.prepare(`${columns} WHERE n.user_id = ? ORDER BY n.created_at DESC, n.rowid DESC LIMIT ?`).bind(
      userId,
      size + 1,
    );
  }
  const [{ results }, unread] = await Promise.all([statement.all<NotificationRow>(), unreadCount(env, userId)]);
  const notifications = results.slice(0, size).map(
    (r) =>
      ({
        id: r.id,
        kind: r.kind,
        actorId: r.actor_id,
        group: r.group_id && r.group_name ? { id: r.group_id, name: r.group_name, currency: r.group_currency } : null,
        subjectId: r.subject_id,
        data: r.data === null ? null : JSON.parse(r.data),
        createdAt: r.created_at,
        read: r.read_at !== null,
      }) as AppNotification,
  );
  const ids = [...new Set(notifications.flatMap(mentioned))];
  const { results: users } = await env.DB.prepare(
    "SELECT id, name FROM users WHERE id IN (SELECT value FROM json_each(?))",
  )
    .bind(JSON.stringify(ids))
    .all<{ id: string; name: string }>();
  return {
    notifications,
    names: Object.fromEntries(users.map((u) => [u.id, u.name])),
    next: results.length > size ? notifications[notifications.length - 1]!.id : null,
    unread,
  };
}

/** Marks one of `userId`'s notifications read (`id`), or all of them (null). */
export async function markRead(env: Env, userId: string, id: string | null): Promise<void> {
  if (id)
    await env.DB.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL")
      .bind(now(), userId, id)
      .run();
  else
    await env.DB.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL")
      .bind(now(), userId)
      .run();
}

export async function getNotificationSettings(env: Env, userId: string): Promise<NotificationSettings> {
  const row = await env.DB.prepare("SELECT in_app FROM notification_prefs WHERE user_id = ?")
    .bind(userId)
    .first<{ in_app: number }>();
  return { inApp: row ? row.in_app === 1 : true };
}

/** Saves the settings present in `body`; each is checked before any is saved. */
export async function updateNotificationSettings(
  env: Env,
  userId: string,
  body: Record<string, unknown>,
): Promise<NotificationSettings> {
  if ("inApp" in body) {
    if (typeof body.inApp !== "boolean") throw new HttpError(400, "invalid_input", "inApp must be true or false");
    await env.DB.prepare(
      `INSERT INTO notification_prefs (user_id, in_app) VALUES (?, ?)
       ON CONFLICT (user_id) DO UPDATE SET in_app = excluded.in_app`,
    )
      .bind(userId, body.inApp ? 1 : 0)
      .run();
  }
  return getNotificationSettings(env, userId);
}

/** Notifications are kept this long, read or not. */
export const NOTIFICATION_DAYS = 180;

/** Removes notifications older than NOTIFICATION_DAYS (daily, from the scheduled handler). How many. */
export async function cleanUpNotifications(env: Env): Promise<number> {
  const cutoff = new Date(Date.now() - NOTIFICATION_DAYS * 86400_000).toISOString();
  const result = await env.DB.prepare("DELETE FROM notifications WHERE created_at < ?").bind(cutoff).run();
  return result.meta.changes ?? 0;
}
