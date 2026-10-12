// CI helper: after a deploy, copy the Worker secrets that are set as GitHub secrets onto the
// environment's Worker. A secret missing from GitHub is left as it is on the Worker, never removed.
// Usage: node scripts/sync-secrets.mjs [production|staging]
import { putSecrets, targetEnvironment } from "./secrets.mjs";

const target = targetEnvironment();

const NAMES = [
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

const secrets = Object.fromEntries(NAMES.filter((n) => process.env[n]).map((n) => [n, process.env[n]]));
const missing = NAMES.filter((n) => !process.env[n]);
if (missing.length) console.log(`Not set in GitHub, left unchanged: ${missing.join(", ")}`);
if (Object.keys(secrets).length === 0) process.exit();

putSecrets(target, secrets);
console.log(`Updated ${target} secrets: ${Object.keys(secrets).join(", ")}`);
