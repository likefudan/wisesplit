import { defineConfig } from "@playwright/test";
import { REMOTE, SITE } from "./e2e/site";

/**
 * Browser tests against a local Worker with a fresh database (scripts/e2e-server.sh).
 * Run with `npm run test:e2e`; CI runs them before deploying.
 *
 * With E2E_BASE_URL (plus E2E_TEST_LOGIN_SECRET and E2E_ADMIN_EMAIL, see e2e/site.ts) only the
 * launch check runs, against that deployed site: `npm run test:e2e:staging`.
 */
export default defineConfig({
  testDir: "e2e",
  testMatch: REMOTE ? "launch.spec.ts" : undefined,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: SITE,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    // Not on a deployed site: a trace records the test login's secret.
    trace: REMOTE ? "off" : "retain-on-failure",
    // A preinstalled Chromium elsewhere (e.g. a sandbox) instead of Playwright's own download.
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  webServer: REMOTE
    ? undefined
    : {
        command: "sh scripts/e2e-server.sh",
        url: "http://localhost:8788/api/health",
        timeout: 120_000,
        reuseExistingServer: false,
      },
});
