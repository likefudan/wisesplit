# wisesplit MVP: plan as a sequence of PRs

Source: [mvp-scope.md](mvp-scope.md). Repo likefudan/wisesplit, same stack as jaysbadminton (Hono + Preact/Vite on Workers, D1, R2, Turnstile, Resend). Written 2026-10-09. Nothing has been built yet; PR 0 comes first.

Principles:
- Every PR merges on its own and leaves staging (staging.wisesplit.llmat.dev) working, with no half-built pages.
- Every PR carries its own D1 migration (if any), API + Vitest tests, frontend pages, Chinese and English strings, and Playwright smoke tests where useful.
- i18n is in place from PR 0; each PR adds both languages as it goes, so there is no separate "translation PR".
- Money is always an integer in the currency's smallest unit, from the very first expense.

## Dependency order

```
PR0 Skeleton + deploy pipeline
 └─ PR1 Login + approval + profile
     └─ PR2 Groups and invites
         └─ PR3 Expenses: equal split + balances + activity log table
             ├─ PR4 Other split methods
             ├─ PR5 Edit/delete + activity log page
             ├─ PR6 Receipt photos (R2)
             └─ PR7 Debt simplification + settle-up (two-sided confirm, Venmo)
 PR8 In-app notifications (after PR5, PR7)
  ├─ PR9 Email notifications
  └─ PR10 PWA + Web Push
 PR11 CSV export (after PR4, PR5, PR7)
 PR12 Production launch (after everything)
```

PR4, PR5, PR6 and PR7 are independent and can be built in parallel.

---

## PR 0: Project skeleton and deploy pipeline
- Hono + Preact/Vite project layout, TypeScript, Biome, Vitest (Workers pool), Playwright.
- wrangler config for staging and production (one D1 database each). GitHub Actions: checks on every PR, merge to main deploys staging, a tag deploys production.
- staging.wisesplit.llmat.dev wired up, serving only a "hello" page and `/api/health`.
- i18n framework (zh/en toggle, stored in the browser for now; moves to the profile in PR 1).
- Split out on its own because Cloudflare, DNS and GitHub secrets are where setup usually gets stuck; getting them working before any features keeps problems easy to isolate.

## PR 1: Google login, admin approval, profile
Depends on: PR 0
- D1 `users` table: Google id, email, display name, avatar, Venmo username, language, status (pending / approved / rejected / deactivated).
- Google login (verified with jose), session cookie (HttpOnly, SameSite=Lax; write requests check Origin against CSRF).
- A "test login" endpoint available only locally and on staging so Playwright doesn't go through Google (must be off in production, with a test asserting that).
- Sign-up: Turnstile, daily sign-up cap, pause while the pending list is full.
- Admin console (admin = email in config): pending list, approve / reject, deactivate. Rejected applicants can re-apply immediately.
- `settings` table + admin settings page. First toggle: "New sign-ups require approval", on by default; when off, new users are approved immediately while Turnstile and the daily cap still apply.
- Profile page: display name, Venmo username, UI language.
- Later PRs assume this PR provides the auth middleware and the "must be an approved user" guard.

