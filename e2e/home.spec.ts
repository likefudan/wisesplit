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
