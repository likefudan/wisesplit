import { describe, expect, it } from "vitest";
import type { Env } from "../src/worker/env";
import { json, send, signIn, uniqueEmail } from "./helpers";

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

  it("lets a test-login identity on staging sign up without Turnstile, and nobody else", async () => {
    const TURNSTILE = { TURNSTILE_SITE_KEY: "site-key", TURNSTILE_SECRET_KEY: "secret-key" };
    const staging = { ENVIRONMENT: "staging", TEST_LOGIN_SECRET: "s3cret", ...TURNSTILE };
    const res = await login(staging);
    const cookie = res.headers.get("Set-Cookie")!.split(";")[0]!;
    // No widget to solve, and no answer needed.
    expect((await json(await send("/api/auth/session", { cookie, env: staging }))).turnstileSiteKey).toBeNull();
    const body = { name: "Staging Tester", lang: "en" };
    const signedUp = await send("/api/auth/register", { cookie, body, env: staging });
    expect(signedUp.status).toBe(200);
    expect((await json(signedUp)).user.status).toBe("pending");

    // A real Google identity on the same site still has to answer.
    const google = await signIn(uniqueEmail());
    expect((await json(await send("/api/auth/session", { cookie: google, env: staging }))).turnstileSiteKey).toBe(
      "site-key",
    );
    const refused = await send("/api/auth/register", { cookie: google, body, env: staging });
    expect(refused.status).toBe(400);
    expect((await json(refused)).error.code).toBe("turnstile_failed");

    // As does a test identity left over once the test login is off (no secret, or production).
    for (const env of [
      { ...TURNSTILE, ENVIRONMENT: "staging" },
      { ...TURNSTILE, TEST_LOGIN_SECRET: "s3cret" },
    ]) {
      const res = await send("/api/auth/register", { cookie: await signIn(uniqueEmail(), "test:x"), body, env });
      expect(res.status).toBe(400);
    }
  });
});
