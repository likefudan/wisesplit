#!/bin/sh
# Starts a throwaway local site for the browser tests: its own database under .wrangler/e2e,
# migrated from scratch, on port 8788. Needs `npm run build` first (the tests' npm script does it).
set -e
cd "$(dirname "$0")/.."
rm -rf .wrangler/e2e
npx wrangler d1 migrations apply DB --local --persist-to .wrangler/e2e > /dev/null
# The tests sign up more people in one run than the default daily cap (20) lets in.
npx wrangler d1 execute DB --local --persist-to .wrangler/e2e \
  --command "INSERT INTO settings (key, value) VALUES ('daily_signup_cap', '1000')" > /dev/null
# A local site with the test login on and one admin the tests sign in as, and without Google or
# Turnstile. Every setting is given here, so a developer's .dev.vars (which wrangler would load
# otherwise) changes nothing.
exec npx wrangler dev --port 8788 --persist-to .wrangler/e2e --show-interactive-dev-session=false \
  --env-file /dev/null \
  --var ENVIRONMENT:local --var TEST_LOGIN_SECRET:e2e-secret --var ADMIN_EMAILS:admin@example.com \
  --var SITE_ORIGIN:http://localhost:8788
