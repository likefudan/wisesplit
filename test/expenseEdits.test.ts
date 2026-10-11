import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { json, makeUser, send } from "./helpers";

const post = (path: string, cookie: string, body: unknown = {}) => send(path, { cookie, body });

type Person = { id: string; email: string; cookie: string };

/** A group of `names.length` approved users; the first is its owner. */
async function makeGroup(names: string[], currency = "USD") {
  const people: Person[] = [];
  for (const name of names) people.push(await makeUser("approved", undefined, name));
  const owner = people[0]!;
  const group = (await json(await post("/api/groups", owner.cookie, { name: "Trip", currency }))).group;
  for (const p of people.slice(1))
    expect((await post(`/api/groups/${group.id}/members`, owner.cookie, { email: p.email })).status).toBe(200);
  return { id: group.id as string, people };
}

interface Fields {
  amount: number;
  paidBy: Person;
  participants: Person[];
  description?: string;
  date?: string;
  splitMethod?: string;
  /** By user id; see SplitParams in src/shared/expenses.ts. */
  splitParams?: Record<string, number>;
}

const body = (f: Fields) => ({
  description: f.description ?? "Dinner",
  amount: f.amount,
  paidBy: f.paidBy.id,
  date: f.date ?? "2026-10-01",
  splitMethod: f.splitMethod ?? "equal",
  participants: f.participants.map((p) => p.id),
  splitParams: f.splitParams ?? null,
});

async function addExpense(groupId: string, by: Person, f: Fields) {
  const res = await post(`/api/groups/${groupId}/expenses`, by.cookie, body(f));
  expect(res.status).toBe(200);
  return (await json(res)).expense;
}

const edit = (groupId: string, by: Person, expense: { id: string; version: number }, f: Fields) =>
  post(`/api/groups/${groupId}/expenses/${expense.id}`, by.cookie, { ...body(f), version: expense.version });

const del = (groupId: string, by: Person, expense: { id: string; version: number }) =>
  post(`/api/groups/${groupId}/expenses/${expense.id}/delete`, by.cookie, { version: expense.version });

const balancesOf = async (groupId: string, who: Person) =>
  Object.fromEntries(
    (await json(await send(`/api/groups/${groupId}/balances`, { cookie: who.cookie }))).balances.map((b: any) => [
      b.userId,
      b.net,
    ]),
  );

const activity = async (groupId: string, who: Person, before?: string) =>
  json(await send(`/api/groups/${groupId}/activity${before ? `?before=${before}` : ""}`, { cookie: who.cookie }));

const errorCode = async (res: Response) => (await json(res)).error.code;

