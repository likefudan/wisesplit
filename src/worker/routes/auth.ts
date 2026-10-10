import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { cookieName, cookieOptions, endSession, type SessionRow, signedIn, startSession } from "../auth";
import type { Env } from "../env";
import { HttpError, readJson, str } from "../http";
import { fromBase64Url, pkceChallenge, randomToken, timingSafeEqual, toBase64Url } from "../lib/crypto";
import { turnstileConfigured, verifyTurnstile } from "../turnstile";
import { alreadyRegistered, googleName, parseLang, parseName, publicUser, register } from "../users";

/** One cookie per sign-in in progress, named by its state, so two tabs signing in don't clash. */
const STATE_PREFIX = "ws_oauth_";
const stateCookie = (c: Context, state: string) => cookieName(c, `${STATE_PREFIX}${state.slice(0, 16)}`);
/** Sign-ins in progress kept at once; older abandoned ones are dropped so cookies don't pile up. */
const MAX_PENDING_SIGNINS = 10;
const STATE_MINUTES = 10;
const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export const googleEnabled = (env: Env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
const callbackUrl = (env: Env) => `${new URL(env.SITE_ORIGIN).origin}/api/auth/google/callback`;

/** Where to land after Google: a path on this site only (no other host, no "//evil" or "/\\evil"). */
export const safeNext = (v: string | undefined) =>
  v && /^\/[\w/.~-]*(\?[\w=&%.+~:,-]*)?$/.test(v) && !v.startsWith("//") ? v : "/";

/** The page saying why sign-in did not work, with the page to come back to after trying again. */
const loginError = (error: string, next = "/") =>
  `/login?error=${error}${next === "/" ? "" : `&next=${encodeURIComponent(next)}`}`;

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
  const { session, user } = await signedIn(c);
  return c.json({
    googleEnabled: googleEnabled(c.env),
    turnstileSiteKey: turnstileConfigured(c.env) ? c.env.TURNSTILE_SITE_KEY! : null,
    identity: session ? { email: session.email, name: session.name, picture: session.picture } : null,
    user: user ? publicUser(c.env, user) : null,
  });
});

/**
 * A Google sign-in in progress, kept only in this browser's HttpOnly cookie (nothing is written to
 * the database before Google answers): the state Google must send back, the nonce the ID token
 * must carry, the PKCE verifier, the page to land on afterwards, and when it runs out.
 */
interface PendingSignIn {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  expires: number;
}

function readPending(cookie: string | undefined): PendingSignIn | null {
  if (!cookie) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(fromBase64Url(cookie))) as PendingSignIn;
    return typeof p.state === "string" &&
      typeof p.nonce === "string" &&
      typeof p.verifier === "string" &&
      typeof p.next === "string" &&
      typeof p.expires === "number" &&
      p.expires > Date.now()
      ? p
      : null;
  } catch {
    return null;
  }
}

// Starts Google sign-in: Authorization Code with PKCE, a random state and a nonce.
authRoutes.get("/google", async (c) => {
  if (!googleEnabled(c.env)) return c.redirect(loginError("not_configured"));
  const pending: PendingSignIn = {
    state: randomToken(),
    nonce: randomToken(),
    verifier: randomToken(),
    next: safeNext(c.req.query("next")),
    expires: Date.now() + STATE_MINUTES * 60_000,
  };
  const prefix = cookieName(c, STATE_PREFIX);
  const others = Object.entries(getCookie(c))
    .filter(([name]) => name.startsWith(prefix))
    .sort(([, a], [, b]) => (readPending(b)?.expires ?? 0) - (readPending(a)?.expires ?? 0));
  for (const [name] of others.slice(MAX_PENDING_SIGNINS - 1)) deleteCookie(c, name, cookieOptions(c));
  const value = toBase64Url(new TextEncoder().encode(JSON.stringify(pending)));
  setCookie(c, stateCookie(c, pending.state), value, { ...cookieOptions(c), maxAge: STATE_MINUTES * 60 });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID!,
    redirect_uri: callbackUrl(c.env),
    response_type: "code",
    scope: "openid email profile",
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: await pkceChallenge(pending.verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return c.redirect(url.toString());
});

authRoutes.get("/google/callback", async (c) => {
  const state = c.req.query("state") ?? "";
  const valid = /^[\w-]{43}$/.test(state);
  const saved = valid ? readPending(getCookie(c, stateCookie(c, state))) : null;
  // Used up whatever happens next: one sign-in per visit to Google.
  if (valid) deleteCookie(c, stateCookie(c, state), cookieOptions(c));
  const next = safeNext(saved?.next);
  // Cancelled at Google: say so, even if the sign-in had already run out meanwhile.
  if (c.req.query("error")) return c.redirect(loginError("cancelled", next));
  if (!googleEnabled(c.env) || !saved || !timingSafeEqual(state, saved.state))
    return c.redirect(loginError("invalid_state"));
  const code = c.req.query("code");
  if (!code) return c.redirect(loginError("failed", next));
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
    return c.redirect(loginError("failed", next));
  }
  await startSession(c, identity);
  return c.redirect(next);
});

// Sign-up, and re-applying after a rejection: the display name, the language the page is in, and
// the Turnstile answer.
authRoutes.post("/register", async (c) => {
  const { session, user: existing } = await signedIn(c);
  if (!session) throw new HttpError(401, "login_required", "Sign in with Google first");
  if (existing && existing.status !== "rejected") throw alreadyRegistered();
  const body = await readJson(c.req.raw);
  const name = parseName(body.name);
  const lang = parseLang(body.lang);
  await verifyTurnstile(c.env, str(body.turnstileToken), c.req.header("CF-Connecting-IP"));
  const user = await register(c.env, session, existing, { name, lang });
  return c.json({ user: publicUser(c.env, user) });
});

authRoutes.post("/logout", async (c) => {
  await endSession(c);
  return c.body(null, 204);
});
