import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { attachment, csvField, dayIn, timeZoneOf } from "../src/worker/export";
import { json, makeUser, send } from "./helpers";

const post = (path: string, cookie: string, body: unknown = {}) => send(path, { cookie, body });

type Person = { id: string; email: string; cookie: string };

async function makeGroup(names: string[], groupName = "Camping weekend", currency = "USD") {
  const people: Person[] = [];
  for (const name of names) people.push(await makeUser("approved", undefined, name));
  const owner = people[0]!;
  const group = (await json(await post("/api/groups", owner.cookie, { name: groupName, currency }))).group;
  for (const p of people.slice(1))
    expect((await post(`/api/groups/${group.id}/members`, owner.cookie, { email: p.email })).status).toBe(200);
  return { id: group.id as string, people };
}

async function addExpense(
  groupId: string,
  paidBy: Person,
  amount: number,
  participants: Person[],
  extra: Record<string, unknown> = {},
) {
  const res = await post(`/api/groups/${groupId}/expenses`, paidBy.cookie, {
    description: "Dinner",
    amount,
    paidBy: paidBy.id,
    date: "2026-10-01",
    splitMethod: "equal",
    participants: participants.map((p) => p.id),
    ...extra,
  });
  expect(res.status).toBe(200);
  return (await json(res)).expense;
}

async function pay(groupId: string, from: Person, to: Person, amount: number) {
  const res = await post(`/api/groups/${groupId}/payments`, from.cookie, {
    from: from.id,
    to: to.id,
    amount,
    method: "other",
  });
  expect(res.status).toBe(200);
  return (await json(res)).payment.id as string;
}

const decide = (groupId: string, by: Person, paymentId: string, action: string) =>
  post(`/api/groups/${groupId}/payments/${paymentId}/${action}`, by.cookie);

/** The export as `who`, its body split into rows of fields (none of the fields here are quoted). */
async function exportOf(groupId: string, who: Person, query = "") {
  const res = await send(`/api/groups/${groupId}/export.csv${query}`, { cookie: who.cookie });
  expect(res.status).toBe(200);
  // res.text() would drop the byte order mark, which is part of what is checked.
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await res.arrayBuffer());
  return {
    res,
    text,
    rows: text
      .replace(/^\uFEFF/, "")
      .trimEnd()
      .split("\r\n")
      .map((r) => r.split(",")),
  };
}

