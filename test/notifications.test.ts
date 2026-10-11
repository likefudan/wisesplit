import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { NOTIFICATIONS_PAGE, UNREAD_MAX } from "../src/shared/notifications";
import { cleanUpNotifications, NOTIFICATION_DAYS } from "../src/worker/notifications";
import { admin, json, makeUser, send } from "./helpers";

const post = (path: string, cookie: string, body: unknown = {}) => send(path, { cookie, body });

type Person = { id: string; email: string; cookie: string };

/** A group of `names.length` approved users; the first is its owner. */
async function makeGroup(names: string[], currency = "USD") {
  const people: Person[] = [];
  for (const name of names) people.push(await makeUser("approved", undefined, name));
  const owner = people[0]!;
  const group = (await json(await post("/api/groups", owner.cookie, { name: "Camping weekend", currency }))).group;
  for (const p of people.slice(1))
    expect((await post(`/api/groups/${group.id}/members`, owner.cookie, { email: p.email })).status).toBe(200);
  // Being added is a notification of its own; start each test from none.
  await env.DB.prepare("DELETE FROM notifications WHERE group_id = ?").bind(group.id).run();
  return { id: group.id as string, people };
}

const expenseBody = (paidBy: Person, amount: number, participants: Person[], description = "Dinner") => ({
  description,
  amount,
  paidBy: paidBy.id,
  date: "2026-10-01",
  splitMethod: "equal",
  participants: participants.map((p) => p.id),
});

async function addExpense(groupId: string, by: Person, paidBy: Person, amount: number, participants: Person[]) {
  const res = await post(`/api/groups/${groupId}/expenses`, by.cookie, expenseBody(paidBy, amount, participants));
  expect(res.status).toBe(200);
  return (await json(res)).expense as { id: string; version: number };
}

async function pay(groupId: string, by: Person, to: Person, amount: number) {
  const res = await post(`/api/groups/${groupId}/payments`, by.cookie, {
    from: by.id,
    to: to.id,
    amount,
    method: "other",
  });
  expect(res.status).toBe(200);
  return (await json(res)).payment as { id: string; status: string };
}

const listOf = async (who: Person, query = "") =>
  json(await send(`/api/notifications${query}`, { cookie: who.cookie }));
const kindsOf = async (who: Person) => (await listOf(who)).notifications.map((n: any) => n.kind);
const unreadOf = async (who: Person) =>
  (await json(await send("/api/notifications/unread", { cookie: who.cookie }))).unread;

