import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { json, makeUser, send } from "./helpers";

const post = (path: string, cookie: string, body: unknown = {}) => send(path, { cookie, body });

/** A group of `names.length` approved users; the first is its owner. */
async function makeGroup(names: string[], currency = "USD") {
  const people = [];
  for (const name of names) people.push(await makeUser("approved", undefined, name));
  const owner = people[0]!;
  const res = await post("/api/groups", owner.cookie, { name: "Trip", currency });
  expect(res.status).toBe(200);
  const group = (await json(res)).group;
  for (const p of people.slice(1))
    expect((await post(`/api/groups/${group.id}/members`, owner.cookie, { email: p.email })).status).toBe(200);
  return { id: group.id as string, people: people as any };
}

type Person = { id: string; cookie: string };

function addExpense(
  groupId: string,
  by: Person,
  fields: {
    amount: number;
    paidBy: Person;
    participants: Person[];
    description?: string;
    date?: string;
    splitMethod?: string;
    splitParams?: unknown;
  },
) {
  return post(`/api/groups/${groupId}/expenses`, by.cookie, {
    description: fields.description ?? "Dinner",
    amount: fields.amount,
    paidBy: fields.paidBy.id,
    date: fields.date ?? "2026-10-01",
    splitMethod: fields.splitMethod ?? "equal",
    participants: fields.participants.map((p) => p.id),
    splitParams: fields.splitParams,
  });
}

const balancesOf = async (groupId: string, who: Person) =>
  Object.fromEntries(
    (await json(await send(`/api/groups/${groupId}/balances`, { cookie: who.cookie }))).balances.map((b: any) => [
      b.userId,
      b.net,
    ]),
  );