describe("editing an expense", () => {
  it("any member changes any field; the log keeps what changed", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob", "Cat"]);
    const [ann, bob, cat] = people as [Person, Person, Person];
    const added = await addExpense(id, ann, { amount: 900, paidBy: ann, participants: [ann, bob, cat] });
    expect(added).toMatchObject({ version: 1, updatedAt: null });

    const res = await edit(id, cat, added, {
      amount: 1000,
      paidBy: bob,
      participants: [ann, bob],
      description: "Lunch",
      date: "2026-09-30",
    });
    expect(res.status).toBe(200);
    const { expense } = await json(res);
    expect(expense).toMatchObject({
      id: added.id,
      description: "Lunch",
      amount: 1000,
      paidBy: bob.id,
      paidByName: "Bob",
      date: "2026-09-30",
      version: 2,
      createdBy: ann.id,
      updatedAt: expect.any(String),
    });
    expect(expense.shares.map((s: any) => s.amount)).toEqual([500, 500]);
    expect(await json(await send(`/api/groups/${id}/expenses/${added.id}`, { cookie: ann.cookie }))).toEqual({
      expense,
    });
    expect(await balancesOf(id, ann)).toEqual({ [ann.id]: -500, [bob.id]: 500, [cat.id]: 0 });

    const { entries, names } = await activity(id, ann);
    expect(entries[0]).toMatchObject({ action: "expense.edited", actorId: cat.id, subjectId: added.id });
    expect(entries[0].data).toEqual({
      description: "Lunch",
      before: {
        description: "Dinner",
        amount: 900,
        paidBy: ann.id,
        date: "2026-10-01",
        shares: { [ann.id]: 300, [bob.id]: 300, [cat.id]: 300 },
      },
      after: {
        description: "Lunch",
        amount: 1000,
        paidBy: bob.id,
        date: "2026-09-30",
        shares: { [ann.id]: 500, [bob.id]: 500 },
      },
    });
    expect(names).toMatchObject({ [ann.id]: "Ann", [bob.id]: "Bob", [cat.id]: "Cat" });
  });

  it("logs only the fields that changed, and nothing when none did", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    const added = await addExpense(id, ann, { amount: 600, paidBy: ann, participants: [ann, bob] });
    const same = await edit(id, bob, added, { amount: 600, paidBy: ann, participants: [bob, ann] });
    expect(same.status).toBe(200);
    expect((await json(same)).expense.version).toBe(1);
    const res = await edit(id, bob, added, { amount: 600, paidBy: ann, participants: [ann, bob], description: "Pho" });
    expect((await json(res)).expense.version).toBe(2);
    const { entries } = await activity(id, ann);
    expect(entries.map((e: any) => e.action)).toEqual([
      "expense.edited",
      "expense.added",
      "member.added",
      "group.created",
    ]);
    expect(entries[0].data).toEqual({
      description: "Pho",
      before: { description: "Dinner" },
      after: { description: "Pho" },
    });
  });

  it("turns down a save based on an older version", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    const added = await addExpense(id, ann, { amount: 600, paidBy: ann, participants: [ann, bob] });
    // Both open the form at version 1; Bob saves first.
    expect((await edit(id, bob, added, { amount: 700, paidBy: ann, participants: [ann, bob] })).status).toBe(200);
    const res = await edit(id, ann, added, { amount: 800, paidBy: ann, participants: [ann, bob] });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("expense_changed");
    expect((await del(id, ann, added)).status).toBe(409);
    const now = await json(await send(`/api/groups/${id}/expenses/${added.id}`, { cookie: ann.cookie }));
    expect(now.expense).toMatchObject({ amount: 700, version: 2 });
    // With the version they now have, it goes through.
    expect((await edit(id, ann, now.expense, { amount: 800, paidBy: ann, participants: [ann, bob] })).status).toBe(200);
    const log = await env.DB.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE subject_id = ?")
      .bind(added.id)
      .first("n");
    expect(log).toBe(3);
  });

  it("only one of two saves at the same moment goes through", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    const added = await addExpense(id, ann, { amount: 600, paidBy: ann, participants: [ann, bob] });
    const results = await Promise.all([
      edit(id, ann, added, { amount: 700, paidBy: ann, participants: [ann, bob] }),
      edit(id, bob, added, { amount: 800, paidBy: bob, participants: [ann, bob] }),
      del(id, bob, added),
    ]);
    expect(results.map((r) => r.status).filter((s) => s === 200 || s === 204)).toHaveLength(1);
    const shares = await env.DB.prepare("SELECT SUM(amount) AS total FROM expense_shares WHERE expense_id = ?")
      .bind(added.id)
      .first<number>("total");
    const row = await env.DB.prepare("SELECT amount FROM expenses WHERE id = ?").bind(added.id).first<number>("amount");
    expect(shares).toBe(row);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE subject_id = ?").bind(added.id).first("n"),
    ).toBe(2);
  });

  it("checks the fields as when adding", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    const added = await addExpense(id, ann, { amount: 600, paidBy: ann, participants: [ann, bob] });
    const path = `/api/groups/${id}/expenses/${added.id}`;
    const good = { ...body({ amount: 600, paidBy: ann, participants: [ann, bob] }), version: 1 };
    for (const [change, code] of [
      [{ amount: 0 }, "invalid_amount"],
      [{ description: "" }, "invalid_description"],
      [{ participants: [] }, "invalid_participants"],
      [{ version: undefined }, "invalid_version"],
      [{ version: 0 }, "invalid_version"],
      [{ version: "1" }, "invalid_version"],
    ] as const) {
      const res = await post(path, ann.cookie, { ...good, ...change });
      expect(res.status, JSON.stringify(change)).toBe(400);
      expect(await errorCode(res), JSON.stringify(change)).toBe(code);
    }
    const outsider = await makeUser("approved");
    const res = await post(path, ann.cookie, { ...good, participants: [ann.id, outsider.id] });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("not_in_group");
    expect((await post(path, outsider.cookie, good)).status).toBe(404);
    expect((await send(path, { cookie: outsider.cookie })).status).toBe(404);
    // Nothing changed.
    expect((await json(await send(path, { cookie: bob.cookie }))).expense).toEqual(added);
  });

  it("an expense from another group is not found", async () => {
    const a = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = a.people as [Person, Person];
    const b = await makeGroup(["Ann2"]);
    const [ann2] = b.people as [Person];
    const added = await addExpense(a.id, ann, { amount: 600, paidBy: ann, participants: [ann, bob] });
    const res = await edit(b.id, ann2, added, { amount: 100, paidBy: ann2, participants: [ann2] });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("expense_not_found");
    expect((await del(b.id, ann2, added)).status).toBe(404);
    expect((await send(`/api/groups/${b.id}/expenses/${added.id}`, { cookie: ann2.cookie })).status).toBe(404);
  });
});

