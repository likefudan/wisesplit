import { type Browser, expect, type Page, test } from "@playwright/test";

const ADMIN = "admin@example.com";
const unique = (name: string) => `${name}-${Math.random().toString(36).slice(2, 8)}@example.com`;

/** Signs this page's browser in as a Google identity through the local test login. */
async function signIn(page: Page, email: string, name = "Tester") {
  const res = await page.request.post("/api/test/login", {
    headers: { "X-Test-Login-Secret": "e2e-secret", Origin: "http://localhost:8788" },
    data: { email, name },
  });
  expect(res.status()).toBe(204);
}

/** A browser signed in as the admin, who is approved on signing up. */
async function adminPage(browser: Browser) {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, ADMIN, "Admin");
  await page.goto("/");
  // The first test to get here signs the admin up; later ones find them signed up already.
  const signedUp = page.getByRole("heading", { name: /^Hi, / });
  const signupForm = page.getByRole("heading", { name: "Sign up" });
  await expect(signedUp.or(signupForm)).toBeVisible();
  if (await signupForm.isVisible()) await page.getByRole("button", { name: "Sign up" }).click();
  await expect(signedUp).toBeVisible();
  return page;
}

async function signUp(page: Page, email: string, name: string) {
  await signIn(page, email);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign up" })).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
  await page.getByLabel("Display name").fill(name);
  await page.getByRole("button", { name: "Sign up" }).click();
}

test("a newcomer signs up, waits, and is let in once the admin approves", async ({ page, browser }) => {
  await signUp(page, unique("newcomer"), "Newcomer Nia");
  await expect(page.getByRole("heading", { name: "Waiting for approval" })).toBeVisible();

  const admin = await adminPage(browser);
  await admin.getByRole("link", { name: "Admin" }).click();
  const row = admin.getByRole("listitem").filter({ hasText: "Newcomer Nia" });
  await row.getByRole("button", { name: "Approve" }).click();
  await expect(row).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Hi, Newcomer Nia!" })).toBeVisible();
  // Not an admin: no way into the console.
  await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);
  await page.goto("/admin");
  await expect(page).toHaveURL("/");
});

test("a rejected applicant can apply again straight away", async ({ page, browser }) => {
  await signUp(page, unique("rejected"), "Rejected Rob");
  const admin = await adminPage(browser);
  await admin.goto("/admin");
  await admin.getByRole("listitem").filter({ hasText: "Rejected Rob" }).getByRole("button", { name: "Reject" }).click();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign-up not approved" })).toBeVisible();
  await page.getByLabel("Display name").fill("Robert");
  await page.getByRole("button", { name: "Apply again" }).click();
  await expect(page.getByRole("heading", { name: "Waiting for approval" })).toBeVisible();

  await admin.reload();
  await expect(admin.getByRole("listitem").filter({ hasText: "Robert" })).toBeVisible();
});

test("with approval turned off, new users get in at once", async ({ page, browser }) => {
  const admin = await adminPage(browser);
  await admin.goto("/admin/settings");
  const toggle = admin.getByLabel("New sign-ups require approval");
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await admin.getByRole("button", { name: "Save settings" }).click();
  await expect(admin.getByText("Settings saved.")).toBeVisible();
  try {
    await signUp(page, unique("instant"), "Instant Ida");
    await expect(page.getByRole("heading", { name: "Hi, Instant Ida!" })).toBeVisible();
  } finally {
    await toggle.check();
    await admin.getByRole("button", { name: "Save settings" }).click();
    await expect(admin.getByText("Settings saved.")).toBeVisible();
  }
});

test("the profile saves a Venmo username and the language, which follows the account", async ({ page, browser }) => {
  const admin = await adminPage(browser);
  const email = unique("profile");
  await signUp(page, email, "Profile Pat");
  await admin.goto("/admin");
  await admin.getByRole("listitem").filter({ hasText: email }).getByRole("button", { name: "Approve" }).click();

  await page.goto("/profile");
  await page.getByLabel("Venmo username").fill("@pat-pays");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(page.getByLabel("Venmo username")).toHaveValue("pat-pays");
  // The language applies (and is saved) as soon as it is picked.
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/me") && r.request().method() === "POST");
  await page.getByLabel("Language").selectOption("zh");
  await expect(page.getByRole("heading", { name: "个人资料" })).toBeVisible();
  expect((await saved).ok()).toBe(true);
  await expect(page.getByLabel("Venmo 用户名")).toHaveValue("pat-pays");

  // Another browser signed in to the same account opens in Chinese too.
  const other = await (await browser.newContext({ locale: "en-US" })).newPage();
  await signIn(other, email);
  await other.goto("/");
  await expect(other.getByRole("heading", { name: "你好，Profile Pat！" })).toBeVisible();
  // The header switch saves to the profile as well.
  await other.getByRole("button", { name: "English" }).click();
  await expect(other.getByRole("heading", { name: "Hi, Profile Pat!" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
});

test("signed-out visitors to a members' page see the sign-in page", async ({ page }) => {
  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "Hello!" })).toBeVisible();
  // No Google keys on the local test site.
  await expect(page.getByText("Google sign-in is not set up on this site yet.")).toBeVisible();
});

test("a failed Google sign-in says why", async ({ page }) => {
  await page.goto("/login?error=cancelled");
  await expect(page.getByRole("alert")).toHaveText("Sign-in was cancelled.");
});

test("signing out from the profile", async ({ page, browser }) => {
  await adminPage(browser);
  await signIn(page, ADMIN);
  await page.goto("/profile");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Hello!" })).toBeVisible();
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Hello!" })).toBeVisible();
});

test("the Google button leaves the app for the Worker's sign-in, remembering the page", async ({ page }) => {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ json: { googleEnabled: true, turnstileSiteKey: null, identity: null, user: null } }),
  );
  await page.route("**/api/auth/google?*", (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>Off to Google</h1>" }),
  );
  await page.goto("/profile");
  await page.getByRole("link", { name: "Sign in with Google" }).click();
  await expect(page.getByRole("heading", { name: "Off to Google" })).toBeVisible();
  await expect(page).toHaveURL("/api/auth/google?next=%2Fprofile");
});
