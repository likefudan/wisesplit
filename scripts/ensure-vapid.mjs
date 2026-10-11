// CI helper: give the environment's Worker a VAPID key for Web Push (the VAPID_KEY secret, a
// P-256 private key as JWK) if it has none yet. A key it already has is never replaced: every
// browser's push subscription is tied to it. Each environment gets its own.
// Usage: node scripts/ensure-vapid.mjs [production|staging]
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const target = process.argv[2] ?? "production";
if (!["production", "staging"].includes(target)) throw new Error(`unknown environment ${target}`);
const envArgs = target === "staging" ? ["--env", "staging"] : [];

const list = spawnSync("npx", ["wrangler", "secret", "list", "--format", "json", ...envArgs], { encoding: "utf8" });
if (list.error) throw list.error;
// Only a list that was read for sure may lead to a new key; otherwise stop rather than risk replacing one.
const json = list.stdout.slice(list.stdout.indexOf("["), list.stdout.lastIndexOf("]") + 1);
let names;
try {
  names = JSON.parse(json).map((s) => s.name);
} catch {
  console.error(`${list.stdout}${list.stderr}`);
  console.error("::error::Could not list the Worker's secrets, so the VAPID key was not checked");
  process.exit(1);
}
if (list.status !== 0) {
  console.error(list.stderr);
  process.exit(1);
}
if (names.includes("VAPID_KEY")) {
  console.log(`The ${target} Worker has its VAPID key`);
  process.exit();
}

const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
const { kty, crv, x, y, d } = await crypto.subtle.exportKey("jwk", privateKey);
const dir = mkdtempSync(join(tmpdir(), "vapid-"));
const file = join(dir, "secrets.json");
try {
  writeFileSync(file, JSON.stringify({ VAPID_KEY: JSON.stringify({ kty, crv, x, y, d }) }), { mode: 0o600 });
  execFileSync("npx", ["wrangler", "secret", "bulk", file, ...envArgs], { stdio: "inherit" });
  console.log(`Gave the ${target} Worker a new VAPID key`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
