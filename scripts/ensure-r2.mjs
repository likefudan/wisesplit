// CI helper: create the environment's R2 bucket (receipt photos) if it doesn't exist yet, so the
// deploy can bind it. Usage: node scripts/ensure-r2.mjs [production|staging]
import { spawnSync } from "node:child_process";

const BUCKETS = { production: "wisesplit-receipts", staging: "wisesplit-staging-receipts" };
const target = process.argv[2] ?? "production";
const name = BUCKETS[target];
if (!name) throw new Error(`unknown environment ${target}`);

const wrangler = (...args) => {
  const run = spawnSync("npx", ["wrangler", ...args], { encoding: "utf8" });
  if (run.error) throw run.error;
  return { ok: run.status === 0, output: `${run.stdout}${run.stderr}`.trim() };
};

const info = wrangler("r2", "bucket", "info", name);
if (info.ok) {
  console.log(`Using R2 bucket ${name}`);
} else {
  // Most likely the bucket isn't there yet; if creating it fails too, this says why the lookup did.
  console.log(info.output);
  console.log(`Creating R2 bucket ${name}`);
  const create = wrangler("r2", "bucket", "create", name);
  console.log(create.output);
  // The lookup failed for some other reason (a blip) and the bucket was there all along.
  if (!create.ok && !/already exists/i.test(create.output)) process.exit(1);
}
