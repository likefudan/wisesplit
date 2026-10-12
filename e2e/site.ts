import { type Browser, expect, type Page } from "@playwright/test";

/**
 * Where the browser tests run: the throwaway local Worker by default, or a deployed site when
 * E2E_BASE_URL is set (CI runs launch.spec.ts against the test site after each deploy to it).
 */
export const SITE = process.env.E2E_BASE_URL ?? "http://localhost:8788";
export const REMOTE = !!process.env.E2E_BASE_URL;
/** That site's TEST_LOGIN_SECRET (scripts/e2e-server.sh sets the local one). */
const SECRET = process.env.E2E_TEST_LOGIN_SECRET ?? "e2e-secret";
/** One of that site's ADMIN_EMAILS. */
export const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";

/** An address of its own for each run; example.com is never emailed. */
export const unique = (name: string) => `${name}-${Math.random().toString(36).slice(2, 8)}@example.com`;

/** Signs this page's browser in as a Google identity through the test login. */
export async function signIn(page: Page, email: string, name = "Tester") {
  const res = await page.request.post("/api/test/login", {
    headers: { "X-Test-Login-Secret": SECRET, Origin: SITE },
    data: { email, name },
  });
  expect(res.status()).toBe(204);
}

/** A browser signed in as the admin, signed up if this is their first time on the site. */
export async function adminPage(browser: Browser) {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, ADMIN_EMAIL, "wisesplit e2e admin");
  await page.goto("/");
  const hi = page.getByRole("heading", { name: /^Hi, / });
  const signupForm = page.getByRole("heading", { name: "Sign up" });
  await expect(hi.or(signupForm)).toBeVisible();
  if (await signupForm.isVisible()) await page.getByRole("button", { name: "Sign up" }).click();
  await expect(hi).toBeVisible();
  return page;
}