describe("adding expenses", () => {
  it("splits equally, with the leftover cent by user id, and logs it", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob", "Cat"]);
    const [ann, bob, cat] = people as [Person, Person, Person];
    const res = await addExpense(id, bob, {
      amount: 1000,
      paidBy: ann,
      participants: [cat, bob, ann],
      description: "  Pizza   night ",
    });
    expect(res.status).toBe(200);
    const { expense } = await json(res);
    const first = [ann, bob, cat].map((p) => p.id).sort()[0];
    expect(expense).toMatchObject({
      description: "Pizza night",
      amount: 1000,
      paidBy: ann.id,
      paidByName: "Ann",
      date: "2026-10-01",
      splitMethod: "equal",
      createdBy: bob.id,
    });
    expect(expense.shares).toHaveLength(3);
    for (const s of expense.shares) expect(s.amount).toBe(s.userId === first ? 334 : 333);
    expect(expense.shares.map((s: any) => s.userId)).toEqual([ann.id, bob.id, cat.id].sort());

    const log = await env.DB.prepare("SELECT * FROM activity_log WHERE subject_id = ?").bind(expense.id).all<any>();
    expect(log.results).toHaveLength(1);
    expect(log.results[0]).toMatchObject({ group_id: id, actor_id: bob.id, action: "expense.added" });
    expect(JSON.parse(log.results[0].data)).toMatchObject({ amount: 1000, paidBy: ann.id, splitMethod: "equal" });

    expect(await balancesOf(id, cat)).toEqual({
      [ann.id]: 1000 - (first === ann.id ? 334 : 333),
      [bob.id]: -(first === bob.id ? 334 : 333),
      [cat.id]: -(first === cat.id ? 334 : 333),
    });
  });

  it("lets the payer stay out of the split", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    expect((await addExpense(id, ann, { amount: 500, paidBy: ann, participants: [bob] })).status).toBe(200);
    expect(await balancesOf(id, ann)).toEqual({ [ann.id]: 500, [bob.id]: -500 });
  });

  it("checks every field", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    const good = {
      description: "Taxi",
      amount: 1200,
      paidBy: ann.id,
      date: "2026-02-28",
      splitMethod: "equal",
      participants: [ann.id, bob.id],
    };
    for (const [change, code] of [
      [{ description: " " }, "invalid_description"],
      [{ description: "x".repeat(101) }, "invalid_description"],
      [{ amount: 0 }, "invalid_amount"],
      [{ amount: -5 }, "invalid_amount"],
      [{ amount: 12.5 }, "invalid_amount"],
      [{ amount: "1200" }, "invalid_amount"],
      [{ amount: 10_000_000_001 }, "invalid_amount"],
      [{ paidBy: "" }, "invalid_payer"],
      [{ date: "2026-02-29" }, "invalid_date"],
      [{ date: "2026-13-01" }, "invalid_date"],
      [{ date: "26-01-01" }, "invalid_date"],
      [{ date: "1969-12-31" }, "invalid_date"],
      [{ splitMethod: "thirds" }, "invalid_split_method"],
      [{ splitMethod: undefined }, "invalid_split_method"],
      [{ splitMethod: "exact" }, "invalid_split"],
      [{ splitParams: { [ann.id]: 1200 } }, "invalid_split"],
      [{ splitMethod: "shares", splitParams: [1, 1] }, "invalid_split"],
      [{ splitMethod: "shares", splitParams: "1:1" }, "invalid_split"],
      [{ participants: [] }, "invalid_participants"],
      [{ participants: [ann.id, ann.id] }, "invalid_participants"],
      [{ participants: "everyone" }, "invalid_participants"],
      [{ participants: [ann.id, 5] }, "invalid_participants"],
    ] as const) {
      const res = await post(`/api/groups/${id}/expenses`, ann.cookie, { ...good, ...change });
      expect(res.status, JSON.stringify(change)).toBe(400);
      expect((await json(res)).error.code, JSON.stringify(change)).toBe(code);
    }
    expect((await post(`/api/groups/${id}/expenses`, ann.cookie, good)).status).toBe(200);
    expect((await post(`/api/groups/${id}/expenses`, ann.cookie, { ...good, date: "2024-02-29" })).status).toBe(200);
  });

  it("only takes people in the group", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    const outsider = await makeUser("approved");
    for (const fields of [
      { amount: 100, paidBy: outsider, participants: [ann] },
      { amount: 100, paidBy: ann, participants: [ann, outsider] },
      { amount: 100, paidBy: ann, participants: [{ id: "nobody", cookie: "" }] },
    ]) {
      const res = await addExpense(id, bob, fields);
      expect(res.status).toBe(400);
      expect((await json(res)).error.code).toBe("not_in_group");
    }
    // Nor from them.
    expect((await addExpense(id, outsider, { amount: 100, paidBy: ann, participants: [ann] })).status).toBe(404);
    expect((await send(`/api/groups/${id}/expenses`, { cookie: outsider.cookie })).status).toBe(404);
    expect((await send(`/api/groups/${id}/balances`, { cookie: outsider.cookie })).status).toBe(404);
    expect((await send(`/api/groups/${id}/expenses`)).status).toBe(401);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM expenses WHERE group_id = ?").bind(id).first("n");
    expect(count).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE group_id = ?").bind(id).first("n")).toBe(
      0,
    );
  });

  it("works in currencies without decimals", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob", "Cat"], "JPY");
    const [ann, bob, cat] = people as [Person, Person, Person];
    const res = await addExpense(id, ann, { amount: 1000, paidBy: bob, participants: [ann, bob, cat] });
    expect((await json(res)).expense.shares.map((s: any) => s.amount).sort()).toEqual([333, 333, 334]);
  });
});

