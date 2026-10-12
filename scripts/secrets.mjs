// Shared by the CI helpers that check and set Worker secrets (check-, sync-secrets.mjs, ensure-vapid.mjs).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The environment named on the command line ("production" when none). */
export function targetEnvironment() {
  const target = process.argv[2] ?? "production";
  if (!["production", "staging"].includes(target)) throw new Error(`unknown environment ${target}`);
  return target;
}

/** The Worker secrets CI copies from GitHub (sync-secrets.mjs), for that environment. */
export const syncedSecrets = (target) => [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
  "ADMIN_EMAILS",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  // The test login only ever works on staging (src/worker/routes/testLogin.ts); production never gets it.
  ...(target === "staging" ? ["TEST_LOGIN_SECRET"] : []),
];

/** wrangler's arguments for that environment. */
export const envArgs = (target) => (target === "staging" ? ["--env", "staging"] : []);

/** Sets `secrets` ({ NAME: value }) on the environment's Worker, through a file only this user can read. */
export function putSecrets(target, secrets) {
  const dir = mkdtempSync(join(tmpdir(), "secrets-"));
  const file = join(dir, "secrets.json");
  try {
    writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
    execFileSync("npx", ["wrangler", "secret", "bulk", file, ...envArgs(target)], { stdio: "inherit" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The names of the secrets the environment's Worker has, or null when wrangler couldn't say (its
 * output is printed then). A Worker not deployed yet can't be listed either.
 */
export function listSecretNames(target) {
  const list = spawnSync("npx", ["wrangler", "secret", "list", "--format", "json", ...envArgs(target)], {
    encoding: "utf8",
  });
  if (list.error) throw list.error;
  // The JSON is the array on stdout (from a line starting "[{" or "[]" to the last "]"), whatever
  // wrangler prints around it.
  const start = list.stdout.search(/^\s*\[\s*(\{|\])/m);
  if (list.status === 0 && start >= 0)
    try {
      return JSON.parse(list.stdout.slice(start, list.stdout.lastIndexOf("]") + 1)).map((s) => s.name);
    } catch {
      // Reported below.
    }
  console.error(`${list.stdout}${list.stderr}`);
  return null;
}
