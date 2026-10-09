import { describe, expect, it } from "vitest";
import headersFile from "../src/web/public/_headers?raw";
import { SECURITY_HEADERS } from "../src/shared/security";
import { call } from "./helpers";

describe("security headers", () => {
  it("the Worker sends every security header", async () => {
    const res = await call("/api/health");
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(name)).toBe(value);
  });

  it("the static pages' _headers file says the same, header for header", () => {
    const lines = headersFile.split("\n").filter((l) => /^ {2}\S/.test(l));
    expect(lines.sort()).toEqual(
      Object.entries(SECURITY_HEADERS)
        .map(([name, value]) => `  ${name}: ${value}`)
        .sort(),
    );
  });

  it("accepts violation reports without an error", async () => {
    const res = await call("/api/csp-report", {
      method: "POST",
      headers: { "Content-Type": "application/csp-report" },
      body: JSON.stringify({ "csp-report": { "blocked-uri": "inline" } }),
    });
    expect(res.status).toBe(204);
  });
});