describe("other split methods", () => {
  it("takes exact amounts, keeps them as entered and logs them", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob", "Cat"]);
    const [ann, bob, cat] = people as [Person, Person, Person];
    const splitParams = { [ann.id]: 1000, [bob.id]: 2550, [cat.id]: 1 };
    const res = await addExpense(id, bob, {
      amount: 3551,
      paidBy: ann,
      participants: [ann, bob, cat],
      splitMethod: "exact",
      splitParams,
    });
    expect(res.status).toBe(200);
    const { expense } = await json(res);
    expect(expense).toMatchObject({ splitMethod: "exact", splitParams });
    expect(Object.fromEntries(expense.shares.map((s: any) => [s.userId, s.amount]))).toEqual(splitParams);
    expect(await balancesOf(id, cat)).toEqual({ [ann.id]: 2551, [bob.id]: -2550, [cat.id]: -1 });
    const log = await env.DB.prepare("SELECT data FROM activity_log WHERE subject_id = ?")
      .bind(expense.id)
      .first<any>();
    expect(JSON.parse(log.data)).toMatchObject({ splitMethod: "exact", splitParams, shares: splitParams });
    // And they come back the same in the list, for an edit form to show again.
    const list = await json(await send(`/api/groups/${id}/expenses`, { cookie: cat.cookie }));
    expect(list.expenses[0]).toMatchObject({ splitMethod: "exact", splitParams });
  });

  it("refuses exact amounts that don't add up, or leave someone out", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    for (const [splitParams, code] of [
      [{ [ann.id]: 500, [bob.id]: 499 }, "split_exact_total"],
      [{ [ann.id]: 500, [bob.id]: 501 }, "split_exact_total"],
      [{ [ann.id]: 1000 }, "invalid_split"],
      [{ [ann.id]: 1000, [bob.id]: 0 }, "invalid_split"],
      [{ [ann.id]: 1100, [bob.id]: -100 }, "invalid_split"],
      [{ [ann.id]: 500, [bob.id]: 500, nobody: 0 }, "invalid_split"],
    ] as const) {
      const res = await addExpense(id, ann, {
        amount: 1000,
        paidBy: ann,
        participants: [ann, bob],
        splitMethod: "exact",
        splitParams,
      });
      expect(res.status, JSON.stringify(splitParams)).toBe(400);
      expect((await json(res)).error.code, JSON.stringify(splitParams)).toBe(code);
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM expenses WHERE group_id = ?").bind(id).first("n")).toBe(0);
  });

  it("splits percentages, rounding by the largest remainder", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob", "Cat"]);
    const [ann, bob, cat] = people as [Person, Person, Person];
    const res = await addExpense(id, ann, {
      amount: 1000,
      paidBy: ann,
      participants: [ann, bob, cat],
      splitMethod: "percent",
      splitParams: { [ann.id]: 5000, [bob.id]: 2500, [cat.id]: 2500 },
    });
    expect(await balancesOf(id, ann)).toEqual({ [ann.id]: 500, [bob.id]: -250, [cat.id]: -250 });
    expect((await json(res)).expense.splitParams).toEqual({ [ann.id]: 5000, [bob.id]: 2500, [cat.id]: 2500 });
    const bad = await addExpense(id, ann, {
      amount: 1000,
      paidBy: ann,
      participants: [ann, bob],
      splitMethod: "percent",
      splitParams: { [ann.id]: 5000, [bob.id]: 4999 },
    });
    expect((await json(bad)).error.code).toBe("split_percent_total");
  });

  it("splits by shares, in yen too", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob", "Cat"], "JPY");
    const [ann, bob, cat] = people as [Person, Person, Person];
    const res = await addExpense(id, cat, {
      amount: 1001,
      paidBy: bob,
      participants: [ann, bob, cat],
      splitMethod: "shares",
      splitParams: { [ann.id]: 2, [bob.id]: 1, [cat.id]: 1 },
    });
    expect(res.status).toBe(200);
    // 1001 yen by 2:1:1 is 500.5, 250.25, 250.25: Ann's half yen is the largest remainder.
    const shares = Object.fromEntries((await json(res)).expense.shares.map((s: any) => [s.userId, s.amount]));
    expect(shares).toEqual({ [ann.id]: 501, [bob.id]: 250, [cat.id]: 250 });
  });

  it("splits the rest equally after adjustments, and refuses ones that can't work", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob", "Cat", "Wang"]);
    const [ann, bob, cat, wang] = people as [Person, Person, Person, Person];
    const all = [ann, bob, cat, wang];
    // $100 among 4 with Wang paying $10 more: $22.50 each, $32.50 for Wang.
    const res = await addExpense(id, ann, {
      amount: 10000,
      paidBy: ann,
      participants: all,
      splitMethod: "adjust",
      splitParams: { [wang.id]: 1000 },
    });
    expect(res.status).toBe(200);
    expect((await json(res)).expense).toMatchObject({ splitMethod: "adjust", splitParams: { [wang.id]: 1000 } });
    expect(await balancesOf(id, ann)).toEqual({ [ann.id]: 7750, [bob.id]: -2250, [cat.id]: -2250, [wang.id]: -3250 });
    for (const [splitParams, code] of [
      [{ [wang.id]: 10001 }, "split_adjust_too_large"],
      [{ [wang.id]: -4000 }, "split_adjust_negative"],
      [{ [wang.id]: 0 }, "invalid_split"],
      // Only for people sharing it.
      [{ nobody: 100 }, "invalid_split"],
    ] as const) {
      const bad = await addExpense(id, ann, {
        amount: 10000,
        paidBy: ann,
        participants: all,
        splitMethod: "adjust",
        splitParams,
      });
      expect(bad.status, JSON.stringify(splitParams)).toBe(400);
      expect((await json(bad)).error.code, JSON.stringify(splitParams)).toBe(code);
    }
    // No adjustments at all is just an equal split.
    const plain = await addExpense(id, ann, {
      amount: 100,
      paidBy: ann,
      participants: [bob, cat],
      splitMethod: "adjust",
      splitParams: {},
    });
    expect((await json(plain)).expense).toMatchObject({ splitMethod: "adjust", splitParams: {} });
  });

  it("still checks everyone in the split is in the group", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    const outsider = await makeUser("approved");
    const res = await addExpense(id, ann, {
      amount: 1000,
      paidBy: ann,
      participants: [bob, outsider],
      splitMethod: "shares",
      splitParams: { [bob.id]: 1, [outsider.id]: 1 },
    });
    expect((await json(res)).error.code).toBe("not_in_group");
  });

  it("stores no parameters for an equal split", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    const res = await addExpense(id, ann, { amount: 100, paidBy: ann, participants: [ann, bob], splitParams: null });
    const { expense } = await json(res);
    expect(expense.splitParams).toBeNull();
    expect(
      await env.DB.prepare("SELECT split_params FROM expenses WHERE id = ?").bind(expense.id).first("split_params"),
    ).toBeNull();
  });
});

