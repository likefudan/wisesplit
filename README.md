# wisesplit

A Splitwise-like site for splitting expenses with friends: no ads, no limits. Runs on Cloudflare's free tier.

- **Production**: https://wisesplit.llmat.dev (goes live with the first Release run; planned for the launch PR)
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

Copy `.dev.vars.example` to `.dev.vars` first: it makes the local site a "local" one (sign-up works without Turnstile), names you as admin, and turns on the test login, so you can sign in without Google:

```sh
curl -i -X POST http://localhost:8787/api/test/login -H 'Origin: http://localhost:8787' \
  -H 'X-Test-Login-Secret: local-secret' -H 'Content-Type: application/json' -d '{"email":"you@gmail.com"}'
```

(For a browser, real Google sign-in is easier: add your OAuth client to `.dev.vars` as described there.)

### Accounts

- Sign-in is Google only (`src/worker/routes/auth.ts`: Authorization Code + PKCE, ID token checked with jose). The session cookie is HttpOnly and SameSite=Lax; every API write must carry this site's `Origin`.
- A Google account then signs up (display name + Turnstile) and waits on the admin's pending list, unless the admin has turned off *New sign-ups require approval* in `/admin/settings`. The daily sign-up cap and the pending-list cap are set there too. Rejected applicants may apply again at once.
- Admins are the Google emails in the `ADMIN_EMAILS` secret. Their own sign-up is approved at once.
- API routes for members use `requireApproved` from `src/worker/auth.ts` (`c.get("user")` is the user); admin routes use `requireAdmin`.
- `POST /api/test/login` signs in without Google for the browser tests. It works only when `ENVIRONMENT` is `local` or `staging` and `TEST_LOGIN_SECRET` is set; production never has it (a unit test and the post-deploy smoke test check).

### Groups

- Any approved user can create a group (`src/worker/routes/groups.ts`) and is its owner for good: the owner can remove members and delete the group but can't leave it. Each group has one currency from the fixed list in `src/shared/currencies.ts`, set at creation.
- Members add approved users by their Google email, or make an invite link (`/invite/<token>`, single use, 7 days; only the token's SHA-256 is stored). Someone new who signs up through a link skips the approval queue and the caps (Turnstile still applies) and lands in the group; someone already approved joins with one click. Links don't let in anyone already waiting for approval, rejected or deactivated, and stop working when their maker leaves the group or is deactivated (`src/worker/invites.ts`). A member may have 10 unused links at a time, across their groups.
- Someone with any expense involving them (paid or shared) can leave or be removed only while the whole group is settled up, and the group can be deleted only then; someone with none can leave any time. The checks are SQL inside the statements that remove or delete (`MAY_NOT_LEAVE_SQL`, `UNSETTLED_SQL` in `src/worker/groups.ts`), so an expense added at the same moment can't slip past them. PR 7 adds pending payments to them.

### Expenses and balances

- Any member adds an expense (`src/worker/routes/expenses.ts`): description, amount, one payer and the members sharing it, all of whom must be in the group, and a day (YYYY-MM-DD, not a time).
- Money is always a whole number of the currency's smallest unit (cents, yen); `src/shared/money.ts` reads what people type and formats it back. Each person's share is stored (`expense_shares`) and the shares add up to the amount: `spread` in `src/shared/expenses.ts` hands out the leftover units by a fixed rule (largest remainder, then smallest user id), so an equal split gives the first few by id one cent more. Only the equal split exists so far; the table already accepts the others, and stores what was entered for them (`split_params`).
- A balance is what someone paid minus their shares, worked out from the expenses each time (no stored totals to go stale).
- Each expense added also goes into `activity_log`, which later PRs add edits, deletions, payments and membership changes to.

### Languages

Every string on the pages comes from `src/shared/i18n.ts`, which holds an English and a Chinese table with the same keys. Add both when adding a message; the type checker catches a missing Chinese entry and `test/i18n.test.ts` checks the `{placeholders}` match. The chosen language is remembered in the browser; a first visit follows the browser's preferred language.

## Deploying

`.github/workflows/ci.yml` runs lint, typecheck, unit tests and browser tests on every pull request.

- **Merge to `main`** → the same checks, then deploy to staging (migrate its D1 database, deploy the `wisesplit-staging` Worker, smoke test it).
- **Release** → Actions → *Release* → *Run workflow* on `main` tags it `vYYYY.MM.DD` and deploys production after backing up its database. Running CI by hand on an older tag redeploys that version's code. It cannot undo database migrations, so only roll back to a tag that already has every migration in `migrations/` (otherwise restore the backup the release made, from that run's artifacts).

Each environment has its own Worker, D1 database and custom domain (`wrangler.jsonc`). CI finds the database by name, creating it on first deploy, and writes its id into `wrangler.jsonc` in place of the placeholder (`scripts/resolve-d1.mjs`).

### One-time setup

In the GitHub repository's *Settings → Secrets and variables → Actions*, add:

| Secret | What it is |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account that owns the `llmat.dev` zone |
| `CLOUDFLARE_API_TOKEN` | An API token with *Account: Workers Scripts: Edit*, *Account: D1: Edit*, *Zone (llmat.dev): Workers Routes: Edit* and *Zone (llmat.dev): DNS: Edit* |

For sign-in (each deploy copies these onto the Worker as secrets; one left unset keeps whatever the Worker has):

| Secret | What it is |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | A Google OAuth *Web application* client (Google Cloud console → Google Auth Platform → Clients; scopes `openid email profile`). Authorized redirect URIs: `https://wisesplit.llmat.dev/api/auth/google/callback` and `https://staging.wisesplit.llmat.dev/api/auth/google/callback` (plus `http://localhost:8787/api/auth/google/callback` for local use). The jaysbadminton client can be reused by adding these URIs. |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | A Cloudflare Turnstile widget (dashboard → Turnstile → Add widget, mode *Managed*) with hostnames `wisesplit.llmat.dev` and `staging.wisesplit.llmat.dev`. Without them the sites refuse sign-ups. |
| `ADMIN_EMAILS` | The admin's Google email (comma-separate several). |
| `TEST_LOGIN_SECRET_STAGING` | Optional: any long random string, to use the test login on staging. Never sent to production. |

The same Cloudflare token jaysbadminton uses works if it already has those permissions. The `staging.wisesplit.llmat.dev` and `wisesplit.llmat.dev` DNS records and certificates are created by `wrangler deploy` (custom domains); nothing needs to be added by hand.

Later PRs add more secrets (Resend, Web Push keys); each lists what it needs.
