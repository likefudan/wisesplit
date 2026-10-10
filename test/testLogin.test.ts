import { describe, expect, it } from "vitest";
import type { Env } from "../src/worker/env";
import { json, send, uniqueEmail } from "./helpers";

const login = (env: Partial<Env>, secret = "s3cret", email = uniqueEmail()) =>
  send("/api/test/login", { body: { email, name: "Tester" }, headers: { "X-Test-Login-Secret": secret }, env });

describe("test login (browser tests only)", () => {
  it("never works in production, even with the secret set", async () => {
    for (const env of [
      { TEST_LOGIN_SECRET: "s3cret" },
      { TEST_LOGIN_SECRET: "s3cret", ENVIRONMENT: "production" },
      { TEST_LOGIN_SECRET: "s3cret", ENVIRONMENT: "" },
    ]) {
      const res = await login(env);
      expect(res.status).toBe(404);
      expect(res.headers.get("Set-Cookie")).toBeNull();
    }
  });

  it("is off on staging and locally unless its secret is set", async () => {
    expect((await login({ ENVIRONMENT: "staging" })).status).toBe(404);
    expect((await login({ ENVIRONMENT: "local" })).status).toBe(404);
  });

  it("needs the right secret", async () => {
    const res = await login({ ENVIRONMENT: "staging", TEST_LOGIN_SECRET: "s3cret" }, "wrong");
    expect(res.status).toBe(403);
  });

  it("signs in as the given Google identity on a local site", async () => {
    const email = uniqueEmail();
    const res = await login({ ENVIRONMENT: "local", TEST_LOGIN_SECRET: "s3cret" }, "s3cret", email);
    expect(res.status).toBe(204);
    const cookie = res.headers.get("Set-Cookie")!.split(";")[0]!;
    const session = await json(await send("/api/auth/session", { cookie }));
    expect(session.identity).toMatchObject({ email, name: "Tester" });
  });
});
