import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MAX_PENDING_PAYMENTS } from "../src/shared/settlements";
import { json, makeUser, send } from "./helpers";

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
  return { id: group.id as string, people };
}

const addExpense = (groupId: string, paidBy: Person, amount: number, participants: Person[]) =>
  post(`/api/groups/${groupId}/expenses`, paidBy.cookie, {
    description: "Dinner",
    amount,
    paidBy: paidBy.id,
    date: "2026-10-01",
    splitMethod: "equal",
    participants: participants.map((p) => p.id),
  });

const pay = (groupId: string, by: Person, from: Person, to: Person, amount: number, method = "other") =>
  post(`/api/groups/${groupId}/payments`, by.cookie, { from: from.id, to: to.id, amount, method });

const decide = (groupId: string, by: Person, paymentId: string, action: string) =>
  post(`/api/groups/${groupId}/payments/${paymentId}/${action}`, by.cookie);

async function balancesOf(groupId: string, who: Person) {
  const body = await json(await send(`/api/groups/${groupId}/balances`, { cookie: who.cookie }));
  return {
    nets: Object.fromEntries(body.balances.map((b: any) => [b.userId, b.net])),
    suggestions: body.suggestions.map((s: any) => [s.fromId, s.toId, s.amount]),
  };
}

const paymentsOf = async (groupId: string, who: Person) =>
  json(await send(`/api/groups/${groupId}/payments`, { cookie: who.cookie }));

const deactivate = (p: Person) =>
  env.DB.prepare("UPDATE users SET status = 'deactivated' WHERE id = ?").bind(p.id).run();

const errorCode = async (res: Response) => (await json(res)).error?.code;