describe("the expense list", () => {
  it("lists newest day first, in pages", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    const days = ["2026-01-05", "2026-03-01", "2026-01-05", "2025-12-31"];
    for (let i = 0; i < 25; i++)
      expect(
        (
          await addExpense(id, ann, {
            amount: 100 + i,
            paidBy: i % 2 ? ann : bob,
            participants: [ann, bob],
            description: `E${i}`,
            date: days[i % days.length],
          })
        ).status,
      ).toBe(200);
    const first = await json(await send(`/api/groups/${id}/expenses`, { cookie: bob.cookie }));
    expect(first.expenses).toHaveLength(20);
    expect(first.next).toBe(first.expenses[19].id);
    const second = await json(await send(`/api/groups/${id}/expenses?before=${first.next}`, { cookie: bob.cookie }));
    expect(second.expenses).toHaveLength(5);
    expect(second.next).toBeNull();
    const all = [...first.expenses, ...second.expenses];
    expect(new Set(all.map((e: any) => e.id)).size).toBe(25);
    // Newest day first; within a day, the one added last first.
    const order = all.map((e: any) => `${e.date} ${e.description}`);
    const expected = Array.from({ length: 25 }, (_, i) => ({ i, date: days[i % days.length]! }))
      .sort((a, b) => (a.date === b.date ? b.i - a.i : a.date < b.date ? 1 : -1))
      .map(({ i, date }) => `${date} E${i}`);
    // Expenses added in the same millisecond tie on created_at and then go by id, so compare per day.
    const byDay = (list: string[]) => list.map((s) => s.slice(0, 10));
    expect(byDay(order)).toEqual(byDay(expected));
    expect(first.expenses[0]).toMatchObject({ date: "2026-03-01", shares: expect.any(Array) });

    expect((await send(`/api/groups/${id}/expenses?before=nope`, { cookie: bob.cookie })).status).toBe(400);
  });

  it("is empty for a new group, where everyone is settled", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    expect(await json(await send(`/api/groups/${id}/expenses`, { cookie: ann.cookie }))).toEqual({
      expenses: [],
      next: null,
    });
    const { balances } = await json(await send(`/api/groups/${id}/balances`, { cookie: ann.cookie }));
    expect(balances).toEqual([
      { userId: ann.id, name: "Ann", net: 0 },
      { userId: bob.id, name: "Bob", net: 0 },
    ]);
  });
});

