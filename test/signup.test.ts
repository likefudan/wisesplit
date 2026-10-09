import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN_EMAIL, json, makeUser, send, signIn, uniqueEmail } from "./helpers";

const TURNSTILE = { TURNSTILE_SITE_KEY: "site-key", TURNSTILE_SECRET_KEY: "secret-key" };

/** Answers Cloudflare's siteverify: success for the token "good", failure otherwise. */
function mockTurnstile() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(String(input)).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const body = init?.body as URLSearchParams;
    expect(body.get("secret")).toBe("secret-key");
    return Response.json({ success: body.get("response") === "good" });
  });
}

const register = (cookie: string, body: Record<string, unknown> = {}) =>
  send("/api/auth/register", {
    cookie,
    body: { name: "New Person", lang: "zh", turnstileToken: "good", ...body },
    env: TURNSTILE,
  });

async function setSettings(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values))
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = ?")
      .bind(key, value, value)
      .run();
}

const count = async (sql: string, ...args: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...args)
    .first<{ n: number }>())!.n;

afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.prepare("DELETE FROM settings").run();
});

describe("signing up", () => {
  it("puts a new user on the pending list by default", async () => {
    mockTurnstile();
    const cookie = await signIn(uniqueEmail());
    const res = await register(cookie);
    expect(res.status).toBe(200);
    expect((await json(res)).user).toMatchObject({ name: "New Person", lang: "zh", status: "pending", isAdmin: false });
    const session = await json(await send("/api/auth/session", { cookie }));
    expect(session.user.status).toBe("pending");
  });

  it("approves at once when the admin has turned approval off", async () => {
    mockTurnstile();
    await setSettings({ require_approval: "0" });
    const res = await register(await signIn(uniqueEmail()));
    expect((await json(res)).user.status).toBe("approved");
  });

  it("approves the admin at once, even with the caps reached", async () => {
    mockTurnstile();
    await setSettings({ daily_signup_cap: "0", pending_cap: "0" });
    const email = `Admin-${crypto.randomUUID().slice(0, 6)}@Example.com`;
    const res = await send("/api/auth/register", {
      cookie: await signIn(email),
      body: { name: "Boss", lang: "en", turnstileToken: "good" },
      env: { ...TURNSTILE, ADMIN_EMAILS: `someone@else.com, ${email.toLowerCase()}` },
    });
    expect((await json(res)).user).toMatchObject({ status: "approved", isAdmin: true });
  });

  it("requires a passing Turnstile answer", async () => {
    mockTurnstile();
    const cookie = await signIn(uniqueEmail());
    for (const turnstileToken of ["bad", ""]) {
      const res = await register(cookie, { turnstileToken });
      expect(res.status).toBe(400);
      expect((await json(res)).error.code).toBe("turnstile_failed");
    }
    expect((await json(await send("/api/auth/session", { cookie }))).user).toBeNull();
  });

  it("refuses sign-ups on a site without Turnstile keys unless it is a local one", async () => {
    const cookie = await signIn(uniqueEmail());
    const body = { name: "No Keys", lang: "en" };
    const prod = await send("/api/auth/register", { cookie, body });
    expect(prod.status).toBe(503);
    expect((await json(prod)).error.code).toBe("turnstile_unavailable");
    const staging = await send("/api/auth/register", { cookie, body, env: { ENVIRONMENT: "staging" } });
    expect(staging.status).toBe(503);
    const local = await send("/api/auth/register", { cookie, body, env: { ENVIRONMENT: "local" } });
    expect(local.status).toBe(200);
  });

  it("reports Turnstile being unreachable rather than calling the person a bot", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("down", { status: 502 }));
    const res = await register(await signIn(uniqueEmail()));
    expect(res.status).toBe(503);
    expect((await json(res)).error.code).toBe("turnstile_unavailable");
  });

  it("checks the display name and language", async () => {
    mockTurnstile();
    const cookie = await signIn(uniqueEmail());
    for (const [body, code] of [
      [{ name: "   " }, "invalid_name"],
      [{ name: "x".repeat(51) }, "invalid_name"],
      [{ name: "bad\u0007name" }, "invalid_name"],
      [{ lang: "fr" }, "invalid_lang"],
    ] as const) {
      const res = await register(cookie, body);
      expect(res.status).toBe(400);
      expect((await json(res)).error.code).toBe(code);
    }
    const ok = await register(cookie, { name: "  Two   Spaces  " });
    expect((await json(ok)).user.name).toBe("Two Spaces");
  });

  it("needs a Google sign-in first", async () => {
    const res = await register("");
    expect(res.status).toBe(401);
    expect((await json(res)).error.code).toBe("login_required");
  });

  it("refuses a second sign-up from the same Google account", async () => {
    mockTurnstile();
    const cookie = await signIn(uniqueEmail());
    expect((await register(cookie)).status).toBe(200);
    const again = await register(cookie);
    expect(again.status).toBe(409);
    expect((await json(again)).error.code).toBe("already_registered");
  });

  it("lets a rejected applicant apply again at once, with a new name", async () => {
    mockTurnstile();
    const user = await makeUser("rejected");
    const res = await register(user.cookie, { name: "Second Try" });
    expect(res.status).toBe(200);
    expect((await json(res)).user).toMatchObject({ id: user.id, name: "Second Try", status: "pending" });
  });

  it("stops at the daily cap, re-applications included, and tells the person", async () => {
    mockTurnstile();
    const today = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
    const already = await count("SELECT COUNT(*) AS n FROM users WHERE applied_at >= ?", today);
    await setSettings({ daily_signup_cap: String(already + 1), require_approval: "0" });
    expect((await register(await signIn(uniqueEmail()))).status).toBe(200);
    const full = await register(await signIn(uniqueEmail()));
    expect(full.status).toBe(429);
    expect((await json(full)).error.code).toBe("signup_cap_reached");
    const rejected = await makeUser("rejected");
    // makeUser applied today too; the cap was already reached before it.
    const again = await register(rejected.cookie);
    expect((await json(again)).error.code).toBe("signup_cap_reached");
  });

  it("pauses while the pending list is full, but not when approval is off", async () => {
    mockTurnstile();
    const pending = await count("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'");
    await setSettings({ pending_cap: String(pending + 1) });
    expect((await register(await signIn(uniqueEmail()))).status).toBe(200);
    const full = await register(await signIn(uniqueEmail()));
    expect(full.status).toBe(429);
    expect((await json(full)).error.code).toBe("pending_full");
    await setSettings({ require_approval: "0" });
    expect((await register(await signIn(uniqueEmail()))).status).toBe(200);
  });

  it("lets only one of two parallel sign-ups through when one place is left", async () => {
    mockTurnstile();
    const pending = await count("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'");
    await setSettings({ pending_cap: String(pending + 1) });
    const results = await Promise.all([1, 2, 3].map(async () => (await register(await signIn(uniqueEmail()))).status));
    expect(results.filter((s) => s === 200)).toHaveLength(1);
  });
});

