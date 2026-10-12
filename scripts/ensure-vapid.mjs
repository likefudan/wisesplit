// CI helper: give the environment's Worker a VAPID key for Web Push (the VAPID_KEY secret, a
// P-256 private key as JWK) if it has none yet. A key it already has is never replaced: every
// browser's push subscription is tied to it. Each environment gets its own.
// Usage: node scripts/ensure-vapid.mjs [production|staging]
import { listSecretNames, putSecrets, targetEnvironment } from "./secrets.mjs";

const target = targetEnvironment();

// Only a list read for sure may lead to a new key; otherwise stop rather than risk replacing one.
const names = listSecretNames(target);
if (!names) {
  console.error("::error::Could not list the Worker's secrets, so its VAPID key was not checked");
  process.exit(1);
}
if (names.includes("VAPID_KEY")) {
  console.log(`The ${target} Worker has its VAPID key`);
  process.exit();
}

const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
const { kty, crv, x, y, d } = await crypto.subtle.exportKey("jwk", privateKey);
putSecrets(target, { VAPID_KEY: JSON.stringify({ kty, crv, x, y, d }) });
console.log(`Gave the ${target} Worker a new VAPID key`);
