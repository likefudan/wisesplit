import { DEFAULT_SETTINGS, MAX_CAP, type Settings } from "../shared/settings";
import type { Env } from "./env";
import { HttpError } from "./http";

const KEYS: Record<keyof Settings, string> = {
  requireApproval: "require_approval",
  dailySignupCap: "daily_signup_cap",
  pendingCap: "pending_cap",
};

export async function getSettings(env: Env): Promise<Settings> {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const stored = new Map(results.map((r) => [r.key, r.value]));
  const cap = (key: string, fallback: number) => {
    const n = Number(stored.get(key));
    return stored.has(key) && Number.isInteger(n) && n >= 0 && n <= MAX_CAP ? n : fallback;
  };
  const approval = stored.get(KEYS.requireApproval);
  return {
    requireApproval: approval === undefined ? DEFAULT_SETTINGS.requireApproval : approval === "1",
    dailySignupCap: cap(KEYS.dailySignupCap, DEFAULT_SETTINGS.dailySignupCap),
    pendingCap: cap(KEYS.pendingCap, DEFAULT_SETTINGS.pendingCap),
  };
}

/** Saves the fields present in `input`, after checking every one of them; returns the settings now in force. */
export async function updateSettings(env: Env, input: Record<string, unknown>): Promise<Settings> {
  const writes: [string, string][] = [];
  if ("requireApproval" in input) {
    if (typeof input.requireApproval !== "boolean") throw invalid("requireApproval must be true or false");
    writes.push([KEYS.requireApproval, input.requireApproval ? "1" : "0"]);
  }
  for (const field of ["dailySignupCap", "pendingCap"] as const) {
    if (!(field in input)) continue;
    const n = input[field];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_CAP)
      throw invalid(`${field} must be a whole number from 0 to ${MAX_CAP}`);
    writes.push([KEYS[field], String(n)]);
  }
  if (writes.length)
    await env.DB.batch(
      writes.map(([key, value]) =>
        env.DB.prepare(
          "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        ).bind(key, value),
      ),
    );
  return getSettings(env);
}

const invalid = (message: string) => new HttpError(400, "invalid_settings", message);
