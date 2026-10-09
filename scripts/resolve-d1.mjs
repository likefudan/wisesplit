// CI helper: find (or create) the D1 database for an environment and write its id into
// wrangler.jsonc, replacing the placeholder used for local development and tests.
// Usage: node scripts/resolve-d1.mjs [production|staging]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const ENVS = {
  production: { name: "wisesplit", placeholder: "00000000-0000-0000-0000-000000000000" },
  staging: { name: "wisesplit-staging", placeholder: "11111111-1111-1111-1111-111111111111" },
};
const target = process.argv[2] ?? "production";
const { name: NAME, placeholder: PLACEHOLDER } =
  ENVS[target] ??
  (() => {
    throw new Error(`unknown environment ${target}`);
  })();

const wrangler = (...args) => execFileSync("npx", ["wrangler", ...args], { encoding: "utf8" });
const find = () => JSON.parse(wrangler("d1", "list", "--json")).find((db) => db.name === NAME);

let db = find();
if (!db) {
  console.log(`Creating D1 database ${NAME}`);
  wrangler("d1", "create", NAME);
  // The list can lag a moment behind the create.
  for (let attempt = 0; attempt < 6 && !db; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 5_000));
    db = find();
  }
}
if (!db) throw new Error(`D1 database ${NAME} not found after create`);

const config = readFileSync("wrangler.jsonc", "utf8");
if (!config.includes(PLACEHOLDER)) throw new Error(`database_id placeholder for ${target} missing from wrangler.jsonc`);
writeFileSync("wrangler.jsonc", config.replace(PLACEHOLDER, db.uuid));
console.log(`Using D1 database ${NAME} (${db.uuid}) for ${target}`);