describe("deleting an expense", () => {
  it("takes it out of the list and balances, keeps it in the log", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    const keep = await addExpense(id, ann, { amount: 400, paidBy: ann, participants: [ann, bob] });
    const gone = await addExpense(id, ann, { amount: 1000, paidBy: bob, participants: [ann, bob] });
    expect(await balancesOf(id, ann)).toEqual({ [ann.id]: -300, [bob.id]: 300 });

    expect((await del(id, bob, gone)).status).toBe(204);
    expect(await balancesOf(id, ann)).toEqual({ [ann.id]: 200, [bob.id]: -200 });
    const list = await json(await send(`/api/groups/${id}/expenses`, { cookie: ann.cookie }));
    expect(list.expenses.map((e: any) => e.id)).toEqual([keep.id]);
    expect((await send(`/api/groups/${id}/expenses/${gone.id}`, { cookie: ann.cookie })).status).toBe(404);
    // Gone for editing, and deleting twice.
    let res = await edit(id, ann, gone, { amount: 5, paidBy: ann, participants: [ann] });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("expense_not_found");
    res = await del(id, ann, gone);
    expect(res.status).toBe(404);

    const { entries } = await activity(id, ann);
    expect(entries[0]).toMatchObject({ action: "expense.deleted", actorId: bob.id, subjectId: gone.id });
    expect(entries[0].data).toEqual({
      description: "Dinner",
      amount: 1000,
      paidBy: bob.id,
      date: "2026-10-01",
      splitMethod: "equal",
      splitParams: null,
      shares: { [ann.id]: 500, [bob.id]: 500 },
    });
    // The row stays, marked.
    const row = await env.DB.prepare("SELECT deleted_at, deleted_by FROM expenses WHERE id = ?")
      .bind(gone.id)
      .first<any>();
    expect(row.deleted_by).toBe(bob.id);
  });

  it("no longer counts toward leaving or deleting the group", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    const added = await addExpense(id, ann, { amount: 1000, paidBy: ann, participants: [ann, bob] });
    expect((await post(`/api/groups/${id}/leave`, bob.cookie)).status).toBe(409);
    expect((await del(id, ann, added)).status).toBe(204);
    expect((await post(`/api/groups/${id}/leave`, bob.cookie)).status).toBe(204);
    expect((await post(`/api/groups/${id}/delete`, ann.cookie)).status).toBe(204);
  });

  it("a page of the list still continues after an expense deleted since", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    const all = [];
    for (let i = 0; i < 22; i++)
      all.push(
        await addExpense(id, ann, {
          amount: 100,
          paidBy: ann,
          participants: [ann, bob],
          date: `2026-01-${String(i + 1).padStart(2, "0")}`,
        }),
      );
    const first = await json(await send(`/api/groups/${id}/expenses`, { cookie: ann.cookie }));
    const last = first.expenses[19];
    expect((await del(id, ann, last)).status).toBe(204);
    const second = await json(
      await send(`/api/groups/${id}/expenses?before=${encodeURIComponent(first.next)}`, { cookie: ann.cookie }),
    );
    expect(second.expenses.map((e: any) => e.date)).toEqual(["2026-01-02", "2026-01-01"]);
  });

  it("a page of the list continues where the last one ended, though its last expense moved", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    for (let i = 0; i < 22; i++)
      await addExpense(id, ann, {
        amount: 100,
        paidBy: ann,
        participants: [ann, bob],
        date: `2026-01-${String(i + 1).padStart(2, "0")}`,
      });
    const first = await json(await send(`/api/groups/${id}/expenses`, { cookie: ann.cookie }));
    const last = first.expenses[19];
    expect(last.date).toBe("2026-01-03");
    expect(
      (await edit(id, bob, last, { amount: 100, paidBy: ann, participants: [ann, bob], date: "2025-06-01" })).status,
    ).toBe(200);
    const second = await json(
      await send(`/api/groups/${id}/expenses?before=${encodeURIComponent(first.next)}`, { cookie: ann.cookie }),
    );
    expect(second.expenses.map((e: any) => e.date)).toEqual(["2026-01-02", "2026-01-01", "2025-06-01"]);
  });
});

