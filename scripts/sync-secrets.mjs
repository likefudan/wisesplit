// CI helper: after a deploy, copy the Worker secrets that are set as GitHub secrets onto the
// environment's Worker. A secret missing from GitHub is left as it is on the Worker, never removed.
// Usage: node scripts/sync-secrets.mjs [production|staging]
import { putSecrets, syncedSecrets, targetEnvironment } from "./secrets.mjs";

const target = targetEnvironment();

const NAMES = syncedSecrets(target);

const secrets = Object.fromEntries(NAMES.filter((n) => process.env[n]).map((n) => [n, process.env[n]]));
const missing = NAMES.filter((n) => !process.env[n]);
if (missing.length) console.log(`Not set in GitHub, left unchanged: ${missing.join(", ")}`);
if (Object.keys(secrets).length === 0) process.exit();

putSecrets(target, secrets);
console.log(`Updated ${target} secrets: ${Object.keys(secrets).join(", ")}`);
