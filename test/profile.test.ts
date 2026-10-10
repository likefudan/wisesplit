import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { json, makeUser, send } from "./helpers";

describe("profile", () => {
  it("shows and saves the display name, Venmo username and language", async () => {
    const user = await makeUser("approved");
    expect((await json(await send("/api/me", { cookie: user.cookie }))).user).toMatchObject({
      id: user.id,
      email: user.email,
      venmo: null,
      lang: "en",
      isAdmin: false,
    });
    const res = await send("/api/me", {
      cookie: user.cookie,
      body: { name: "  Renamed ", venmo: "@Alice-Pay_1", lang: "zh" },
    });
    expect((await json(res)).user).toMatchObject({ name: "Renamed", venmo: "Alice-Pay_1", lang: "zh" });
    // Fields left out keep their value, even if changed meanwhile; an empty Venmo clears it.
    await env.DB.prepare("UPDATE users SET name = 'Changed elsewhere' WHERE id = ?").bind(user.id).run();
    const partial = await json(await send("/api/me", { cookie: user.cookie, body: { venmo: "" } }));
    expect(partial.user).toMatchObject({ name: "Changed elsewhere", venmo: null, lang: "zh" });
  });

  it("checks every field before saving any", async () => {
    const user = await makeUser("approved", undefined, "Original");
    for (const [body, code] of [
      [{ name: "", venmo: "valid_name" }, "invalid_name"],
      [{ venmo: "abc" }, "invalid_venmo"],
      [{ venmo: "has space" }, "invalid_venmo"],
      [{ venmo: "a".repeat(31) }, "invalid_venmo"],
      [{ name: "Fine", lang: "de" }, "invalid_lang"],
    ] as const) {
      const res = await send("/api/me", { cookie: user.cookie, body });
      expect(res.status).toBe(400);
      expect((await json(res)).error.code).toBe(code);
    }
    expect((await json(await send("/api/me", { cookie: user.cookie }))).user).toMatchObject({
      name: "Original",
      venmo: null,
      lang: "en",
    });
  });
});

describe("cross-site requests", () => {
  it("refuses API writes without this site's Origin", async () => {
    const user = await makeUser("approved");
    for (const origin of ["https://evil.example", null]) {
      const res = await send("/api/me", { cookie: user.cookie, body: { name: "Hacked" }, origin });
      expect(res.status).toBe(403);
      expect((await json(res)).error.code).toBe("csrf");
    }
    expect((await json(await send("/api/me", { cookie: user.cookie }))).user.name).toBe("Test User");
  });
});
