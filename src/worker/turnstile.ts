import { type Env, isLocal } from "./env";
import { HttpError } from "./http";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export const turnstileConfigured = (env: Env) => !!(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY);

/**
 * Checks the sign-up form's Turnstile answer with Cloudflare. Only a local site (a developer's
 * machine, the browser tests) may run without Turnstile keys; staging and production refuse
 * sign-ups until they are set.
 */
export async function verifyTurnstile(env: Env, token: string, ip: string | undefined): Promise<void> {
  if (!turnstileConfigured(env)) {
    if (isLocal(env)) return;
    throw new HttpError(503, "turnstile_unavailable", "Sign-up is not set up yet (Turnstile keys missing)");
  }
  if (!token || token.length > 2048) throw failed();
  let outcome: { success?: boolean; hostname?: string };
  try {
    const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY!, response: token });
    if (ip) body.set("remoteip", ip);
    const res = await fetch(VERIFY_URL, { method: "POST", body, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`siteverify HTTP ${res.status}`);
    outcome = await res.json();
  } catch (err) {
    console.error("turnstile:", err instanceof Error ? err.message : err);
    throw new HttpError(503, "turnstile_unavailable", "Could not check the challenge; try again");
  }
  if (outcome.success !== true) throw failed();
  // One widget covers staging and production; an answer only counts on the site it was solved on.
  // (Locally, Cloudflare's test keys answer with "example.com".)
  if (!isLocal(env) && outcome.hostname !== new URL(env.SITE_ORIGIN).hostname) throw failed();
}

const failed = () => new HttpError(400, "turnstile_failed", "The human check failed; try it again");
