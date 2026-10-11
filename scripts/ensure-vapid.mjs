// CI helper: give the environment's Worker a VAPID key for Web Push (the VAPID_KEY secret, a
// P-256 private key as JWK) if it has none yet. A key it already has is never replaced: every
// browser's push subscription is tied to it. Each environment gets its own.
// Usage: node scripts/ensure-vapid.mjs [production|staging]
import { spawnSync } from "node:child_process";
import { envArgs, putSecrets, targetEnvironment } from "./secrets.mjs";

const target = targetEnvironment();

const list = spawnSync("npx", ["wrangler", "secret", "list", "--format", "json", ...envArgs(target)], {
  encoding: "utf8",
});
if (list.error) throw list.error;
// Only a list read for sure may lead to a new key; otherwise stop rather than risk replacing one.
// The JSON is the array on stdout (from a line starting "[{" or "[]" to the last "]"), whatever
// wrangler prints around it.
let names = null;
const start = list.stdout.search(/^\s*\[\s*(\{|\])/m);
if (list.status === 0 && start >= 0)
  try {
    names = JSON.parse(list.stdout.slice(start, list.stdout.lastIndexOf("]") + 1)).map((s) => s.name);
  } catch {
    // Reported below.
  }
if (!names) {
  console.error(`${list.stdout}${list.stderr}`);
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
