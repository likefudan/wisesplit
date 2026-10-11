import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMAILS_PER_DAY, notificationEmail, SIGNUP_RESERVE } from "../src/worker/email";
import { now } from "../src/worker/http";
import { notify } from "../src/worker/notifications";
import type { Env } from "../src/worker/env";
import { admin, json, makeUser, ORIGIN, send } from "./helpers";

afterEach(async () => {
  vi.restoreAllMocks();
  // Each test starts with the whole day's allowance.
  await env.DB.prepare("DELETE FROM email_days").run();
});

/** A site that can send email. */
const MAIL: Partial<Env> = { RESEND_API_KEY: "re_test", EMAIL_FROM: "wisesplit <notify@llmat.dev>" };

const post = (path: string, cookie: string, body: unknown = {}, extra: Partial<Env> = MAIL) =>
  send(path, { cookie, body, env: extra });

type Person = { id: string; email: string; cookie: string };

/** An address that can get mail (unlike example.com, which `sendEmail` skips). Nothing is sent: fetch is mocked. */
const mailbox = (name: string) => `${name}-${crypto.randomUUID().slice(0, 8)}@gmail.com`;

async function person(name: string, lang: "en" | "zh" = "en", status: "approved" | "pending" = "approved") {
  const p = await makeUser(status, mailbox(name.toLowerCase()), name);
  await env.DB.prepare("UPDATE users SET lang = ? WHERE id = ?").bind(lang, p.id).run();
  return p;
}

/** A group of the given people (the first owns it), added without emailing anyone. */
async function makeGroup(people: Person[], name = "Camping weekend", currency = "USD") {
  const [owner, ...rest] = people;
  const group = (await json(await post("/api/groups", owner!.cookie, { name, currency }, {}))).group;
  for (const p of rest)
    expect((await post(`/api/groups/${group.id}/members`, owner!.cookie, { email: p.email }, {})).status).toBe(200);
  // Being added is a notification of its own; start each test from none.
  await env.DB.prepare("DELETE FROM notifications WHERE group_id = ?").bind(group.id).run();
  return group.id as string;
}

const expenseBody = (paidBy: Person, amount: number, participants: Person[], description = "Dinner") => ({
  description,
  amount,
  paidBy: paidBy.id,
  date: "2026-10-01",
  splitMethod: "equal",
  participants: participants.map((p) => p.id),
});

type Sent = { to: string[]; from: string; subject: string; text: string; html: string };

/** Catches what would go to Resend; `answer` is how Resend replies. */
function mockResend(answer: () => Promise<Response> = async () => Response.json({ data: [{ id: "email-id" }] })) {
  const sent: Sent[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== "https://api.resend.com/emails/batch") throw new Error(`unexpected fetch ${url}`);
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer re_test");
    expect(headers.get("x-batch-validation")).toBe("permissive");
    sent.push(...JSON.parse(String(init?.body)));
    return answer();
  });
  return { sent, spy };
}

const kindsOf = async (who: Person) =>
  (await json(await send("/api/notifications", { cookie: who.cookie }))).notifications.map((n: any) => n.kind);