describe("settling up", () => {
  it("suggests who pays whom, and a payment counts once the payee confirms it", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob", "Cat"]);
    const [ann, bob, cat] = people as [Person, Person, Person];
    // Ann paid 30 for all three; Bob paid 15 for himself and Cat. Cat owes 17.50, Bob 2.50.
    expect((await addExpense(id, ann, 3000, [ann, bob, cat])).status).toBe(200);
    expect((await addExpense(id, bob, 1500, [bob, cat])).status).toBe(200);
    expect((await balancesOf(id, cat)).suggestions).toEqual([
      [cat.id, ann.id, 1750],
      [bob.id, ann.id, 250],
    ]);

    const res = await pay(id, cat, cat, ann, 1750, "venmo");
    expect(res.status).toBe(200);
    const { payment } = await json(res);
    expect(payment).toMatchObject({
      fromId: cat.id,
      fromName: "Cat",
      toId: ann.id,
      toName: "Ann",
      amount: 1750,
      method: "venmo",
      status: "pending",
      createdBy: cat.id,
      decidedAt: null,
    });

    // Pending: listed apart, and no change to balances or suggestions.
    const listed = await paymentsOf(id, bob);
    expect(listed.pending.map((p: any) => p.id)).toEqual([payment.id]);
    expect(listed.recent).toEqual([]);
    expect((await balancesOf(id, ann)).nets).toEqual({ [ann.id]: 2000, [bob.id]: -250, [cat.id]: -1750 });
    // The suggestion stays, saying what has been sent so far.
    const raw = await json(await send(`/api/groups/${id}/balances`, { cookie: cat.cookie }));
    expect(raw.suggestions.map((x: any) => [x.fromId, x.pending])).toEqual([
      [cat.id, 1750],
      [bob.id, 0],
    ]);

    // Only the payee confirms.
    expect((await decide(id, cat, payment.id, "confirm")).status).toBe(403);
    expect((await decide(id, bob, payment.id, "confirm")).status).toBe(403);
    const confirmed = await decide(id, ann, payment.id, "confirm");
    expect(confirmed.status).toBe(200);
    expect((await json(confirmed)).payment).toMatchObject({ status: "confirmed" });
    expect(await errorCode(await decide(id, ann, payment.id, "confirm"))).toBe("payment_not_pending");
    expect(await errorCode(await decide(id, cat, payment.id, "withdraw"))).toBe("payment_not_pending");

    const after = await balancesOf(id, cat);
    expect(after.nets).toEqual({ [ann.id]: 250, [bob.id]: -250, [cat.id]: 0 });
    expect(after.suggestions).toEqual([[bob.id, ann.id, 250]]);
    const list = await paymentsOf(id, cat);
    expect(list.pending).toEqual([]);
    expect(list.recent.map((p: any) => [p.id, p.status])).toEqual([[payment.id, "confirmed"]]);

    const log = await env.DB.prepare("SELECT * FROM activity_log WHERE subject_id = ? ORDER BY created_at, action")
      .bind(payment.id)
      .all<any>();
    expect(log.results.map((r) => [r.action, r.actor_id])).toEqual([
      ["settlement.added", cat.id],
      ["settlement.confirmed", ann.id],
    ]);
    expect(JSON.parse(log.results[0].data)).toEqual({
      from: cat.id,
      to: ann.id,
      amount: 1750,
      method: "venmo",
      status: "pending",
    });
  });

  it("takes partial payments, and payments between any two members", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob", "Cat"]);
    const [ann, bob, cat] = people as [Person, Person, Person];
    await addExpense(id, ann, 1000, [ann, bob]);
    // Bob pays a little, then pays Cat, who is owed nothing (Cat now owes it back).
    const part = (await json(await pay(id, bob, bob, ann, 200))).payment;
    expect((await decide(id, ann, part.id, "confirm")).status).toBe(200);
    expect((await balancesOf(id, ann)).suggestions).toEqual([[bob.id, ann.id, 300]]);
    const odd = (await json(await pay(id, bob, bob, cat, 100))).payment;
    expect((await decide(id, cat, odd.id, "confirm")).status).toBe(200);
    expect((await balancesOf(id, ann)).nets).toEqual({ [ann.id]: 300, [bob.id]: -200, [cat.id]: -100 });
  });

  it("lets the payee decline and the payer withdraw, neither counting", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob", "Cat"]);
    const [ann, bob, cat] = people as [Person, Person, Person];
    await addExpense(id, ann, 1000, [ann, bob]);
    const one = (await json(await pay(id, bob, bob, ann, 500))).payment;
    expect((await decide(id, bob, one.id, "decline")).status).toBe(403);
    expect((await decide(id, cat, one.id, "decline")).status).toBe(403);
    expect((await json(await decide(id, ann, one.id, "decline"))).payment.status).toBe("declined");

    const two = (await json(await pay(id, bob, bob, ann, 500))).payment;
    expect((await decide(id, ann, two.id, "withdraw")).status).toBe(403);
    expect((await json(await decide(id, bob, two.id, "withdraw"))).payment.status).toBe("withdrawn");
    expect(await errorCode(await decide(id, ann, two.id, "confirm"))).toBe("payment_not_pending");

    expect((await balancesOf(id, ann)).nets).toEqual({ [ann.id]: 500, [bob.id]: -500, [cat.id]: 0 });
    const list = await paymentsOf(id, ann);
    expect(list.pending).toEqual([]);
    expect(list.recent.map((p: any) => p.status).sort()).toEqual(["declined", "withdrawn"]);
    const actions = await env.DB.prepare(
      "SELECT action FROM activity_log WHERE group_id = ? AND action LIKE 'settlement.%' ORDER BY action",
    )
      .bind(id)
      .all<{ action: string }>();
    expect(actions.results.map((r) => r.action)).toEqual([
      "settlement.added",
      "settlement.added",
      "settlement.declined",
      "settlement.withdrawn",
    ]);
  });

  it("checks what is recorded", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob", "Cat"]);
    const [ann, bob, cat] = people as [Person, Person, Person];
    const outsider = await makeUser("approved");
    expect(await errorCode(await pay(id, bob, bob, bob, 100))).toBe("invalid_payee");
    expect(await errorCode(await pay(id, bob, bob, ann, 0))).toBe("invalid_amount");
    expect(await errorCode(await pay(id, bob, bob, ann, 1.5))).toBe("invalid_amount");
    expect(await errorCode(await pay(id, bob, bob, ann, 100, "cash"))).toBe("invalid_method");
    // Someone else's payment, or one "received" from someone who can still confirm it themselves.
    expect(await errorCode(await pay(id, cat, bob, ann, 100))).toBe("not_your_payment");
    expect(await errorCode(await pay(id, ann, bob, ann, 100))).toBe("not_your_payment");
    expect(await errorCode(await pay(id, bob, bob, { ...outsider, email: "" }, 100))).toBe("not_in_group");
    expect((await pay(id, outsider, outsider, ann, 100)).status).toBe(404);
    expect((await send(`/api/groups/${id}/payments`, { cookie: outsider.cookie })).status).toBe(404);

    const p = (await json(await pay(id, bob, bob, ann, 100))).payment;
    expect((await decide(id, outsider, p.id, "confirm")).status).toBe(404);
    expect(await errorCode(await decide(id, ann, "nope", "confirm"))).toBe("payment_not_found");
    // A payment is only reachable through its own group.
    const other = await makeGroup(["Dan"]);
    expect(await errorCode(await decide(other.id, other.people[0]!, p.id, "confirm"))).toBe("payment_not_found");
  });

  it("offers Venmo only in US-dollar groups", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"], "EUR");
    const [ann, bob] = people as [Person, Person];
    expect(await errorCode(await pay(id, bob, bob, ann, 100, "venmo"))).toBe("venmo_usd_only");
    expect((await pay(id, bob, bob, ann, 100, "other")).status).toBe(200);
  });

  it("limits the payments one person has awaiting confirmation", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    for (let i = 0; i < MAX_PENDING_PAYMENTS; i++) expect((await pay(id, bob, bob, ann, 1)).status).toBe(200);
    expect(await errorCode(await pay(id, bob, bob, ann, 1))).toBe("too_many_pending");
    // Ann's own payments aren't held up by Bob's.
    expect((await pay(id, ann, ann, bob, 1)).status).toBe(200);
  });
});

