import { expect, test } from "@playwright/test";

test("home page says hello in the browser's language", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Hello!" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test("the language switch changes the page and is remembered after a reload", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "中文" }).click();
  await expect(page.getByRole("heading", { name: "你好！" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");

  await page.reload();
  await expect(page.getByRole("heading", { name: "你好！" })).toBeVisible();
  await page.getByRole("button", { name: "English" }).click();
  await expect(page.getByRole("heading", { name: "Hello!" })).toBeVisible();
});

test.describe("a browser that prefers Chinese", () => {
  test.use({ locale: "zh-CN" });

  test("starts in Chinese", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "你好！" })).toBeVisible();
  });
});

test("unknown pages show a not-found page with a way home", async ({ page }) => {
  await page.goto("/no-such-page");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await page.getByRole("link", { name: "Back to the home page" }).click();
  await expect(page.getByRole("heading", { name: "Hello!" })).toBeVisible();
});

test("the privacy policy and terms are public and linked from the front page", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Privacy Policy" }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole("heading", { name: "Privacy Policy" })).toBeVisible();
  await expect(page.getByText(/Limited Use requirements/)).toBeVisible();
  await page.getByRole("link", { name: "Terms of Service" }).click();
  await expect(page.getByRole("heading", { name: "Terms of Service" })).toBeVisible();
  await page.getByRole("button", { name: "中文" }).click();
  await expect(page.getByRole("heading", { name: "服务条款" })).toBeVisible();

  await page.goto("/privacy");
  await expect(page.getByRole("heading", { name: "隐私政策" })).toBeVisible();
});
