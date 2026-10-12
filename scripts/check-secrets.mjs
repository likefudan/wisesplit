// CI helper, before a deploy: checks the site will have every secret it needs to be usable (Google
// sign-in, sign-up's Turnstile, an admin, notification emails), each either set in GitHub (copied
// onto the Worker after the deploy by sync-secrets.mjs) or already on the Worker. Production stops
// here when one is missing, before its database or code is touched; staging only warns.
// Usage: node scripts/check-secrets.mjs [production|staging]
import { listSecretNames, syncedSecrets, targetEnvironment } from "./secrets.mjs";

const target = targetEnvironment();
const needed = syncedSecrets(target).filter((n) => n !== "TEST_LOGIN_SECRET");

const notInGitHub = needed.filter((n) => !process.env[n]);
// A Worker that was never deployed has no secrets to list.
const onWorker = notInGitHub.length ? (listSecretNames(target) ?? []) : [];
const missing = notInGitHub.filter((n) => !onWorker.includes(n));
if (!missing.length) {
  console.log(`The ${target} site has every secret it needs`);
  process.exit();
}
// GitHub's name for each: the test site's email key has one of its own.
const github = missing.map((n) => (target === "staging" && n === "RESEND_API_KEY" ? "RESEND_API_KEY_STAGING" : n));
const message = `Not set in GitHub (Settings → Secrets and variables → Actions) nor on the ${target} Worker: ${github.join(", ")}. See README "One-time setup".`;
if (target === "production") {
  console.error(`::error::${message}`);
  process.exit(1);
}
console.log(`::warning::${message}`);