describe("leaving, removal and deletion once there are expenses", () => {
  it("someone with no expenses may leave while the group owes money", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob", "Cat"]);
    const [ann, bob, cat] = people as [Person, Person, Person];
    await addExpense(id, ann, { amount: 1000, paidBy: ann, participants: [ann, bob] });
    expect((await post(`/api/groups/${id}/leave`, cat.cookie)).status).toBe(204);
    // Bob owes Ann: neither may go, and Ann (owner) can't delete the group.
    let res = await post(`/api/groups/${id}/leave`, bob.cookie);
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("group_not_settled");
    res = await post(`/api/groups/${id}/members/${bob.id}/remove`, ann.cookie);
    expect(res.status).toBe(409);
    res = await post(`/api/groups/${id}/delete`, ann.cookie);
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("group_not_settled");
    expect(await balancesOf(id, bob)).toEqual({ [ann.id]: 500, [bob.id]: -500 });
  });

  it("anyone involved may go once the whole group is settled", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob", "Cat", "Dan"]);
    const [ann, bob, cat, dan] = people as [Person, Person, Person, Person];
    await addExpense(id, ann, { amount: 1000, paidBy: ann, participants: [ann, bob] });
    await addExpense(id, ann, { amount: 600, paidBy: cat, participants: [cat, dan] });
    // Bob evens up with Ann; Cat and Dan are still apart, so Bob can't go yet.
    await addExpense(id, bob, { amount: 1000, paidBy: bob, participants: [ann, bob] });
    expect(await balancesOf(id, ann)).toMatchObject({ [ann.id]: 0, [bob.id]: 0, [cat.id]: 300, [dan.id]: -300 });
    expect((await post(`/api/groups/${id}/leave`, bob.cookie)).status).toBe(409);
    await addExpense(id, dan, { amount: 300, paidBy: dan, participants: [cat] });
    expect((await post(`/api/groups/${id}/leave`, bob.cookie)).status).toBe(204);
    expect((await post(`/api/groups/${id}/members/${cat.id}/remove`, ann.cookie)).status).toBe(200);
    // Gone with balance 0: no longer listed.
    expect(Object.keys(await balancesOf(id, ann)).sort()).toEqual([ann.id, dan.id].sort());
    // Their expenses stay, under their names.
    const list = await json(await send(`/api/groups/${id}/expenses`, { cookie: dan.cookie }));
    expect(list.expenses.map((e: any) => e.paidByName).sort()).toEqual(["Ann", "Bob", "Cat", "Dan"]);
    // And they can't be put in new ones.
    expect((await addExpense(id, ann, { amount: 100, paidBy: bob, participants: [ann] })).status).toBe(400);
  });

  it("deleting a settled group deletes its expenses and log", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    await addExpense(id, ann, { amount: 1000, paidBy: ann, participants: [ann, bob] });
    await addExpense(id, bob, { amount: 500, paidBy: bob, participants: [ann] });
    expect((await post(`/api/groups/${id}/delete`, ann.cookie)).status).toBe(204);
    for (const table of ["expenses", "activity_log"])
      expect(
        await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE group_id = ?`).bind(id).first("n"),
        table,
      ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM expense_shares WHERE expense_id NOT IN (SELECT id FROM expenses)",
      ).first("n"),
    ).toBe(0);
  });
});