describe("CSV export", () => {
  it("lists expenses and confirmed payments, oldest first, with a column per person", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob", "Cat"]);
    const [ann, bob, cat] = people as [Person, Person, Person];
    await addExpense(id, ann, 3000, [ann, bob, cat], { date: "2026-10-03", description: "Groceries" });
    await addExpense(id, bob, 1001, [ann, bob, cat], { date: "2026-10-01", description: "Gas" });
    await addExpense(id, cat, 900, [bob, cat], {
      date: "2026-10-02",
      description: "Firewood",
      splitMethod: "exact",
      splitParams: { [bob.id]: 600, [cat.id]: 300 },
    });
    // Deleted expenses, and payments that don't count, are left out.
    const gone = await addExpense(id, ann, 500, [ann, bob], { description: "Mistake" });
    expect(
      (await post(`/api/groups/${id}/expenses/${gone.id}/delete`, ann.cookie, { version: gone.version })).status,
    ).toBe(204);
    await pay(id, cat, ann, 700); // still pending
    expect((await decide(id, ann, await pay(id, bob, ann, 300), "decline")).status).toBe(200);
    const confirmed = await pay(id, cat, ann, 1000);
    expect((await decide(id, ann, confirmed, "confirm")).status).toBe(200);
    const paidOn = dayIn("UTC")(new Date());

    const { res, text, rows } = await exportOf(id, bob, "?lang=en&tz=UTC");
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="Camping weekend-${paidOn}.csv"; filename*=UTF-8''Camping%20weekend-${paidOn}.csv`,
    );
    expect(text.startsWith("\uFEFFDate,")).toBe(true);
    expect(rows).toEqual([
      ["Date", "Description", "Type", "Paid by", "Total", "Currency", "Ann", "Bob", "Cat"],
      // 10.01 split three ways: the extra cent goes by the smallest user id, so look it up.
      expect.arrayContaining(["2026-10-01", "Gas", "Expense", "Bob", "10.01", "USD"]),
      ["2026-10-02", "Firewood", "Expense", "Cat", "9.00", "USD", "", "6.00", "3.00"],
      ["2026-10-03", "Groceries", "Expense", "Ann", "30.00", "USD", "10.00", "10.00", "10.00"],
      [paidOn, "Cat paid Ann", "Payment", "Cat", "10.00", "USD", "10.00", "", ""],
    ]);
    const gas = rows[1]!.slice(6).map(Number);
    expect(gas.reduce((a, b) => a + b, 0)).toBeCloseTo(10.01);
    expect(gas.sort()).toEqual([3.33, 3.34, 3.34]);
  });

  it("is headed in the language asked for, else the user's own", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    await addExpense(id, ann, 1000, [ann, bob]);
    expect((await exportOf(id, ann, "?lang=zh")).rows.slice(0, 2)).toEqual([
      ["日期", "说明", "类型", "付款人", "金额", "货币", "Ann", "Bob"],
      ["2026-10-01", "Dinner", "账目", "Ann", "10.00", "USD", "5.00", "5.00"],
    ]);
    await env.DB.prepare("UPDATE users SET lang = 'zh' WHERE id = ?").bind(ann.id).run();
    expect((await exportOf(id, ann)).rows[0]![0]).toBe("日期");
    expect((await exportOf(id, ann, "?lang=xx")).rows[0]![0]).toBe("日期");
  });

  it("writes amounts in the currency's own decimals", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"], "Tokyo", "JPY");
    const [ann, bob] = people as [Person, Person];
    await addExpense(id, ann, 1001, [ann, bob]);
    const { rows } = await exportOf(id, ann);
    expect(rows[1]!.slice(4, 6)).toEqual(["1001", "JPY"]);
    expect(rows[1]!.slice(6).sort()).toEqual(["500", "501"]);
  });

  it("dates a payment by the day it was made in the time zone asked for", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"]);
    const [ann, bob] = people as [Person, Person];
    await addExpense(id, ann, 1000, [ann, bob]);
    const paymentId = await pay(id, bob, ann, 500);
    expect((await decide(id, ann, paymentId, "confirm")).status).toBe(200);
    // 03:00 UTC on 5 October is the evening of 4 October in Los Angeles.
    await env.DB.prepare("UPDATE settlements SET created_at = '2026-10-05T03:00:00.000Z' WHERE id = ?")
      .bind(paymentId)
      .run();
    expect((await exportOf(id, ann, "?tz=UTC")).rows[2]![0]).toBe("2026-10-05");
    expect((await exportOf(id, ann, "?tz=America/Los_Angeles")).rows[2]![0]).toBe("2026-10-04");
    expect((await exportOf(id, ann, "?tz=Not/AZone")).rows[2]![0]).toBe("2026-10-05");
  });

  it("keeps a column for someone who has left, and tells apart people with the same name", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob", "Ann", "Ann (2)"]);
    const [ann, bob, ann2, ann3] = people as [Person, Person, Person, Person];
    await addExpense(id, ann2, 1000, [ann2, bob]);
    expect((await decide(id, ann2, await pay(id, bob, ann2, 500), "confirm")).status).toBe(200);
    expect((await post(`/api/groups/${id}/leave`, bob.cookie)).status).toBe(204);
    const { rows } = await exportOf(id, ann3, "?lang=en");
    // Each person is called the same in the heading and in the rows, and no two alike.
    expect(rows[0]!.slice(6)).toEqual(["Ann", "Ann (2)", "Ann (2) (2)", "Bob (left)"]);
    expect(rows[1]!.slice(3)).toEqual(["Ann (2)", "10.00", "USD", "", "5.00", "", "5.00"]);
    expect(rows[2]!.slice(1)).toEqual([
      "Bob (left) paid Ann (2)",
      "Payment",
      "Bob (left)",
      "5.00",
      "USD",
      "",
      "5.00",
      "",
      "",
    ]);
    expect((await exportOf(id, ann, "?lang=zh")).rows[0]!.slice(6)).toEqual([
      "Ann",
      "Ann (2)",
      "Ann (2) (2)",
      "Bob（已退出）",
    ]);
  });

  it("quotes what needs quoting and defuses spreadsheet formulas", async () => {
    const { id, people } = await makeGroup(["Ann", "Bob"], 'Trip: "2026"');
    const [ann, bob] = people as [Person, Person];
    await addExpense(id, ann, 1000, [ann, bob], { description: '=HYPERLINK("x"), "fun"' });
    const { res, text } = await exportOf(id, ann);
    expect(text).toContain(`\r\n2026-10-01,"'=HYPERLINK(""x""), ""fun""",Expense,`);
    expect(res.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="Trip_ _2026_-[\d-]+\.csv"; filename\*=UTF-8''Trip_%20_2026_-[\d-]+\.csv$/,
    );
  });

  it("is only for the group's members", async () => {
    const { id } = await makeGroup(["Ann"]);
    const outsider = await makeUser("approved");
    const res = await send(`/api/groups/${id}/export.csv`, { cookie: outsider.cookie });
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe("group_not_found");
    expect((await send(`/api/groups/${id}/export.csv`)).status).toBe(401);
    const pending = await makeUser("pending");
    expect((await send(`/api/groups/${id}/export.csv`, { cookie: pending.cookie })).status).toBe(403);
  });
});

describe("CSV helpers", () => {
  it("quotes fields and defuses formulas", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
    for (const lead of ["=", "+", "-", "@", "\t"]) expect(csvField(`${lead}1`)).toBe(`'${lead}1`);
    expect(csvField("\r1")).toBe(`"'\r1"`);
    expect(csvField("  =1")).toBe("'  =1");
    expect(csvField("＝1+1")).toBe("'＝1+1");
    expect(csvField("12.50")).toBe("12.50");
  });

  it("names the file after the group, safely", () => {
    expect(attachment("周末露营", "2026-10-11")).toBe(
      `attachment; filename="____-2026-10-11.csv"; filename*=UTF-8''%E5%91%A8%E6%9C%AB%E9%9C%B2%E8%90%A5-2026-10-11.csv`,
    );
    expect(attachment("a/b\\c", "2026-10-11")).toContain('filename="a_b_c-2026-10-11.csv"');
    expect(attachment("it's (fun)", "2026-10-11")).toContain("filename*=UTF-8''it%27s%20%28fun%29-2026-10-11.csv");
  });

  it("reads time zones and days", () => {
    expect(timeZoneOf("Asia/Shanghai")).toBe("Asia/Shanghai");
    expect(timeZoneOf(undefined)).toBe("UTC");
    expect(timeZoneOf("nope")).toBe("UTC");
    expect(dayIn("Asia/Shanghai")(new Date("2026-10-04T20:00:00Z"))).toBe("2026-10-05");
  });
});