## PR 2: Groups, members and invites
Depends on: PR 1
- Tables: `groups` (name, currency, owner), `group_members`, `group_invites`.
- Create a group (currency picked from a fixed list of about ten common currencies with their decimal places; cannot change later), my-groups list, group page (member list; the expense area is empty for now).
- Invite approved users by email (added directly).
- Invite links: single-use, 7-day expiry. Someone not yet registered who signs in with Google through the link is **approved automatically** and joins the group (changes PR 1's sign-up flow: skips pending and the daily cap, still goes through Turnstile). An existing user who opens the link just joins.
- Owner can remove members and delete the group; ordinary members can leave. The owner cannot leave. There are no expenses yet, so the "must be settled before leaving / removal / deletion" check is a stub here: PR 3 wires in balances and PR 7 adds pending payments.
- Deactivated users still appear in member lists and history.

## PR 3: Expenses (equal split) and group balances
Depends on: PR 2
- Tables: `expenses` (description, integer amount, payer, date, split method and its parameters, creator) and `expense_shares` (each person's share). Split parameters (percentages, shares, adjustments) are stored as entered so the edit form can be restored later.
- `activity_log` table is created here and written from the first expense on, so later PRs write to it directly instead of waiting for PR 5.
- Money helpers: decimal places per currency (USD 2, JPY 0, etc.), input parsing and display formatting.
- Split calculation module + the "equal" method. Rounding remainders go out by a fixed rule (e.g. sorted by member id, the first few get 1 extra cent) so shares always sum to the total. Full unit tests.
- Add-expense form: description, amount, one payer, participants (whole group by default, any subset), date.
- Expense list (newest date first, paginated) and per-member balances (who owes / is owed how much).
- Wires in the PR 2 check: a member with related expenses can leave or be removed only when every member's balance is 0; a member with no related expenses can leave any time; a group with any non-zero balance cannot be deleted.

## PR 4: Other split methods
Depends on: PR 3
- Exact amounts (must sum to the total), percentages (must sum to 100%), shares, and equal with adjustments (some people pay a fixed amount more or less; everyone else splits the remainder).
- Rounding rules and validation for each method (the form shows the remaining difference live; the backend validates again).
- UI for switching split method in the form.
- Focus on unit tests: edge cases, negative adjustments, an error when adjustments leave a negative remainder, zero-decimal currencies like JPY.

## PR 5: Edit / delete expenses and the activity log page
Depends on: PR 3 (can run in parallel with PR 4; whichever merges second adds the cross tests)
- Any group member can edit or delete an expense (soft delete, kept for the log). The edit form reuses the add form and supports every split method that exists at the time.
- Edits carry a version number: when two people edit the same expense, the second to save sees "changed by someone else" instead of silently overwriting.
- Activity log entries record a before/after diff (JSON).
- "Activity" list on the group page.
- Joins, leaves and removals from PR 2 also go into the log.
- This log is also the event source for in-app notifications in PR 8.

## PR 6: Receipt photos
Depends on: PR 3
- R2 bucket (one each for staging and production).
- Compression in the browser (canvas, longest side about 1600px, JPEG quality about 0.7), EXIF stripped.
- Upload endpoint (size and type limits), at most one photo per expense; replace and delete.
- Photos are served through the Worker with an access check: only group members can view them.
- Deleting an expense deletes its photo (or orphaned files are cleaned up periodically).

## PR 7: Debt simplification and settle-up (two-sided confirmation, Venmo links)
Depends on: PR 3
- Debt simplification (greedy matching on net balances to minimize transfers), with unit tests.
- "Suggested payments" on the group page: who should pay whom and how much.
- `settlements` table: payer, payee, amount, method (Venmo / other), status (pending / confirmed / declined / withdrawn).
- Flow: payer taps "Pay" → in USD groups where the payee has a Venmo username, a prefilled Venmo link is generated → "Paid" → payee taps "Received" or "Decline".
- Cash and other methods can be recorded directly and also need the payee's confirmation; non-USD groups only have this option.
- The amount defaults to the suggested amount but is editable (partial payments), and any member can record a payment to any other member.
- Only confirmed payments count toward balances and debt simplification; pending ones are listed separately.
- The Venmo note is prefilled with the group name, e.g. "wisesplit: Camping weekend".
- The payer can withdraw a pending payment before it is confirmed.
- A payment with a deactivated user takes effect on the other party's confirmation alone.
- The leave / remove / delete-group check also requires no pending payments in the group.
- Settlement actions are written to the activity log.

## PR 8: In-app notifications
Depends on: PR 5, PR 7 (needs expense-change and payment events)
- `notifications` table and one shared "emit event → find affected users → write notification" module, which PR 9 and PR 10 extend with more channels.
- Events: an expense involving you is added / edited / deleted; someone asks you to confirm a payment; your payment is confirmed / declined; you were added to a group; your sign-up was approved / rejected.
- Bell icon with unread count in the header, notification list, mark as read.
- Notification settings page skeleton (in-app only for now; email and push toggles come in later PRs).

## PR 9: Email notifications
Depends on: PR 8
- Reuses jaysbadminton's Resend code, with Chinese and English templates (by the recipient's language).
- Email notifications can be turned off in settings.
- Mind the free tier of 100 emails/day: a failed send is only logged and never blocks the main action. Batching several notifications for one user is optional and can wait until after the MVP.
- The sign-up result email goes through this module too (if PR 1 already sends one, it is moved here).

## PR 10: PWA and Web Push
Depends on: PR 8
- Manifest, icons, service worker, "Add to Home Screen" support.
- VAPID keys (one pair each for staging and production, stored as wrangler secrets), `push_subscriptions` table.
- Web Push sent directly from Workers (encryption via Web Crypto); expired subscriptions are deleted automatically.
- Turn push on / off in settings; on iPhone, show instructions when the site is not yet on the Home Screen.

## PR 11: Group CSV export
Depends on: PR 4, PR 5, PR 7
- Any group member can export the group's expenses and payments as one CSV: date, description, type (expense / payment), payer, total, currency, and one column per member with their share.
- Only confirmed payments are exported; deleted expenses are left out (they stay visible in the activity log).
- UTF-8 with BOM so Chinese displays correctly in Excel; file name includes the group name and date.
- Non-members get 403.

## PR 12: Production launch
Depends on: everything above
- Check production D1 / R2 / secrets and bind the wisesplit.llmat.dev domain.
- An end-to-end Playwright run on staging (sign up → approve → create group → add expense → settle up → export).
- Mobile UI pass and small fixes; README with deploy and config instructions.
- Tag the first version to release to production.

---

## Rules confirmed 2026-10-09 (already in the scope doc)
1. A payment with a deactivated user takes effect on the other party's confirmation alone (PR 7).
2. Rejected applicants may re-apply immediately (PR 1).
3. The group owner cannot leave and ownership cannot be transferred; the owner can only delete the group once it is fully settled (PR 2).
4. Admin toggle "New sign-ups require approval", on by default, can be turned off (PR 1).
5. A member with any related expense can leave or be removed only when the whole group is settled (every balance 0 and no pending payments in the group); a member with no related expenses can leave any time (PR 3, PR 7).

## Optional adjustments
- To get something usable sooner: once PR 0–3 and PR 7 are merged, people can already add expenses and settle up, so a first version could be tagged to production then and the remaining PRs follow.
- If PR 4 turns out large, split it into "exact / percent / shares" and "equal with adjustments".
