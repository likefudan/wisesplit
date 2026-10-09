import { describe, expect, it } from "vitest";
import { call } from "./helpers";

describe("skeleton", () => {
  it("reports health with the database reachable", async () => {
    const res = await call("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("is not marked as the test site (tests read the production config)", async () => {
    const res = await call("/api/health");
    expect(res.headers.get("X-Robots-Tag")).toBeNull();
  });

  it("answers unknown API paths with a JSON error code", async () => {
    const res = await call("/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
  });

  it("lets search engines index the real site but not the API", async () => {
    const res = await call("/robots.txt");
    expect(await res.text()).toBe("User-agent: *\nDisallow: /api/\n");
    expect(res.headers.get("Cache-Control")).toBeNull();
  });
});