describe("notifications", () => {
  it("tells everyone in an expense but whoever added it, each with their own share", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob", "Cat", "Dan"]);
    const [ann, bob, cat, dan] = people as [Person, Person, Person, Person];
    // Bob adds what Ann paid for Ann, Bob and Cat; Dan is not in it.
    const expense = await addExpense(id, bob, ann, 3000, [ann, bob, cat]);

    const annList = await listOf(ann);
    expect(annList.unread).toBe(1);
    expect(annList.notifications).toEqual([
      {
        id: expect.any(String),
        kind: "expense.added",
        actorId: bob.id,
        group: { id, name: "Camping weekend", currency: "USD" },
        subjectId: expense.id,
        data: { description: "Dinner", amount: 3000, paidBy: ann.id, share: 1000 },
        createdAt: expect.any(String),
        read: false,
      },
    ]);
    expect(annList.names).toEqual({ [bob.id]: "Bob", [ann.id]: "Ann" });
    expect((await listOf(cat)).notifications[0].data.share).toBe(1000);
    expect(await kindsOf(bob)).toEqual([]);
    expect(await kindsOf(dan)).toEqual([]);
  });

  it("tells who is in an expense, before or after, about an edit, and about a deletion", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob", "Cat"]);
    const [ann, bob, cat] = people as [Person, Person, Person];
    const expense = await addExpense(id, ann, ann, 3000, [ann, bob]);
    // Bob is taken out, Cat put in.
    const edit = await post(`/api/groups/${id}/expenses/${expense.id}`, ann.cookie, {
      ...expenseBody(ann, 3000, [ann, cat], "Pizza"),
      version: expense.version,
    });
    expect(edit.status).toBe(200);
    const [bobEdit] = (await listOf(bob)).notifications;
    expect(bobEdit).toMatchObject({ kind: "expense.edited", data: { description: "Pizza", shareBefore: 1500 } });
    expect(bobEdit.data).not.toHaveProperty("shareAfter");
    const [catEdit] = (await listOf(cat)).notifications;
    expect(catEdit.data).toEqual({ description: "Pizza", shareAfter: 1500 });

    const del = await post(`/api/groups/${id}/expenses/${expense.id}/delete`, cat.cookie, { version: 2 });
    expect(del.status).toBe(204);
    expect((await listOf(ann)).notifications[0]).toMatchObject({
      kind: "expense.deleted",
      actorId: cat.id,
      data: { description: "Pizza", amount: 3000 },
    });
    // Bob was no longer in it.
    expect(await kindsOf(bob)).toEqual(["expense.edited", "expense.added"]);
    expect(await kindsOf(cat)).toEqual(["expense.edited"]);
  });

  it("asks the payee to confirm a payment, and tells the payer the answer", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    await addExpense(id, ann, ann, 3000, [ann, bob]);

    const first = await pay(id, bob, ann, 1000);
    expect((await listOf(ann)).notifications[0]).toMatchObject({
      kind: "payment.requested",
      actorId: bob.id,
      subjectId: first.id,
      data: { from: bob.id, to: ann.id, amount: 1000, method: "other" },
    });
    expect((await post(`/api/groups/${id}/payments/${first.id}/confirm`, ann.cookie)).status).toBe(200);
    expect((await listOf(bob)).notifications[0]).toMatchObject({ kind: "payment.confirmed", actorId: ann.id });

    const second = await pay(id, bob, ann, 300);
    expect((await post(`/api/groups/${id}/payments/${second.id}/decline`, ann.cookie)).status).toBe(200);
    const third = await pay(id, bob, ann, 200);
    expect((await post(`/api/groups/${id}/payments/${third.id}/withdraw`, bob.cookie)).status).toBe(200);

    expect(await kindsOf(bob)).toEqual(["payment.declined", "payment.confirmed", "expense.added"]);
    expect(await kindsOf(ann)).toEqual([
      "payment.withdrawn",
      "payment.requested",
      "payment.requested",
      "payment.requested",
    ]);
  });

  it("tells no one deactivated about a payment that counted at once", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    await addExpense(id, ann, ann, 3000, [ann, bob]);
    await env.DB.prepare("UPDATE users SET status = 'deactivated' WHERE id = ?").bind(ann.id).run();
    expect((await pay(id, bob, ann, 1500)).status).toBe("confirmed");
    const { n } = (await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind LIKE 'payment.%'",
    )
      .bind(ann.id)
      .first<{ n: number }>())!;
    expect(n).toBe(0);
  });

  it("tells someone they were added to a group", async () => {
    const owner = await makeUser("approved", undefined, "Olga");
    const friend = await makeUser("approved", undefined, "Finn");
    const group = (await json(await post("/api/groups", owner.cookie, { name: "Beach", currency: "EUR" }))).group;
    await post(`/api/groups/${group.id}/members`, owner.cookie, { email: friend.email });
    expect((await listOf(friend)).notifications).toMatchObject([
      { kind: "member.added", actorId: owner.id, group: { id: group.id, name: "Beach", currency: "EUR" }, data: null },
    ]);
    expect(await kindsOf(owner)).toEqual([]);
  });

  it("tells an approved applicant, and writes nothing for a rejected one (who can't see it)", async () => {
    const boss = await admin();
    const approved = await makeUser("pending");
    const rejected = await makeUser("pending");
    expect((await post(`/api/admin/users/${approved.id}/approve`, boss.cookie)).status).toBe(200);
    expect((await post(`/api/admin/users/${rejected.id}/reject`, boss.cookie)).status).toBe(200);
    expect((await listOf(approved)).notifications).toMatchObject([
      { kind: "signup.approved", actorId: boss.id, group: null, data: null },
    ]);
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?")
      .bind(rejected.id)
      .first<{ n: number }>())!;
    expect(n).toBe(0);
  });

  it("tells no one who turned in-app notifications off, or has left the group", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob", "Cat"]);
    const [ann, bob, cat] = people as [Person, Person, Person];
    expect(await json(await send("/api/notifications/settings", { cookie: bob.cookie }))).toEqual({
      settings: { inApp: true, email: true },
    });
    const off = await post("/api/notifications/settings", bob.cookie, { inApp: false });
    expect(await json(off)).toEqual({ settings: { inApp: false, email: true } });
    expect((await post("/api/notifications/settings", bob.cookie, { inApp: "no" })).status).toBe(400);
    await addExpense(id, ann, ann, 1000, [ann, bob]);
    expect(await kindsOf(bob)).toEqual([]);
    await post("/api/notifications/settings", bob.cookie, { inApp: true });
    await addExpense(id, ann, ann, 1000, [ann, bob]);
    expect(await kindsOf(bob)).toEqual(["expense.added"]);

    // Cat shares an expense, settles up and leaves; she isn't told about it any more.
    const shared = await addExpense(id, ann, ann, 1000, [ann, cat]);
    const back = await pay(id, cat, ann, 500);
    await post(`/api/groups/${id}/payments/${back.id}/confirm`, ann.cookie);
    const bobBack = await pay(id, bob, ann, 1000);
    await post(`/api/groups/${id}/payments/${bobBack.id}/confirm`, ann.cookie);
    expect((await post(`/api/groups/${id}/leave`, cat.cookie)).status).toBe(204);
    const renamed = await post(`/api/groups/${id}/expenses/${shared.id}`, ann.cookie, {
      ...expenseBody(ann, 1000, [ann, cat], "Lunch"),
      version: shared.version,
    });
    expect(renamed.status).toBe(200);
    expect(await kindsOf(cat)).toEqual(["payment.confirmed", "expense.added"]);
  });

  it("pages through notifications, counts the unread and marks them read", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    const total = NOTIFICATIONS_PAGE + 3;
    for (let i = 0; i < total; i++) await addExpense(id, ann, ann, 100 + i, [ann, bob]);
    expect(await unreadOf(bob)).toBe(total);

    const first = await listOf(bob);
    expect(first.notifications).toHaveLength(NOTIFICATIONS_PAGE);
    expect(first.notifications[0].data.amount).toBe(100 + total - 1);
    const second = await listOf(bob, `?before=${first.next}`);
    expect(second.notifications.map((n: any) => n.data.amount)).toEqual([102, 101, 100]);
    expect(second.next).toBeNull();
    expect((await send("/api/notifications?before=nope", { cookie: bob.cookie })).status).toBe(400);

    // Only Bob can mark Bob's.
    const newest = first.notifications[0].id;
    expect((await post(`/api/notifications/${newest}/read`, ann.cookie)).status).toBe(204);
    expect(await unreadOf(bob)).toBe(total);
    expect((await post(`/api/notifications/${newest}/read`, bob.cookie)).status).toBe(204);
    expect(await unreadOf(bob)).toBe(total - 1);
    expect((await listOf(bob)).notifications[0].read).toBe(true);
    expect((await post("/api/notifications/read-all", bob.cookie)).status).toBe(204);
    expect(await unreadOf(bob)).toBe(0);
  });

  it("counts unread up to a limit", async () => {
    const me = await makeUser("approved");
    const at = new Date().toISOString();
    await env.DB.batch(
      Array.from({ length: UNREAD_MAX + 5 }, (_, i) =>
        env.DB.prepare(
          "INSERT INTO notifications (id, user_id, kind, created_at) VALUES (?, ?, 'signup.approved', ?)",
        ).bind(`${me.id}-${i}`, me.id, at),
      ),
    );
    expect(await unreadOf(me)).toBe(UNREAD_MAX + 1);
  });

  it("goes with the group when it is deleted, and with age", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    const expense = await addExpense(id, ann, ann, 1000, [ann, bob]);
    await post(`/api/groups/${id}/expenses/${expense.id}/delete`, ann.cookie, { version: 1 });
    expect(await kindsOf(bob)).toEqual(["expense.deleted", "expense.added"]);
    expect((await post(`/api/groups/${id}/delete`, ann.cookie)).status).toBe(204);
    expect(await kindsOf(bob)).toEqual([]);

    const old = new Date(Date.now() - (NOTIFICATION_DAYS + 1) * 86400_000).toISOString();
    await env.DB.prepare(
      "INSERT INTO notifications (id, user_id, kind, created_at) VALUES (?, ?, 'signup.approved', ?), (?, ?, 'signup.approved', ?)",
    )
      .bind(`${bob.id}-old`, bob.id, old, `${bob.id}-new`, bob.id, new Date().toISOString())
      .run();
    expect(await cleanUpNotifications(env)).toBeGreaterThanOrEqual(1);
    expect((await listOf(bob)).notifications.map((n: any) => n.id)).toEqual([`${bob.id}-new`]);
  });

  it("is only for approved users", async () => {
    const pending = await makeUser("pending");
    expect((await send("/api/notifications", { cookie: pending.cookie })).status).toBe(403);
    expect((await send("/api/notifications/unread")).status).toBe(401);
  });
});
