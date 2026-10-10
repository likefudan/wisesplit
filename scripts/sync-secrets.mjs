// CI helper: after a deploy, copy the Worker secrets that are set as GitHub secrets onto the
// environment's Worker. A secret missing from GitHub is left as it is on the Worker, never removed.
// Usage: node scripts/sync-secrets.mjs [production|staging]
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const target = process.argv[2] ?? "production";
if (!["production", "staging"].includes(target)) throw new Error(`unknown environment ${target}`);

const NAMES = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
  "ADMIN_EMAILS",
  // The test login only ever works on staging (src/worker/routes/testLogin.ts); production never gets it.
  ...(target === "staging" ? ["TEST_LOGIN_SECRET"] : []),
];

const secrets = Object.fromEntries(NAMES.filter((n) => process.env[n]).map((n) => [n, process.env[n]]));
const missing = NAMES.filter((n) => !process.env[n]);
if (missing.length) console.log(`Not set in GitHub, left unchanged: ${missing.join(", ")}`);
if (Object.keys(secrets).length === 0) process.exit();

const dir = mkdtempSync(join(tmpdir(), "secrets-"));
const file = join(dir, "secrets.json");
try {
  writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
  execFileSync("npx", ["wrangler", "secret", "bulk", file, ...(target === "staging" ? ["--env", "staging"] : [])], {
    stdio: "inherit",
  });
  console.log(`Updated ${target} secrets: ${Object.keys(secrets).join(", ")}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
