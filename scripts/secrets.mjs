// Shared by the CI helpers that set Worker secrets (sync-secrets.mjs, ensure-vapid.mjs).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The environment named on the command line ("production" when none). */
export function targetEnvironment() {
  const target = process.argv[2] ?? "production";
  if (!["production", "staging"].includes(target)) throw new Error(`unknown environment ${target}`);
  return target;
}

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