describe("what each kind of account may do", () => {
  it.each([
    ["pending", 403, "pending_approval"],
    ["rejected", 403, "account_rejected"],
    ["deactivated", 403, "account_deactivated"],
  ] as const)("a %s user can't use the site", async (status, code, error) => {
    const user = await makeUser(status);
    const res = await send("/api/me", { cookie: user.cookie });
    expect(res.status).toBe(code);
    expect((await json(res)).error.code).toBe(error);
  });

  it("someone signed in with Google but not signed up is asked to sign up", async () => {
    const res = await send("/api/me", { cookie: await signIn(uniqueEmail()) });
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe("signup_required");
  });

  it("nobody signed in is asked to sign in", async () => {
    const res = await send("/api/me");
    expect(res.status).toBe(401);
    expect((await json(res)).error.code).toBe("login_required");
  });

  it("an expired session counts as signed out", async () => {
    const user = await makeUser("approved");
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE google_sub = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), `sub-${user.email}`)
      .run();
    expect((await send("/api/me", { cookie: user.cookie })).status).toBe(401);
  });

  it("an admin email only counts once it has signed up", async () => {
    const res = await send("/api/auth/session", { cookie: await signIn(ADMIN_EMAIL, "sub-not-signed-up") });
    expect((await json(res)).user).toBeNull();
  });

  it("approves an admin who applied before being named admin, so the site can't lock them out", async () => {
    for (const status of ["pending", "rejected"] as const) {
      const late = await makeUser(status);
      const before = await send("/api/me", { cookie: late.cookie });
      expect(before.status).toBe(403);
      const res = await send("/api/auth/session", { cookie: late.cookie, env: { ADMIN_EMAILS: late.email } });
      expect((await json(res)).user).toMatchObject({ status: "approved", isAdmin: true });
    }
    // Deactivation is the admin's own decision and stands.
    const off = await makeUser("deactivated");
    const res = await send("/api/me", { cookie: off.cookie, env: { ADMIN_EMAILS: off.email } });
    expect(res.status).toBe(403);
  });
});
