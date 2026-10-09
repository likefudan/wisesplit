import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { admin, json, makeUser, send } from "./helpers";

const post = (path: string, cookie: string, body: unknown = {}) => send(path, { cookie, body });

afterEach(async () => {
  await env.DB.prepare("DELETE FROM settings").run();
});

describe("admin console", () => {
  it("is for the admin only", async () => {
    const member = await makeUser("approved");
    for (const path of ["/api/admin/users?status=pending", "/api/admin/settings"]) {
      const res = await send(path, { cookie: member.cookie });
      expect(res.status).toBe(403);
      expect((await json(res)).error.code).toBe("forbidden");
    }
    expect((await post("/api/admin/settings", member.cookie, { requireApproval: false })).status).toBe(403);
    expect((await send("/api/admin/settings")).status).toBe(401);
  });

  it("an admin who has been deactivated loses the console", async () => {
    const res = await send("/api/admin/settings", {
      cookie: (await makeUser("approved")).cookie,
      env: { ADMIN_EMAILS: "" },
    });
    expect(res.status).toBe(403);
    const deactivated = await makeUser("deactivated", `deact-${crypto.randomUUID().slice(0, 6)}@example.com`);
    const res2 = await send("/api/admin/settings", {
      cookie: deactivated.cookie,
      env: { ADMIN_EMAILS: deactivated.email },
    });
    expect(res2.status).toBe(403);
    expect((await json(res2)).error.code).toBe("account_deactivated");
  });

  it("lists the pending list oldest first", async () => {
    const boss = await admin();
    const first = await makeUser("pending");
    const second = await makeUser("pending");
    await env.DB.prepare("UPDATE users SET applied_at = ? WHERE id = ?")
      .bind("2000-01-01T00:00:00.000Z", first.id)
      .run();
    const { users } = await json(await send("/api/admin/users?status=pending", { cookie: boss.cookie }));
    const ids = users.map((u: { id: string }) => u.id);
    expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));
    expect(users[0]).toMatchObject({ status: "pending", appliedAt: expect.any(String) });
    expect((await send("/api/admin/users?status=nope", { cookie: boss.cookie })).status).toBe(400);
  });

  it("approves, rejects, deactivates and reactivates, recording who decided", async () => {
    const boss = await admin();
    const applicant = await makeUser("pending");
    const approved = await json(await post(`/api/admin/users/${applicant.id}/approve`, boss.cookie));
    expect(approved.user.status).toBe("approved");
    expect((await send("/api/me", { cookie: applicant.cookie })).status).toBe(200);
    const row = await env.DB.prepare("SELECT decided_by, decided_at FROM users WHERE id = ?")
      .bind(applicant.id)
      .first();
    expect(row).toMatchObject({ decided_by: boss.id, decided_at: expect.any(String) });

    expect((await json(await post(`/api/admin/users/${applicant.id}/deactivate`, boss.cookie))).user.status).toBe(
      "deactivated",
    );
    expect((await send("/api/me", { cookie: applicant.cookie })).status).toBe(403);
    expect((await json(await post(`/api/admin/users/${applicant.id}/reactivate`, boss.cookie))).user.status).toBe(
      "approved",
    );

    const other = await makeUser("pending");
    expect((await json(await post(`/api/admin/users/${other.id}/reject`, boss.cookie))).user.status).toBe("rejected");
    // A rejected applicant can still be approved after all.
    expect((await json(await post(`/api/admin/users/${other.id}/approve`, boss.cookie))).user.status).toBe("approved");
  });

  it("refuses actions that don't fit the user's state, unknown users, and the admin's own account", async () => {
    const boss = await admin();
    const member = await makeUser("approved");
    const wrong = await post(`/api/admin/users/${member.id}/reject`, boss.cookie);
    expect(wrong.status).toBe(409);
    expect((await json(wrong)).error.code).toBe("wrong_status");
    expect((await post("/api/admin/users/nobody/approve", boss.cookie)).status).toBe(404);
    expect((await post(`/api/admin/users/${member.id}/promote`, boss.cookie)).status).toBe(404);
    const self = await post(`/api/admin/users/${boss.id}/deactivate`, boss.cookie);
    expect(self.status).toBe(400);
    expect((await json(self)).error.code).toBe("cannot_change_self");
  });

  it("has approval on by default, and saves the settings", async () => {
    const boss = await admin();
    expect((await json(await send("/api/admin/settings", { cookie: boss.cookie }))).settings).toEqual({
      requireApproval: true,
      dailySignupCap: 20,
      pendingCap: 30,
    });
    const saved = await json(
      await post("/api/admin/settings", boss.cookie, { requireApproval: false, dailySignupCap: 5 }),
    );
    expect(saved.settings).toEqual({ requireApproval: false, dailySignupCap: 5, pendingCap: 30 });
    expect((await json(await send("/api/admin/settings", { cookie: boss.cookie }))).settings.requireApproval).toBe(
      false,
    );
  });

  it("rejects malformed settings without saving any of them", async () => {
    const boss = await admin();
    for (const body of [
      { requireApproval: "no" },
      { dailySignupCap: -1 },
      { dailySignupCap: 1.5 },
      { pendingCap: 1001 },
      { pendingCap: null },
      { requireApproval: false, pendingCap: "10" },
    ]) {
      const res = await post("/api/admin/settings", boss.cookie, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await json(res)).error.code).toBe("invalid_settings");
    }
    expect((await json(await send("/api/admin/settings", { cookie: boss.cookie }))).settings.requireApproval).toBe(
      true,
    );
  });
});