describe("email notifications", () => {
  it("emails everyone an expense involves, in their own language, but not whoever added it", async () => {
    const ann = await person("Ann", "zh");
    const bob = await person("Bob");
    const cat = await person("Cat");
    const dan = await person("Dan");
    const id = await makeGroup([ann, bob, cat, dan]);
    const { sent, spy } = mockResend();
    // Bob adds what Ann paid for Ann, Bob and Cat; Dan is not in it.
    expect((await post(`/api/groups/${id}/expenses`, bob.cookie, expenseBody(ann, 3000, [ann, bob, cat]))).status).toBe(
      200,
    );

    // Both in one request (Resend's free tier allows only a couple a second).
    expect(spy).toHaveBeenCalledTimes(1);
    expect(sent.map((m) => m.to[0]).sort()).toEqual([ann.email, cat.email].sort());
    const toAnn = sent.find((m) => m.to[0] === ann.email)!;
    expect(toAnn.from).toBe("wisesplit <notify@llmat.dev>");
    expect(toAnn.subject).toBe("Camping weekend: Bob 记了一笔“Dinner”（US$30.00），由 你 付款");
    expect(toAnn.text).toContain("你的份额：US$10.00");
    expect(toAnn.text).toContain(`${ORIGIN}/groups/${id}`);
    expect(toAnn.text).toContain(`${ORIGIN}/notifications/settings`);
    const toCat = sent.find((m) => m.to[0] === cat.email)!;
    expect(toCat.subject).toBe("Camping weekend: Bob added “Dinner” ($30.00), paid by Ann");
    expect(toCat.text).toContain("Your share: $10.00");
    expect(toCat.html).toContain(`href="${ORIGIN}/groups/${id}"`);
  });

  it("emails payments, being added to a group, and the admin's answer to a sign-up", async () => {
    const ann = await person("Ann");
    const bob = await person("Bob");
    const id = await makeGroup([ann, bob]);
    const { sent } = mockResend();

    const paid = await post(`/api/groups/${id}/payments`, bob.cookie, {
      from: bob.id,
      to: ann.id,
      amount: 1500,
      method: "other",
    });
    expect(paid.status).toBe(200);
    expect(sent.at(-1)).toMatchObject({
      to: [ann.email],
      subject: expect.stringContaining("Bob says they paid you $15.00"),
    });
    const payment = (await json(paid)).payment;
    await post(`/api/groups/${id}/payments/${payment.id}/confirm`, ann.cookie);
    expect(sent.at(-1)).toMatchObject({
      to: [bob.email],
      subject: expect.stringContaining("Ann confirmed receiving your payment of $15.00"),
    });

    const cat = await person("Cat", "zh");
    await post(`/api/groups/${id}/members`, ann.cookie, { email: cat.email });
    expect(sent.at(-1)).toMatchObject({ to: [cat.email], subject: "Camping weekend: Ann 把你加入了群组" });

    const boss = await admin();
    const yes = await person("Yes", "en", "pending");
    const no = await person("No", "zh", "pending");
    await post(`/api/admin/users/${yes.id}/approve`, boss.cookie);
    expect(sent.at(-1)).toMatchObject({ to: [yes.email], subject: "Your sign-up was approved. Welcome!" });
    expect(sent.at(-1)!.text).toContain(`${ORIGIN}/`);
    await post(`/api/admin/users/${no.id}/reject`, boss.cookie);
    // A rejected applicant can't open the settings, so is only told they may apply again.
    const rejection = sent.at(-1)!;
    expect(rejection).toMatchObject({ to: [no.email], subject: "你的注册没有通过审核。" });
    expect(rejection.text).toContain(`你可以随时重新申请：${ORIGIN}/`);
    expect(rejection.text).not.toContain("/notifications/settings");
  });

  it("leaves out whoever turned email off, whatever their in-app setting", async () => {
    const ann = await person("Ann");
    const bob = await person("Bob");
    const cat = await person("Cat");
    const id = await makeGroup([ann, bob, cat]);
    expect(await json(await post("/api/notifications/settings", bob.cookie, { email: false }))).toEqual({
      settings: { inApp: true, email: false },
    });
    expect(await json(await post("/api/notifications/settings", cat.cookie, { inApp: false }))).toEqual({
      settings: { inApp: false, email: true },
    });
    expect((await post("/api/notifications/settings", bob.cookie, { email: "no", inApp: false })).status).toBe(400);
    expect(await json(await send("/api/notifications/settings", { cookie: bob.cookie }))).toEqual({
      settings: { inApp: true, email: false },
    });
    const { sent } = mockResend();
    await post(`/api/groups/${id}/expenses`, ann.cookie, expenseBody(ann, 3000, [ann, bob, cat]));
    expect(sent.map((m) => m.to[0])).toEqual([cat.email]);
    expect(await kindsOf(bob)).toContain("expense.added");
    expect(await kindsOf(cat)).toEqual([]);
  });

  it("never lets a failed email get in the way", async () => {
    const ann = await person("Ann");
    const bob = await person("Bob");
    const cat = await person("Cat");
    const id = await makeGroup([ann, bob, cat]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    // Resend refuses (the free tier's daily limit) …
    mockResend(async () => Response.json({ message: "Too many emails" }, { status: 429 }));
    const first = await post(`/api/groups/${id}/expenses`, ann.cookie, expenseBody(ann, 3000, [ann, bob, cat]));
    expect(first.status).toBe(200);
    expect(errors).toHaveBeenCalledWith("emails not sent:", 429, expect.stringContaining("Too many emails"));
    vi.mocked(globalThis.fetch).mockRestore();

    // … or can't be reached at all.
    mockResend(async () => {
      throw new TypeError("network down");
    });
    const second = await post(`/api/groups/${id}/expenses`, ann.cookie, expenseBody(ann, 1000, [ann, bob, cat]));
    expect(second.status).toBe(200);
    expect(errors).toHaveBeenCalledWith("emails not sent:", expect.any(TypeError));
    expect(await kindsOf(bob)).toEqual(["expense.added", "expense.added"]);
  });

  it("keeps within the day's allowance, holding some back for sign-up answers", async () => {
    const ann = await person("Ann");
    const bob = await person("Bob");
    const cat = await person("Cat");
    const id = await makeGroup([ann, bob, cat]);
    const { sent } = mockResend();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const today = now().slice(0, 10);
    const used = async () =>
      (await env.DB.prepare("SELECT count FROM email_days WHERE day = ?").bind(today).first<{ count: number }>())
        ?.count;

    await post(`/api/groups/${id}/expenses`, ann.cookie, expenseBody(ann, 3000, [ann, bob, cat]));
    expect(sent).toHaveLength(2);
    expect(await used()).toBe(2);

    // One short of the group allowance: an expense for two more is not emailed at all.
    await env.DB.prepare("UPDATE email_days SET count = ? WHERE day = ?")
      .bind(EMAILS_PER_DAY - SIGNUP_RESERVE - 1, today)
      .run();
    const res = await post(`/api/groups/${id}/expenses`, ann.cookie, expenseBody(ann, 3000, [ann, bob, cat]));
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith("daily email limit reached; 2 not sent");
    expect(await kindsOf(bob)).toEqual(["expense.added", "expense.added"]);

    // A sign-up answer may still use what was held back.
    const boss = await admin();
    const applicant = await person("Dee", "en", "pending");
    await post(`/api/admin/users/${applicant.id}/approve`, boss.cookie);
    expect(sent.at(-1)!.to).toEqual([applicant.email]);
    expect(await used()).toBe(EMAILS_PER_DAY - SIGNUP_RESERVE);
  });

  it("sends after the response when the request allows it", async () => {
    const ann = await person("Ann");
    const bob = await person("Bob");
    const id = await makeGroup([ann, bob]);
    const { sent } = mockResend();
    const later: Promise<unknown>[] = [];
    await notify(
      { ...env, ...MAIL },
      { kind: "member.added", actorId: ann.id, groupId: id, userId: bob.id },
      { waitUntil: (p) => later.push(p) },
    );
    expect(later).toHaveLength(1);
    // Under the bell at once; the email when the deferred work finishes.
    expect(await kindsOf(bob)).toEqual(["member.added"]);
    await Promise.all(later);
    expect(sent.map((m) => m.to[0])).toEqual([bob.email]);
  });

  it("sends nothing without Resend set up, or to an address that can't get mail", async () => {
    const ann = await person("Ann");
    const bob = await person("Bob");
    const tester = await makeUser("approved", `tester-${crypto.randomUUID().slice(0, 8)}@example.com`, "Tester");
    const id = await makeGroup([ann, bob, tester]);
    const { sent, spy } = mockResend();
    await post(`/api/groups/${id}/expenses`, ann.cookie, expenseBody(ann, 3000, [ann, bob]), {});
    await post(`/api/groups/${id}/expenses`, ann.cookie, expenseBody(ann, 3000, [ann, bob]), {
      RESEND_API_KEY: "re_test",
    });
    expect(spy).not.toHaveBeenCalled();
    await post(`/api/groups/${id}/expenses`, ann.cookie, expenseBody(ann, 3000, [ann, bob, tester]));
    expect(sent.map((m) => m.to[0])).toEqual([bob.email]);
  });
});

describe("notificationEmail", () => {
  const group = { id: "g1", name: "<b>Trip</b> & co", currency: "JPY" as const };
  const to = { id: "u2", email: "bob@gmail.com", lang: "en" as const };
  const names = { u1: "Ann <script>" };
  const note = {
    kind: "expense.deleted" as const,
    actorId: "u1",
    data: { description: `"Taxi" <img src=x>`, amount: 1200 },
  };

  it("escapes what people typed in the HTML, and keeps the plain text as typed", () => {
    const email = notificationEmail({ ...env, SITE_ORIGIN: "https://wisesplit.llmat.dev" }, to, note, group, names)!;
    expect(email.subject).toBe(`<b>Trip</b> & co: Ann <script> deleted “"Taxi" <img src=x>” (¥1,200)`);
    expect(email.text).toContain(`Ann <script> deleted “"Taxi" <img src=x>” (¥1,200)`);
    expect(email.html).not.toMatch(/<script>|<img|<b>Trip/);
    expect(email.html).toContain("&lt;b&gt;Trip&lt;/b&gt; &amp; co");
    expect(email.html).toContain("&quot;Taxi&quot; &lt;img src=x&gt;");
    expect(email.html).toContain('href="https://wisesplit.llmat.dev/groups/g1"');
  });

  it("marks emails from the test site", () => {
    const email = notificationEmail(
      { ...env, ENVIRONMENT: "staging", SITE_ORIGIN: "https://s.test" },
      to,
      note,
      group,
      names,
    )!;
    expect(email.subject.startsWith("[test site] <b>Trip</b>")).toBe(true);
    const zh = notificationEmail({ ...env, ENVIRONMENT: "staging" }, { ...to, lang: "zh" }, note, group, names)!;
    expect(zh.subject.startsWith("[测试网站] ")).toBe(true);
  });
});
