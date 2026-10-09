# wisesplit MVP scope

A Splitwise-like expense-splitting site for personal use and a circle of friends: no ads, no feature limits. Decided 2026-10-09.

## 1. Users and sign-up
- Open sign-up, **Google login only**.
- New users start as "pending" and can use the site only after the **site admin** approves them (same model as the badminton group site).
- Admin settings have a toggle, "New sign-ups require approval", **on by default**. When it is off, new users can use the site right after signing up and skip the pending list; Turnstile and the daily sign-up cap still apply.
- A rejected applicant may re-apply immediately.
- Admin console: view the pending list, approve / reject, deactivate users. A deactivated user's history is kept and stays visible to others. A settlement with a deactivated user takes effect on the other party's confirmation alone (the deactivated user cannot log in to confirm).
- The admin is identified by a Google email in config (Ke Li).
- Anti-bot:
  - Google accounts only
  - Cloudflare Turnstile challenge
  - Daily cap on new sign-ups (configurable)
  - Stop accepting sign-ups while the pending list is at its cap
- Profile: display name, avatar (from Google), **Venmo username**, UI language.

## 2. Groups
- Groups only; no one-to-one bills outside a group. Two people who share costs create a two-person group.
- Any approved user can create a group and becomes its owner.
- Members can invite approved users by email; the invitee is added to the group and notified.
- Members can also generate an **invite link** (single-use, expires after 7 days) for friends who have not signed up. A friend who signs up through it is approved automatically and joins the group. An already-registered user who opens the link just joins the group.
- The owner can remove members and delete the group.
- A member who has any expense involving them (paid by them or shared by them, whoever added it) can leave or be removed only when **the whole group is settled**: every member's balance is 0 and the group has no payments awaiting confirmation. A member with no related expenses can leave at any time.
- A group can be deleted only when it is fully settled in the same sense.
- The owner cannot leave the group (and ownership cannot be transferred); the owner can only delete the group once it is fully settled.
- **Each group has one fixed currency**, chosen when the group is created.

## 3. Expenses and split methods
Each expense: description, amount, **one payer**, participating members (whole group by default, any subset can be picked), date, split method, and an optional **single receipt photo** (compressed in the browser before upload to save R2 space).

Split methods:
- **Equal**
- **Exact amounts** (amounts must add up to the total)
- **Percentages** (must add up to 100%)
- **Shares** (e.g. one person counts as 2 shares)
- **Equal with adjustments**: some people pay a fixed amount more or less than the others, and everyone else splits the remainder equally.
  Example: 100 split among 4, Wang +10 → the other three pay 30 each, Wang pays 40.

Amounts are stored as integers in the currency's smallest unit (cents for USD, yen for JPY). Rounding remainders are assigned by a fixed rule so the shares always add up to the total.
Any group member can edit or delete any expense; every change goes into the group's activity log (who, when, what changed).

## 4. Balances and settling up
- The group page shows how much each member owes or is owed.
- **Debt simplification**: if A owes B and B owes C, A pays C directly, minimizing the number of transfers.
- Settle-up flow (both sides confirm):
  1. The payer taps "Pay"; the site builds a **Venmo payment link** prefilled with the payee's Venmo username, the amount and a note. Venmo is USD-only, so this button appears only in USD groups and only when the payee has a Venmo username.
  2. After paying, the payer taps "Paid".
  3. The payment counts toward balances only after the payee taps "Received".
  4. The payee can also decline it (e.g. the money never arrived).
- A payment made outside Venmo (cash etc.) can be recorded directly and also needs the payee's confirmation. This is the only option in non-USD groups.
- The amount defaults to the suggested amount but can be changed (partial payments allowed), and a payment can be recorded between any two members, not only the suggested pairs.
- Payments awaiting confirmation are listed separately and do not affect balances or debt simplification.

## 5. Notifications
- **In-app**: someone added, edited or deleted an expense involving you; someone asks you to confirm a payment; your payment was confirmed / declined; you were added to a group; your sign-up was approved / rejected.
- **Email**: the same events; can be turned off in settings.
- **Web Push**: the same events, enabled once the user allows it in the browser, and can be turned off separately. Works directly on Android and desktop browsers; on iPhone the site must first be added to the Home Screen (iOS 16.4+).

## 6. Export
- A group member can export **all of the group's records** as one CSV file (expenses and confirmed payments; each expense lists every member's share).
- Only members of that group can export it; no combined export across groups.
- The CSV is UTF-8 with a BOM so Chinese text displays correctly in Excel.

## 7. Platform and UI
- Mobile-first responsive web app with "Add to Home Screen" (PWA); no native app.
- UI **switchable between Chinese and English**.

## 8. Tech and hosting (target $0/month, all on Cloudflare, same stack as jaysbadminton)
- Backend: **Hono** on **Cloudflare Workers**
- Frontend: **Preact + Vite** SPA served by Workers Assets
- Database: **Cloudflare D1**, schema managed with wrangler migrations
- Receipt photos: **Cloudflare R2** (10 GB free)
- Web Push: standard Web Push (VAPID), sent directly from Workers, no third-party service
- Bot protection: **Cloudflare Turnstile**
- Login: Google OAuth verified with jose, same as jaysbadminton
- Email: **Resend** (free tier: 3,000/month, 100/day), already used by jaysbadminton
- Tooling: TypeScript, Biome, Vitest (Workers pool), Playwright
- Deployment: staging and production like jaysbadminton; merging to main auto-deploys staging, a version tag releases to production
- Domains: **wisesplit.llmat.dev**, staging at **staging.wisesplit.llmat.dev** (on the existing llmat.dev domain)
- Code to borrow from jaysbadminton: Google login, pending-list cap, Resend email, Venmo pay links, cent-based amounts, CSV export, activity log

## Not in v1
Multiple payers per expense, bills outside groups, multiple currencies and conversion, native app, multiple photos per expense, recurring expenses, charts and stats, cross-group export, comments.
