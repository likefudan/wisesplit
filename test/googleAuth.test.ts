import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { safeNext } from "../src/worker/routes/auth";
import { json, makeUser, ORIGIN, send, uniqueEmail } from "./helpers";

const GOOGLE = { GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "test-secret" };
const get = (path: string, cookie = "") => send(path, { cookie, env: GOOGLE });

let privateKey: CryptoKey;
let jwk: Record<string, unknown>;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: "google-test", alg: "RS256", use: "sig" };
});
afterEach(() => vi.restoreAllMocks());

async function begin(next?: string) {
  const res = await get(`/api/auth/google${next ? `?next=${encodeURIComponent(next)}` : ""}`);
  expect(res.status).toBe(302);
  const url = new URL(res.headers.get("Location")!);
  return { url, state: url.searchParams.get("state")!, cookie: res.headers.get("Set-Cookie")!.split(";")[0]! };
}

/** Goes through Google sign-in with a test-signed ID token carrying `claims`. */
async function login(
  claims: Record<string, unknown> = {},
  options: { sub?: string; audience?: string; badSignature?: boolean; next?: string } = {},
) {
  const start = await begin(options.next);
  const token = await new SignJWT({
    email: "alice@gmail.com",
    email_verified: true,
    name: "Alice Liddell",
    nonce: start.url.searchParams.get("nonce"),
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "google-test" })
    .setSubject(options.sub ?? "google-alice")
    .setIssuer("https://accounts.google.com")
    .setAudience(options.audience ?? "test-client")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(options.badSignature ? (await generateKeyPair("RS256")).privateKey : privateKey);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [jwk] });
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("code_verifier")).toBeTruthy();
    expect(body.get("client_secret")).toBe("test-secret");
    expect(body.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/google/callback`);
    return Response.json({ id_token: token });
  });
  const response = await get(`/api/auth/google/callback?state=${start.state}&code=valid-code`, start.cookie);
  const cookie = response.headers.get("Set-Cookie")?.match(/__Host-ws_session=[^;,]+/)?.[0] ?? "";
  return { response, cookie, start };
}

describe("Google sign-in", () => {
  it("sends people to Google with state, nonce, PKCE and this site's callback, never the secret", async () => {
    const { url, cookie } = await begin();
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("test-client");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.get("nonce")).toBeTruthy();
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/google/callback`);
    expect(url.searchParams.get("client_secret")).toBeNull();
    expect(cookie).toMatch(/^__Host-ws_oauth_[\w-]{16}=/);
  });

  it("starts on the site's own address, where Google will come back to", async () => {
    const res = await send("/api/auth/google?next=%2Fprofile", {
      env: { ...GOOGLE, SITE_ORIGIN: "https://real.example" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://real.example/api/auth/google?next=%2Fprofile");
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("says so when Google sign-in is not set up", async () => {
    const res = await send("/api/auth/google");
    expect(res.headers.get("Location")).toBe("/login?error=not_configured");
    expect(await json(await send("/api/auth/session"))).toMatchObject({ googleEnabled: false });
  });

  it("checks the ID token and signs the browser in with an HttpOnly, Secure, Lax cookie", async () => {
    const { response, cookie } = await login();
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/");
    const setCookie = response.headers.get("Set-Cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    const session = await json(await get("/api/auth/session", cookie));
    expect(session).toMatchObject({
      googleEnabled: true,
      identity: { email: "alice@gmail.com", name: "Alice Liddell" },
      user: null,
    });
    // The sign-in in progress is used up.
    expect(response.headers.getSetCookie().some((h) => /^__Host-ws_oauth_[\w-]{16}=;/.test(h))).toBe(true);
  });

  it("refuses a sign-in in progress that has run out or was tampered with", async () => {
    const start = await begin();
    const [name, value] = start.cookie.split("=") as [string, string];
    const pending = JSON.parse(atob(value.replace(/-/g, "+").replace(/_/g, "/")));
    for (const cookie of [
      `${name}=${btoa(JSON.stringify({ ...pending, expires: Date.now() - 1 }))}`,
      `${name}=not-json`,
      // Another sign-in's cookie doesn't count for this one.
      `__Host-ws_oauth_someone-elses-st=${value}`,
      "",
    ]) {
      const res = await get(`/api/auth/google/callback?state=${start.state}&code=c`, cookie);
      expect(res.headers.get("Location")).toBe("/login?error=invalid_state");
    }
  });

  it("comes back to the page the sign-in started from, on this site only", async () => {
    const { response } = await login({}, { next: "/admin?status=rejected" });
    expect(response.headers.get("Location")).toBe("/admin?status=rejected");
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("/\\evil.example")).toBe("/");
    expect(safeNext("https://evil.example/")).toBe("/");
    expect(safeNext("/profile")).toBe("/profile");
    expect(safeNext(undefined)).toBe("/");
  });

  it.each([
    ["an unverified email", { email_verified: false }, {}],
    ["the wrong nonce", { nonce: "wrong" }, {}],
    ["another app's token", {}, { audience: "other-client" }],
    ["a token not signed by Google", {}, { badSignature: true }],
    ["another app as the authorized party", { azp: "other-client" }, {}],
  ])("refuses %s", async (_, claims, options) => {
    const { response, cookie } = await login(claims, options);
    expect(response.headers.get("Location")).toBe("/login?error=failed");
    expect(cookie).toBe("");
  });

  it("lets two tabs sign in at the same time", async () => {
    const first = await begin();
    await begin();
    const res = await get(`/api/auth/google/callback?state=${first.state}&error=access_denied`, first.cookie);
    // Past the state check: the first tab's sign-in is still its own.
    expect(res.headers.get("Location")).toBe("/login?error=cancelled");
  });

  it("drops the oldest abandoned sign-ins so their cookies don't pile up", async () => {
    const pending = (name: string, minutes: number) =>
      `__Host-ws_oauth_${name}=${btoa(JSON.stringify({ state: name, nonce: "n", verifier: "v", next: "/", expires: Date.now() + minutes * 60_000 })).replace(/=+$/, "")}`;
    const res = await get(
      "/api/auth/google",
      [pending("oldest", 1), ...Array.from({ length: 9 }, (_, i) => pending(`newer${i}`, 2 + i))].join("; "),
    );
    const dropped = res.headers
      .getSetCookie()
      .filter((h) => /^__Host-ws_oauth_\w+=;/.test(h))
      .map((h) => h.split("=")[0]);
    // Nine kept beside the new one; the oldest goes.
    expect(dropped).toEqual(["__Host-ws_oauth_oldest"]);
  });

  it("refuses a callback whose state does not match this browser's", async () => {
    const start = await begin();
    const res = await get(`/api/auth/google/callback?state=${start.state}x&code=c`, start.cookie);
    expect(res.headers.get("Location")).toBe("/login?error=invalid_state");
  });

  it("keeps the page to come back to when sign-in fails, and says 'cancelled' even after the state ran out", async () => {
    const start = await begin("/admin?status=rejected");
    const res = await get(`/api/auth/google/callback?state=${start.state}&error=access_denied`, start.cookie);
    expect(res.headers.get("Location")).toBe(
      `/login?error=cancelled&next=${encodeURIComponent("/admin?status=rejected")}`,
    );
    const late = await get(`/api/auth/google/callback?state=${start.state}&error=access_denied`);
    expect(late.headers.get("Location")).toBe("/login?error=cancelled");
    expect(safeNext("/groups/a.b~c?q=a+b&x=1,2")).toBe("/groups/a.b~c?q=a+b&x=1,2");
  });

  it("reports a sign-in cancelled at Google", async () => {
    const start = await begin();
    const res = await get(`/api/auth/google/callback?state=${start.state}&error=access_denied`, start.cookie);
    expect(res.headers.get("Location")).toBe("/login?error=cancelled");
  });

  it("keeps only safe Google profile pictures", async () => {
    const good = await login({ picture: "https://lh3.googleusercontent.com/a/pic" }, { sub: "pic-good" });
    expect((await json(await get("/api/auth/session", good.cookie))).identity.picture).toBe(
      "https://lh3.googleusercontent.com/a/pic",
    );
    vi.restoreAllMocks();
    const bad = await login({ picture: "https://googleusercontent.com.evil.test/a" }, { sub: "pic-bad" });
    expect((await json(await get("/api/auth/session", bad.cookie))).identity.picture).toBeNull();
  });

  it("refreshes an existing user's email and picture from Google", async () => {
    const user = await makeUser("approved", uniqueEmail("old"));
    await login(
      { email: "new-address@gmail.com", picture: "https://lh3.googleusercontent.com/new" },
      { sub: `sub-${user.email}` },
    );
    const row = await env.DB.prepare("SELECT email, picture FROM users WHERE id = ?").bind(user.id).first();
    expect(row).toEqual({ email: "new-address@gmail.com", picture: "https://lh3.googleusercontent.com/new" });
  });

  it("signs out: the session is gone from the database and the cookie is cleared", async () => {
    const { cookie } = await login({}, { sub: "logout-test" });
    const res = await send("/api/auth/logout", { body: {}, cookie });
    expect(res.status).toBe(204);
    expect(res.headers.get("Set-Cookie")).toMatch(/__Host-ws_session=;/);
    expect((await json(await get("/api/auth/session", cookie))).identity).toBeNull();
  });
});