describe("expenses with someone who has left", () => {
  /** Ann, Bob and Cat share one expense, settle up, and Cat leaves. */
  async function setUp() {
    const { id, people } = await makeGroup(["Ann", "Bob", "Cat"]);
    const [ann, bob, cat] = people as [Person, Person, Person];
    const dinner = await addExpense(id, ann, { amount: 900, paidBy: ann, participants: [ann, bob, cat] });
    await addExpense(id, bob, { amount: 300, paidBy: bob, participants: [ann] });
    await addExpense(id, cat, { amount: 300, paidBy: cat, participants: [ann] });
    expect(await balancesOf(id, ann)).toEqual({ [ann.id]: 0, [bob.id]: 0, [cat.id]: 0 });
    expect((await post(`/api/groups/${id}/leave`, cat.cookie)).status).toBe(204);
    return { id, ann, bob, cat, dinner };
  }

  it("can still be edited where it leaves them as they were", async () => {
    const { id, ann, bob, cat, dinner } = await setUp();
    const res = await edit(id, bob, dinner, {
      amount: 900,
      paidBy: ann,
      participants: [ann, bob, cat],
      description: "Dinner out",
    });
    expect(res.status).toBe(200);
    expect((await json(res)).expense.shares.map((s: any) => s.name).sort()).toEqual(["Ann", "Bob", "Cat"]);
  });

  it("but not to change what they owe, nor deleted", async () => {
    const { id, ann, bob, cat, dinner } = await setUp();
    for (const f of [
      { amount: 1200, paidBy: ann, participants: [ann, bob, cat] },
      { amount: 900, paidBy: ann, participants: [ann, bob] },
      { amount: 900, paidBy: cat, participants: [ann, bob, cat] },
    ]) {
      const res = await edit(id, bob, dinner, f);
      expect(res.status).toBe(409);
      expect(await errorCode(res)).toBe("former_member_involved");
    }
    const res = await del(id, ann, dinner);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("former_member_involved");
    expect(await balancesOf(id, ann)).toEqual({ [ann.id]: 0, [bob.id]: 0 });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE subject_id = ? AND action != 'expense.added'")
        .bind(dinner.id)
        .first("n"),
    ).toBe(0);
  });

  it("one that leaves them even can be deleted", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    // Bob paid for himself alone: it neither owes him nor makes him owe.
    const added = await addExpense(id, bob, { amount: 600, paidBy: bob, participants: [bob] });
    expect((await post(`/api/groups/${id}/leave`, bob.cookie)).status).toBe(204);
    expect((await del(id, ann, added)).status).toBe(204);
  });
});

