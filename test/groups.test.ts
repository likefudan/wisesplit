import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { json, makeUser, send } from "./helpers";

const post = (path: string, cookie: string, body: unknown = {}) => send(path, { cookie, body });

async function makeGroup(cookie: string, name = "Trip", currency = "USD") {
  const res = await post("/api/groups", cookie, { name, currency });
  expect(res.status).toBe(200);
  return (await json(res)).group;
}

describe("groups", () => {
  it("creates a group with its creator as owner and only member", async () => {
    const owner = await makeUser("approved", undefined, "Olive");
    const group = await makeGroup(owner.cookie, "  Ski   trip ", "JPY");
    expect(group).toMatchObject({ name: "Ski trip", currency: "JPY", ownerId: owner.id, memberCount: 1 });
    expect(group.members.map((m: any) => m.id)).toEqual([owner.id]);
    const list = await json(await send("/api/groups", { cookie: owner.cookie }));
    expect(list.groups).toEqual([
      { id: group.id, name: "Ski trip", currency: "JPY", ownerId: owner.id, memberCount: 1 },
    ]);
  });

  it("checks the name and currency", async () => {
    const user = await makeUser("approved");
    for (const [body, code] of [
      [{ name: "", currency: "USD" }, "invalid_group_name"],
      [{ name: "x".repeat(61), currency: "USD" }, "invalid_group_name"],
      [{ name: "Fine", currency: "XYZ" }, "invalid_currency"],
      [{ name: "Fine", currency: "toString" }, "invalid_currency"],
      [{ name: "Fine" }, "invalid_currency"],
    ] as const) {
      const res = await post("/api/groups", user.cookie, body);
      expect(res.status).toBe(400);
      expect((await json(res)).error.code).toBe(code);
    }
    expect((await json(await send("/api/groups", { cookie: user.cookie }))).groups).toEqual([]);
  });

  it("is for approved users only", async () => {
    const pending = await makeUser("pending");
    expect((await send("/api/groups", { cookie: pending.cookie })).status).toBe(403);
    expect((await send("/api/groups")).status).toBe(401);
  });

  it("shows a group only to its members", async () => {
    const owner = await makeUser("approved");
    const outsider = await makeUser("approved");
    const group = await makeGroup(owner.cookie);
    for (const path of [`/api/groups/${group.id}`, "/api/groups/nonexistent"]) {
      const res = await send(path, { cookie: outsider.cookie });
      expect(res.status).toBe(404);
      expect((await json(res)).error.code).toBe("group_not_found");
    }
    for (const action of ["leave", "delete", "invites", "members"]) {
      const res = await post(`/api/groups/${group.id}/${action}`, outsider.cookie, { email: outsider.email });
      expect(res.status).toBe(404);
    }
    expect((await json(await send(`/api/groups/${group.id}`, { cookie: owner.cookie }))).group.id).toBe(group.id);
  });
});

describe("adding members by email", () => {
  it("adds an approved user, whatever the case of the email", async () => {
    const owner = await makeUser("approved");
    const friend = await makeUser("approved", undefined, "Fred");
    const group = await makeGroup(owner.cookie);
    const res = await post(`/api/groups/${group.id}/members`, owner.cookie, {
      email: ` ${friend.email.toUpperCase()} `,
    });
    expect(res.status).toBe(200);
    expect((await json(res)).group.members.map((m: any) => m.name)).toEqual(["Test User", "Fred"]);
    // The friend sees the group, and can add people too.
    expect((await json(await send("/api/groups", { cookie: friend.cookie }))).groups[0]).toMatchObject({
      id: group.id,
      memberCount: 2,
    });
    const third = await makeUser("approved");
    expect((await post(`/api/groups/${group.id}/members`, friend.cookie, { email: third.email })).status).toBe(200);
    const again = await post(`/api/groups/${group.id}/members`, owner.cookie, { email: friend.email });
    expect(again.status).toBe(409);
    expect((await json(again)).error.code).toBe("already_member");
  });

  it("only finds approved users", async () => {
    const owner = await makeUser("approved");
    const group = await makeGroup(owner.cookie);
    for (const status of ["pending", "rejected", "deactivated"] as const) {
      const user = await makeUser(status);
      const res = await post(`/api/groups/${group.id}/members`, owner.cookie, { email: user.email });
      expect(res.status).toBe(404);
      expect((await json(res)).error.code).toBe("user_not_found");
    }
    for (const email of ["", "nobody@example.com"]) {
      const res = await post(`/api/groups/${group.id}/members`, owner.cookie, { email });
      expect([400, 404]).toContain(res.status);
    }
  });
});

describe("leaving, removing and deleting", () => {
  async function groupOfThree() {
    const owner = await makeUser("approved");
    const a = await makeUser("approved");
    const b = await makeUser("approved");
    const group = await makeGroup(owner.cookie);
    for (const u of [a, b]) await post(`/api/groups/${group.id}/members`, owner.cookie, { email: u.email });
    return { owner, a, b, group };
  }

  it("lets a member leave, but not the owner", async () => {
    const { owner, a, group } = await groupOfThree();
    expect((await post(`/api/groups/${group.id}/leave`, a.cookie)).status).toBe(204);
    expect((await send(`/api/groups/${group.id}`, { cookie: a.cookie })).status).toBe(404);
    const res = await post(`/api/groups/${group.id}/leave`, owner.cookie);
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("owner_cannot_leave");
  });

  it("lets only the owner remove members", async () => {
    const { owner, a, b, group } = await groupOfThree();
    const denied = await post(`/api/groups/${group.id}/members/${b.id}/remove`, a.cookie);
    expect(denied.status).toBe(403);
    expect((await json(denied)).error.code).toBe("owner_only");
    const ownSelf = await post(`/api/groups/${group.id}/members/${owner.id}/remove`, owner.cookie);
    expect((await json(ownSelf)).error.code).toBe("owner_cannot_leave");
    const res = await post(`/api/groups/${group.id}/members/${b.id}/remove`, owner.cookie);
    expect(res.status).toBe(200);
    expect((await json(res)).group.members.map((m: any) => m.id)).toEqual([owner.id, a.id]);
    const gone = await post(`/api/groups/${group.id}/members/${b.id}/remove`, owner.cookie);
    expect(gone.status).toBe(404);
  });

  it("lets only the owner delete the group, with its members and invites", async () => {
    const { owner, a, group } = await groupOfThree();
    await post(`/api/groups/${group.id}/invites`, a.cookie);
    const denied = await post(`/api/groups/${group.id}/delete`, a.cookie);
    expect((await json(denied)).error.code).toBe("owner_only");
    expect((await post(`/api/groups/${group.id}/delete`, owner.cookie)).status).toBe(204);
    expect((await send(`/api/groups/${group.id}`, { cookie: owner.cookie })).status).toBe(404);
    for (const table of ["group_members", "group_invites"]) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE group_id = ?`)
        .bind(group.id)
        .first<{ n: number }>();
      expect(row!.n).toBe(0);
    }
  });

  it("shows deactivated members in the list", async () => {
    const { owner, a, group } = await groupOfThree();
    await env.DB.prepare("UPDATE users SET status = 'deactivated' WHERE id = ?").bind(a.id).run();
    const detail = (await json(await send(`/api/groups/${group.id}`, { cookie: owner.cookie }))).group;
    expect(detail.members.find((m: any) => m.id === a.id).deactivated).toBe(true);
  });
});
