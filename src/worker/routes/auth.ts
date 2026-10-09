import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { cookieOptions, currentSession, endSession, type SessionRow, startSession, userByGoogle } from "../auth";
import type { Env } from "../env";
import { HttpError, now, readJson } from "../http";
import { pkceChallenge, randomToken, sha256, timingSafeEqual } from "../lib/crypto";
import { turnstileConfigured, verifyTurnstile } from "../turnstile";
import { googleName, parseLang, parseName, publicUser, register } from "../users";
import { testLoginEnabled } from "./testLogin";

const STATE_COOKIE = "ws_oauth_state";
const STATE_MINUTES = 10;
const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export const googleEnabled = (env: Env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
const callbackUrl = (env: Env) => `${new URL(env.SITE_ORIGIN).origin}/api/auth/google/callback`;

/** Where to land after Google: a path on this site only (no other host, no "//evil" or "/\\evil"). */
export const safeNext = (v: string | undefined) =>
  v && /^\/[\w/-]*(\?[\w=&%.-]*)?$/.test(v) && !v.startsWith("//") ? v : "/";

/** Only HTTPS pictures from Google's image hosts; anything else is dropped (the page shows initials). */
export function profilePicture(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (url.hostname === "googleusercontent.com" || url.hostname.endsWith(".googleusercontent.com"))
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export const authRoutes = new Hono<{ Bindings: Env }>();

/** Everything the pages need to know about who is here, in one call. */
authRoutes.get("/session", async (c) => {
  const session = await currentSession(c);
  const user = session ? await userByGoogle(c.env, session.google_sub) : null;
  return c.json({
    googleEnabled: googleEnabled(c.env),
    turnstileSiteKey: turnstileConfigured(c.env) ? c.env.TURNSTILE_SITE_KEY! : null,
    testLogin: testLoginEnabled(c.env),
    identity: session ? { email: session.email, name: session.name, picture: session.picture } : null,
    user: user ? publicUser(c.env, user) : null,
  });
});

// Starts Google sign-in: Authorization Code with PKCE, a random state (in a cookie and, hashed, in
// the database) and a nonce the ID token must carry back.
authRoutes.get("/google", async (c) => {
  if (!googleEnabled(c.env)) return c.redirect("/login?error=not_configured");
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(now()),
    c.env.DB.prepare(
      "INSERT INTO oauth_states (id_hash, nonce, verifier, next, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      await sha256(state),
      nonce,
      verifier,
      safeNext(c.req.query("next")),
      new Date(Date.now() + STATE_MINUTES * 60_000).toISOString(),
    ),
  ]);
  setCookie(c, STATE_COOKIE, state, { ...cookieOptions(c), maxAge: STATE_MINUTES * 60 });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID!,
    redirect_uri: callbackUrl(c.env),
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return c.redirect(url.toString());
});

authRoutes.get("/google/callback", async (c) => {
  const state = c.req.query("state") ?? "";
  const cookie = getCookie(c, STATE_COOKIE) ?? "";
  deleteCookie(c, STATE_COOKIE, cookieOptions(c));
  if (!googleEnabled(c.env) || !state || !cookie || !timingSafeEqual(state, cookie))
    return c.redirect("/login?error=invalid_state");
  // Used up whatever happens next, so a callback URL can't be replayed.
  const saved = await c.env.DB.prepare(
    "DELETE FROM oauth_states WHERE id_hash = ? AND expires_at > ? RETURNING nonce, verifier, next",
  )
    .bind(await sha256(state), now())
    .first<{ nonce: string; verifier: string; next: string }>();
  if (!saved) return c.redirect("/login?error=invalid_state");
  if (c.req.query("error")) return c.redirect("/login?error=cancelled");
  const code = c.req.query("code");
  if (!code) return c.redirect("/login?error=failed");
  let identity: SessionRow;
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: c.env.GOOGLE_CLIENT_ID!,
        client_secret: c.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: callbackUrl(c.env),
        grant_type: "authorization_code",
        code_verifier: saved.verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`token exchange HTTP ${res.status}`);
    const tokens = (await res.json()) as { id_token?: unknown };
    if (typeof tokens.id_token !== "string") throw new Error("no ID token");
    const { payload } = await jwtVerify(tokens.id_token, googleKeys, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: c.env.GOOGLE_CLIENT_ID!,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "exp", "iat", "nonce", "email"],
    });
    if (
      payload.nonce !== saved.nonce ||
      payload.email_verified !== true ||
      typeof payload.email !== "string" ||
      !payload.sub ||
      (payload.azp !== undefined && payload.azp !== c.env.GOOGLE_CLIENT_ID)
    )
      throw new Error("invalid claims");
    identity = {
      google_sub: payload.sub,
      email: payload.email,
      name: googleName(payload.name, payload.email),
      picture: profilePicture(payload.picture),
    };
  } catch (err) {
    // Never log codes, tokens or Google's answers; the kind of failure is enough.
    console.warn("google sign-in failed:", err instanceof Error ? err.name : "unknown");
    return c.redirect("/login?error=failed");
  }
  await startSession(c, identity);
  return c.redirect(saved.next);
});

// Sign-up, and re-applying after a rejection: the display name, the language the page is in, and
// the Turnstile answer.
authRoutes.post("/register", async (c) => {
  const session = await currentSession(c);
  if (!session) throw new HttpError(401, "login_required", "Sign in with Google first");
  const body = await readJson(c.req.raw);
  const name = parseName(body.name);
  const lang = parseLang(body.lang);
  await verifyTurnstile(
    c.env,
    typeof body.turnstileToken === "string" ? body.turnstileToken : "",
    c.req.header("CF-Connecting-IP"),
  );
  const user = await register(c.env, session, { name, lang });
  return c.json({ user: publicUser(c.env, user) });
});

authRoutes.post("/logout", async (c) => {
  await endSession(c);
  return c.body(null, 204);
});
