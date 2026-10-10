import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { json, makeUser, send, signIn, uniqueEmail } from "./helpers";

const post = (path: string, cookie: string, body: unknown = {}) => send(path, { cookie, body });

async function groupWithInvite() {
  const owner = await makeUser("approved", undefined, "Olive");
  const group = (await json(await post("/api/groups", owner.cookie, { name: "Flat", currency: "GBP" }))).group;
  const res = await post(`/api/groups/${group.id}/invites`, owner.cookie);
  expect(res.status).toBe(200);
  const { token, expiresAt } = await json(res);
  expect(token).toMatch(/^[\w-]{43}$/);
  expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(6.9 * 86400_000);
  return { owner, group, token: token as string };
}

const members = async (groupId: string, cookie: string) =>
  (await json(await send(`/api/groups/${groupId}`, { cookie }))).group.members.map((m: any) => m.id);

const TURNSTILE = { TURNSTILE_SITE_KEY: "site-key", TURNSTILE_SECRET_KEY: "secret-key" };
function mockTurnstile() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    const body = init?.body as URLSearchParams;
    return Response.json({ success: body.get("response") === "good", hostname: "wisesplit.test" });
  });
}

const registerWith = (cookie: string, inviteToken: string, turnstileToken = "good") =>
  send("/api/auth/register", {
    cookie,
    body: { name: "Newbie", lang: "en", turnstileToken, inviteToken },
    env: TURNSTILE,
  });

afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.batch([env.DB.prepare("DELETE FROM settings"), env.DB.prepare("DELETE FROM signup_days")]);
});

describe("invite links", () => {
  it("show the group and who sent them, to anyone holding the link", async () => {
    const { token } = await groupWithInvite();
    const res = await send(`/api/invites/${token}`);
    expect((await json(res)).invite).toEqual({ groupName: "Flat", invitedBy: "Olive", state: "valid", memberOf: null });
    for (const bad of ["x".repeat(43), "short"]) {
      const missing = await send(`/api/invites/${bad}`);
      expect(missing.status).toBe(404);
      expect((await json(missing)).error.code).toBe("invite_not_found");
    }
  });

  it("let an approved user join, once", async () => {
    const { owner, group, token } = await groupWithInvite();
    const friend = await makeUser("approved");
    const res = await post(`/api/invites/${token}/accept`, friend.cookie);
    expect(await json(res)).toEqual({ groupId: group.id });
    expect(await members(group.id, owner.cookie)).toEqual([owner.id, friend.id]);
    expect((await json(await send(`/api/invites/${token}`, { cookie: friend.cookie }))).invite).toMatchObject({
      state: "used",
      memberOf: group.id,
    });
    // Used up for anyone else; the one who used it is still sent to the group.
    const other = await makeUser("approved");
    const again = await post(`/api/invites/${token}/accept`, other.cookie);
    expect(again.status).toBe(410);
    expect((await json(again)).error.code).toBe("invite_unusable");
    expect((await post(`/api/invites/${token}/accept`, friend.cookie)).status).toBe(200);
  });

  it("are not used up by someone already in the group", async () => {
    const { owner, group, token } = await groupWithInvite();
    expect(await json(await post(`/api/invites/${token}/accept`, owner.cookie))).toEqual({ groupId: group.id });
    expect((await json(await send(`/api/invites/${token}`))).invite.state).toBe("valid");
  });

  it("stop working after 7 days", async () => {
    const { token } = await groupWithInvite();
    await env.DB.prepare("UPDATE group_invites SET expires_at = ?")
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();
    expect((await json(await send(`/api/invites/${token}`))).invite.state).toBe("expired");
    const res = await post(`/api/invites/${token}/accept`, (await makeUser("approved")).cookie);
    expect(res.status).toBe(410);
  });

  it("approve a user who is still waiting, but not a rejected or deactivated one", async () => {
    const { owner, group, token } = await groupWithInvite();
    for (const status of ["rejected", "deactivated"] as const) {
      const user = await makeUser(status);
      const res = await post(`/api/invites/${token}/accept`, user.cookie);
      expect(res.status).toBe(403);
    }
    const pending = await makeUser("pending");
    expect((await post(`/api/invites/${token}/accept`, pending.cookie)).status).toBe(200);
    expect((await json(await send("/api/me", { cookie: pending.cookie }))).user.status).toBe("approved");
    expect(await members(group.id, owner.cookie)).toEqual([owner.id, pending.id]);
  });

  it("need a signed-up account to accept", async () => {
    const { token } = await groupWithInvite();
    expect((await post(`/api/invites/${token}/accept`, "")).status).toBe(401);
    const res = await post(`/api/invites/${token}/accept`, await signIn(uniqueEmail()));
    expect((await json(res)).error.code).toBe("signup_required");
  });

  it("are gone with their group", async () => {
    const { owner, group, token } = await groupWithInvite();
    await post(`/api/groups/${group.id}/delete`, owner.cookie);
    expect((await send(`/api/invites/${token}`)).status).toBe(404);
  });
});

describe("signing up through an invite link", () => {
  it("approves the new user at once and adds them to the group, skipping the caps", async () => {
    mockTurnstile();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO settings (key, value) VALUES ('daily_signup_cap', '0'), ('pending_cap', '0')"),
    ]);
    const { owner, group, token } = await groupWithInvite();
    const cookie = await signIn(uniqueEmail());
    const res = await registerWith(cookie, token);
    expect(res.status).toBe(200);
    const { user } = await json(res);
    expect(user).toMatchObject({ name: "Newbie", status: "approved" });
    expect(await members(group.id, owner.cookie)).toEqual([owner.id, user.id]);
    expect((await json(await send(`/api/invites/${token}`))).invite.state).toBe("used");
    const day = await env.DB.prepare("SELECT COUNT(*) AS n FROM signup_days").first<{ n: number }>();
    expect(day!.n).toBe(0);
  });

  it("still needs the human check, and leaves the link unused when it fails", async () => {
    mockTurnstile();
    const { token } = await groupWithInvite();
    const cookie = await signIn(uniqueEmail());
    const res = await registerWith(cookie, token, "bad");
    expect((await json(res)).error.code).toBe("turnstile_failed");
    expect((await json(await send(`/api/invites/${token}`))).invite.state).toBe("valid");
    expect((await json(await send("/api/auth/session", { cookie }))).user).toBeNull();
  });

  it("writes nothing when the link is used up or unknown", async () => {
    mockTurnstile();
    const { token } = await groupWithInvite();
    expect((await registerWith(await signIn(uniqueEmail()), token)).status).toBe(200);
    const cookie = await signIn(uniqueEmail());
    const used = await registerWith(cookie, token);
    expect(used.status).toBe(410);
    expect((await json(await send("/api/auth/session", { cookie }))).user).toBeNull();
    const unknown = await registerWith(cookie, "nope");
    expect((await json(unknown)).error.code).toBe("invite_not_found");
  });

  it("refuses a rejected applicant and someone already signed up", async () => {
    mockTurnstile();
    const { token } = await groupWithInvite();
    const rejected = await makeUser("rejected");
    expect((await json(await registerWith(rejected.cookie, token))).error.code).toBe("account_rejected");
    const approved = await makeUser("approved");
    expect((await json(await registerWith(approved.cookie, token))).error.code).toBe("already_registered");
    expect((await json(await send(`/api/invites/${token}`))).invite.state).toBe("valid");
  });
});
