import { expect, test } from "@playwright/test";

test("the site can be installed: it has a manifest, icons and a service worker", async ({ page }) => {
  await page.goto("/");
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  const manifest = await (await page.request.get(href!)).json();
  expect(manifest).toMatchObject({ name: "wisesplit", start_url: "/", display: "standalone" });
  for (const icon of manifest.icons) expect((await page.request.get(icon.src)).status()).toBe(200);
  const apple = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href");
  expect((await page.request.get(apple!)).status()).toBe(200);
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toBe("http://localhost:8788/");
});

test("the notification settings say when push isn't set up on the site", async ({ page }) => {
  // The admin's own sign-up is approved at once. This local site has no VAPID key.
  const res = await page.request.post("/api/test/login", {
    headers: { "X-Test-Login-Secret": "e2e-secret", Origin: "http://localhost:8788" },
    data: { email: "admin@example.com", name: "Admin" },
  });
  expect(res.status()).toBe(204);
  await page.goto("/");
  const signupForm = page.getByRole("heading", { name: "Sign up" });
  await expect(page.getByRole("heading", { name: /^Hi, / }).or(signupForm)).toBeVisible();
  if (await signupForm.isVisible()) await page.getByRole("button", { name: "Sign up" }).click();
  await page.goto("/notifications/settings");
  await expect(page.getByText("Push notifications aren't set up on this site yet.")).toBeVisible();
});
