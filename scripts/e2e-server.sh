#!/bin/sh
# Starts a throwaway local site for the browser tests: its own database under .wrangler/e2e,
# migrated from scratch, on port 8788. Needs `npm run build` first (the tests' npm script does it).
set -e
cd "$(dirname "$0")/.."
rm -rf .wrangler/e2e
npx wrangler d1 migrations apply DB --local --persist-to .wrangler/e2e > /dev/null
# A local site (no Turnstile), the test login on, and one admin the tests sign in as. These win
# over a developer's .dev.vars.
exec npx wrangler dev --port 8788 --persist-to .wrangler/e2e --show-interactive-dev-session=false \
  --var ENVIRONMENT:local --var TEST_LOGIN_SECRET:e2e-secret --var ADMIN_EMAILS:admin@example.com \
  --var SITE_ORIGIN:http://localhost:8788