describe("payments with a deactivated member", () => {
  it("count at once when paid to them, and the payee records what a deactivated member paid", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob", "Cat"]);
    const [ann, bob, cat] = people as [Person, Person, Person];
    await addExpense(id, ann, 900, [ann, bob, cat]);
    await addExpense(id, bob, 600, [bob, cat]);
    // Ann +600, Bob 0, Cat -600 … then Ann is deactivated: Cat pays her, which counts at once.
    await deactivate(ann);
    const toAnn = await json(await pay(id, cat, cat, ann, 600));
    expect(toAnn.payment).toMatchObject({ status: "confirmed", decidedAt: expect.any(String) });
    expect((await balancesOf(id, cat)).nets[cat.id]).toBe(0);

    // Bob is owed by deactivated Ann only after a new expense; Bob records receiving it.
    await addExpense(id, bob, 400, [ann, bob]);
    const fromAnn = await json(await pay(id, bob, ann, bob, 200));
    expect(fromAnn.payment).toMatchObject({ fromId: ann.id, toId: bob.id, status: "confirmed", createdBy: bob.id });
    expect((await balancesOf(id, bob)).nets).toEqual({ [ann.id]: 0, [bob.id]: 0, [cat.id]: 0 });
  });

  it("let the payer confirm a pending payment once the payee is deactivated", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    await addExpense(id, ann, 1000, [ann, bob]);
    const p = (await json(await pay(id, bob, bob, ann, 500))).payment;
    expect((await decide(id, bob, p.id, "confirm")).status).toBe(403);
    await deactivate(ann);
    expect((await json(await decide(id, bob, p.id, "confirm"))).payment.status).toBe("confirmed");
    expect((await balancesOf(id, bob)).suggestions).toEqual([]);
  });
});

describe("leaving and deleting with payments", () => {
  it("waits until no payment awaits confirmation", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob", "Cat"]);
    const [ann, bob, cat] = people as [Person, Person, Person];
    await addExpense(id, ann, 1000, [ann, bob]);
    const p = (await json(await pay(id, bob, bob, ann, 500))).payment;
    // Cat, who has no part in anything, may still go; Bob may not while his payment is pending.
    expect(await errorCode(await post(`/api/groups/${id}/leave`, bob.cookie))).toBe("group_not_settled");
    expect(await errorCode(await post(`/api/groups/${id}/delete`, ann.cookie))).toBe("group_not_settled");
    expect((await post(`/api/groups/${id}/leave`, cat.cookie)).status).toBe(204);
    expect((await decide(id, ann, p.id, "confirm")).status).toBe(200);
    expect((await post(`/api/groups/${id}/leave`, bob.cookie)).status).toBe(204);
    expect((await post(`/api/groups/${id}/delete`, ann.cookie)).status).toBe(204);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM settlements WHERE group_id = ?")
      .bind(id)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("counts a payment as being involved", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob", "Cat"]);
    const [ann, bob, cat] = people as [Person, Person, Person];
    // Bob pays Cat with no expenses at all: both now have balances and can't simply go.
    const p = (await json(await pay(id, bob, bob, cat, 300))).payment;
    expect((await decide(id, cat, p.id, "confirm")).status).toBe(200);
    expect(await errorCode(await post(`/api/groups/${id}/leave`, cat.cookie))).toBe("group_not_settled");
    expect(await errorCode(await post(`/api/groups/${id}/members/${bob.id}/remove`, ann.cookie))).toBe(
      "group_not_settled",
    );
    // Paid back: settled, and they may go.
    const back = (await json(await pay(id, cat, cat, bob, 300))).payment;
    expect((await decide(id, bob, back.id, "confirm")).status).toBe(200);
    expect((await post(`/api/groups/${id}/leave`, cat.cookie)).status).toBe(204);
  });
});
