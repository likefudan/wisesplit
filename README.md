# wisesplit

A Splitwise-like site for splitting expenses with friends: no ads, no limits. Runs on Cloudflare's free tier.

- **Production**: https://wisesplit.llmat.dev (goes live at the launch PR)
- **Staging**: https://staging.wisesplit.llmat.dev (yellow "test site" banner; its own data)

What it will do: [docs/mvp-scope.md](docs/mvp-scope.md). How it is being built, PR by PR: [docs/pr-plan.md](docs/pr-plan.md).

## Stack

- Backend: [Hono](https://hono.dev) on Cloudflare Workers (`src/worker`)
- Frontend: Preact + Vite single-page app, served by Workers Assets (`src/web`)
- Code shared by both: `src/shared` (security headers, the zh/en message tables)
- Database: Cloudflare D1, schema in `migrations/`
- Tooling: TypeScript, Biome, Vitest (Workers pool, `test/`), Playwright (`e2e/`)

## Developing

```sh
npm install
npm run dev          # build the pages, then serve everything on http://localhost:8787
npm run lint         # Biome; `npm run format` fixes what it can
npm run typecheck
npm test             # unit and API tests in the Workers runtime
npm run test:e2e     # browser tests against a throwaway local Worker on port 8788
```

The local database lives under `.wrangler/`; `npm run db:migrate:local` applies new migrations to it.

### Languages

Every string on the pages comes from `src/shared/i18n.ts`, which holds an English and a Chinese table with the same keys. Add both when adding a message; the type checker catches a missing Chinese entry and `test/i18n.test.ts` checks the `{placeholders}` match. The chosen language is remembered in the browser; a first visit follows the browser's preferred language.

## Deploying

`.github/workflows/ci.yml` runs lint, typecheck, unit tests and browser tests on every pull request.

- **Merge to `main`** → the same checks, then deploy to staging (migrate its D1 database, deploy the `wisesplit-staging` Worker, smoke test it).
- **Release** → Actions → *Release* → *Run workflow* on `main` tags it `vYYYY.MM.DD` and deploys production after backing up its database. Running CI by hand on an older tag rolls production back to it.

Each environment has its own Worker, D1 database and custom domain (`wrangler.jsonc`). CI finds the database by name, creating it on first deploy, and writes its id into `wrangler.jsonc` in place of the placeholder (`scripts/resolve-d1.mjs`).

### One-time setup

In the GitHub repository's *Settings → Secrets and variables → Actions*, add:

| Secret | What it is |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account that owns the `llmat.dev` zone |
| `CLOUDFLARE_API_TOKEN` | An API token with *Account: Workers Scripts: Edit*, *Account: D1: Edit*, *Zone (llmat.dev): Workers Routes: Edit* and *Zone (llmat.dev): DNS: Edit* |

The same token jaysbadminton uses works if it already has those permissions. The `staging.wisesplit.llmat.dev` and `wisesplit.llmat.dev` DNS records and certificates are created by `wrangler deploy` (custom domains); nothing needs to be added by hand.

Later PRs add more secrets (Google sign-in, Turnstile, Resend, Web Push keys); each lists what it needs.
