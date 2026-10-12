import { expect, type Page, test } from "@playwright/test";
import { adminPage, signIn, unique } from "./site";

// The smallest phones still in use are 320 CSS pixels wide. With long names, descriptions and
// amounts, no page may scroll sideways there (a scrolling strip inside a page, like the admin's
// tabs, is fine).
test.use({ viewport: { width: 320, height: 640 } });

async function fitsTheScreen(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator("main h1")).toBeVisible();
  const { scrollWidth, clientWidth } = await page.evaluate(() => {
    const { scrollWidth, clientWidth } = document.documentElement;
    return { scrollWidth, clientWidth };
  });
  expect(scrollWidth, `${path} is wider than the screen`).toBeLessThanOrEqual(clientWidth);
}

test("no page scrolls sideways on a small phone", async ({ browser }) => {
  const admin = await adminPage(browser);

  async function newcomer(name: string) {
    const email = unique("narrow");
    const page = await (await browser.newContext()).newPage();
    await signIn(page, email);
    await page.goto("/");
    await page.getByLabel("Display name").fill(name);
    await page.getByRole("button", { name: "Sign up" }).click();
    await expect(page.getByRole("heading", { name: "Waiting for approval" })).toBeVisible();
    return { page, email };
  }
  const ana = await newcomer("Alexandria Montgomery-Fitzgerald");
  const ben = await newcomer("Bartholomew Christophersen");
  await newcomer("Someone Still Waiting With A Long Name");
  await admin.goto("/admin");
  for (const { email } of [ana, ben]) {
    const row = admin.getByRole("listitem").filter({ hasText: email });
    await row.getByRole("button", { name: "Approve" }).click();
    await expect(row).toHaveCount(0);
  }
  await fitsTheScreen(admin, "/admin");

  const page = ana.page;
  await page.goto("/groups/new");
  await page.getByLabel("Group name").fill("Summer vacation in the Italian Dolomites with everyone");
  await page.getByLabel("Currency").selectOption("JPY");
  await page.getByRole("button", { name: "Create group" }).click();
  await page.getByLabel("Their Google email").fill(ben.email);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Bartholomew Christophersen was added.")).toBeVisible();
  const group = new URL(page.url()).pathname;
  await page.getByRole("link", { name: "Add expense" }).click();
  await page.getByLabel("Description").fill("Hotel for the whole week, breakfast and parking included");
  await page.getByLabel("Amount (JPY)").fill("123456789");
  await page.getByRole("button", { name: "Save expense" }).click();
  await expect(page.locator("details.expense")).toHaveCount(1);

  for (const path of [
    "/",
    group,
    `${group}/expenses/new`,
    `${group}/pay`,
    "/profile",
    "/notifications",
    "/notifications/settings",
  ])
    await fitsTheScreen(page, path);
});