describe("editing with each way of splitting", () => {
  const sharesOf = (expense: any) => Object.fromEntries(expense.shares.map((s: any) => [s.userId, s.amount]));

  it("moves an expense from one split method to the next, logging the split each time", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob", "Cat"]);
    const [ann, bob, cat] = people as [Person, Person, Person];
    let expense = await addExpense(id, ann, { amount: 1000, paidBy: ann, participants: [ann, bob, cat] });
    const steps: [Fields, Record<string, number>][] = [
      [
        {
          amount: 1000,
          paidBy: ann,
          participants: [ann, bob],
          splitMethod: "exact",
          splitParams: { [ann.id]: 300, [bob.id]: 700 },
        },
        { [ann.id]: 300, [bob.id]: 700 },
      ],
      [
        {
          amount: 1000,
          paidBy: ann,
          participants: [bob, cat],
          splitMethod: "percent",
          splitParams: { [bob.id]: 2500, [cat.id]: 7500 },
        },
        { [bob.id]: 250, [cat.id]: 750 },
      ],
      [
        {
          amount: 1200,
          paidBy: bob,
          participants: [ann, bob, cat],
          splitMethod: "shares",
          splitParams: { [ann.id]: 1, [bob.id]: 2, [cat.id]: 3 },
        },
        { [ann.id]: 200, [bob.id]: 400, [cat.id]: 600 },
      ],
      [
        {
          amount: 1200,
          paidBy: bob,
          participants: [ann, bob, cat],
          splitMethod: "adjust",
          splitParams: { [cat.id]: 300 },
        },
        { [ann.id]: 300, [bob.id]: 300, [cat.id]: 600 },
      ],
      [
        { amount: 1200, paidBy: bob, participants: [ann, bob, cat] },
        { [ann.id]: 400, [bob.id]: 400, [cat.id]: 400 },
      ],
    ];
    for (const [fields, shares] of steps) {
      const res = await edit(id, cat, expense, fields);
      expect(res.status, fields.splitMethod).toBe(200);
      const previous = expense;
      expense = (await json(res)).expense;
      expect(expense.splitMethod).toBe(fields.splitMethod ?? "equal");
      expect(expense.splitParams).toEqual(fields.splitParams ?? null);
      expect(sharesOf(expense)).toEqual(shares);
      // As the edit form will load it again.
      expect(
        (await json(await send(`/api/groups/${id}/expenses/${expense.id}`, { cookie: bob.cookie }))).expense,
      ).toEqual(expense);
      const { entries } = await activity(id, ann);
      expect(entries[0].data.before).toMatchObject({
        splitMethod: previous.splitMethod,
        shares: sharesOf(previous),
      });
      expect(entries[0].data.after).toMatchObject({ splitMethod: expense.splitMethod, shares });
      expect(entries[0].data.before.splitParams ?? null).toEqual(previous.splitParams);
      expect(entries[0].data.after.splitParams ?? null).toEqual(expense.splitParams);
    }
    expect(await balancesOf(id, ann)).toEqual({ [ann.id]: -400, [bob.id]: 800, [cat.id]: -400 });
  });

  it("logs a change of percentages alone, and nothing for the same split sent again", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    const split = { amount: 1000, paidBy: ann, participants: [ann, bob], splitMethod: "percent" };
    const added = await addExpense(id, ann, { ...split, splitParams: { [ann.id]: 5000, [bob.id]: 5000 } });
    const same = await edit(id, bob, added, { ...split, splitParams: { [bob.id]: 5000, [ann.id]: 5000 } });
    expect((await json(same)).expense.version).toBe(1);
    const res = await edit(id, bob, added, { ...split, splitParams: { [ann.id]: 3000, [bob.id]: 7000 } });
    expect(res.status).toBe(200);
    const { entries } = await activity(id, ann);
    expect(entries[0].data).toEqual({
      description: "Dinner",
      before: { splitParams: { [ann.id]: 5000, [bob.id]: 5000 }, shares: { [ann.id]: 500, [bob.id]: 500 } },
      after: { splitParams: { [ann.id]: 3000, [bob.id]: 7000 }, shares: { [ann.id]: 300, [bob.id]: 700 } },
    });
  });

  it("checks the split as when adding, and changes nothing when it doesn't add up", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    const added = await addExpense(id, ann, { amount: 1000, paidBy: ann, participants: [ann, bob] });
    for (const [fields, code] of [
      [{ splitMethod: "exact", splitParams: { [ann.id]: 300, [bob.id]: 600 } }, "split_exact_total"],
      [{ splitMethod: "percent", splitParams: { [ann.id]: 3000, [bob.id]: 6000 } }, "split_percent_total"],
      [{ splitMethod: "shares", splitParams: { [ann.id]: 0, [bob.id]: 1 } }, "invalid_split"],
      [{ splitMethod: "adjust", splitParams: { [ann.id]: 1500 } }, "split_adjust_too_large"],
      [{ splitMethod: "equal", splitParams: { [ann.id]: 1 } }, "invalid_split"],
    ] as const) {
      const res = await edit(id, bob, added, { amount: 1000, paidBy: ann, participants: [ann, bob], ...fields });
      expect(res.status, fields.splitMethod).toBe(400);
      expect(await errorCode(res), fields.splitMethod).toBe(code);
    }
    expect((await json(await send(`/api/groups/${id}/expenses/${added.id}`, { cookie: bob.cookie }))).expense).toEqual(
      added,
    );
  });

  it("keeps someone who has left as they were in a split by shares", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob", "Cat"]);
    const [ann, bob, cat] = people as [Person, Person, Person];
    const split = { paidBy: ann, participants: [ann, bob, cat], splitMethod: "shares" };
    const dinner = await addExpense(id, ann, {
      ...split,
      amount: 1200,
      splitParams: { [ann.id]: 1, [bob.id]: 1, [cat.id]: 2 },
    });
    await addExpense(id, cat, { amount: 600, paidBy: cat, participants: [ann] });
    await addExpense(id, bob, { amount: 300, paidBy: bob, participants: [ann] });
    expect((await post(`/api/groups/${id}/leave`, cat.cookie)).status).toBe(204);
    // Bob takes more shares: Cat's part of the 12.00 changes, so no.
    let res = await edit(id, bob, dinner, {
      ...split,
      amount: 1200,
      splitParams: { [ann.id]: 1, [bob.id]: 3, [cat.id]: 2 },
    });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("former_member_involved");
    // The same 6.00 for Cat, as an exact amount: allowed.
    res = await edit(id, bob, dinner, {
      ...split,
      amount: 1200,
      splitMethod: "exact",
      splitParams: { [ann.id]: 200, [bob.id]: 400, [cat.id]: 600 },
    });
    expect(res.status).toBe(200);
    // Bob now pays 1.00 more of it, to Ann; Cat is still even.
    expect(await balancesOf(id, ann)).toEqual({ [ann.id]: 100, [bob.id]: -100 });
  });

  it("a deleted adjusted expense keeps its split in the log", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    const added = await addExpense(id, ann, {
      amount: 1000,
      paidBy: ann,
      participants: [ann, bob],
      splitMethod: "adjust",
      splitParams: { [bob.id]: -200 },
    });
    expect((await del(id, bob, added)).status).toBe(204);
    const { entries } = await activity(id, ann);
    expect(entries[0].data).toMatchObject({
      splitMethod: "adjust",
      splitParams: { [bob.id]: -200 },
      shares: { [ann.id]: 600, [bob.id]: 400 },
    });
    expect(await balancesOf(id, ann)).toEqual({ [ann.id]: 0, [bob.id]: 0 });
  });
});

describe("the activity log", () => {
  it("records joins, adds, leaves and removals", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob", "Cat"]);
    const [ann, bob, cat] = people as [Person, Person, Person];
    expect((await post(`/api/groups/${id}/leave`, bob.cookie)).status).toBe(204);
    expect((await post(`/api/groups/${id}/members/${cat.id}/remove`, ann.cookie)).status).toBe(200);
    // Not removed (not a member): nothing logged.
    expect((await post(`/api/groups/${id}/members/${cat.id}/remove`, ann.cookie)).status).toBe(404);
    expect((await post(`/api/groups/${id}/leave`, bob.cookie)).status).toBe(404);

    // Joins through an invite link.
    const { token } = await json(await post(`/api/groups/${id}/invites`, ann.cookie));
    const dan = await makeUser("approved", undefined, "Dan");
    expect((await post(`/api/invites/${token}/accept`, dan.cookie)).status).toBe(200);

    const { entries, names, next } = await activity(id, ann);
    expect(next).toBeNull();
    expect(entries.map((e: any) => [e.action, e.actorId, e.subjectId])).toEqual([
      ["member.joined", dan.id, dan.id],
      ["member.removed", ann.id, cat.id],
      ["member.left", bob.id, bob.id],
      ["member.added", ann.id, cat.id],
      ["member.added", ann.id, bob.id],
      ["group.created", ann.id, null],
    ]);
    expect(entries[0].data).toEqual({ invitedBy: ann.id });
    expect(entries.at(-1).data).toEqual({ name: "Trip", currency: "USD" });
    expect(names).toEqual({ [ann.id]: "Ann", [bob.id]: "Bob", [cat.id]: "Cat", [dan.id]: "Dan" });
  });

  it("does not log a leave the group's balances refuse", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    await addExpense(id, ann, { amount: 1000, paidBy: ann, participants: [ann, bob] });
    expect((await post(`/api/groups/${id}/leave`, bob.cookie)).status).toBe(409);
    expect((await post(`/api/groups/${id}/members/${bob.id}/remove`, ann.cookie)).status).toBe(409);
    const { entries } = await activity(id, ann);
    expect(entries.map((e: any) => e.action)).toEqual(["expense.added", "member.added", "group.created"]);
  });

  it("records a new user signing up through an invite link", async () => {
    const { id, people } = await makeGroup(["Ann"]);
    const [ann] = people as [Person];
    const { token } = await json(await post(`/api/groups/${id}/invites`, ann.cookie));
    const { registerByInvite } = await import("../src/worker/invites");
    const { user } = await registerByInvite(
      env as any,
      { google_sub: `sub-${crypto.randomUUID()}`, email: "new@example.com", picture: null } as any,
      { name: "Newt", lang: "en" },
      token,
    );
    const { entries, names } = await activity(id, ann);
    expect(entries[0]).toMatchObject({ action: "member.joined", actorId: user.id, data: { invitedBy: ann.id } });
    expect(names[user.id]).toBe("Newt");
  });

  it("pages newest first and is for members only", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    for (let i = 0; i < 25; i++)
      await addExpense(id, ann, { amount: 100 + i, paidBy: ann, participants: [ann, bob], description: `E${i}` });
    const first = await activity(id, bob);
    expect(first.entries).toHaveLength(20);
    expect(first.entries[0].data.description).toBe("E24");
    const second = await activity(id, bob, first.next);
    expect(second.entries).toHaveLength(7);
    expect(second.next).toBeNull();
    expect(new Set([...first.entries, ...second.entries].map((e: any) => e.id)).size).toBe(27);
    expect(second.entries.at(-1).action).toBe("group.created");
    expect((await send(`/api/groups/${id}/activity?before=nope`, { cookie: bob.cookie })).status).toBe(400);

    const outsider = await makeUser("approved");
    expect((await send(`/api/groups/${id}/activity`, { cookie: outsider.cookie })).status).toBe(404);
    expect((await send(`/api/groups/${id}/activity`)).status).toBe(401);
  });
});
