import { readFile } from "node:fs/promises";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { adminPage, REMOTE, SITE, signIn, unique } from "./site";

// The whole way through, as the launch checklist asks: sign up, get approved, make a group, add an
// expense, settle up, export. Runs with the other browser tests, and against the test site after
// each deploy to it (CI's deploy-staging job), where it tidies up after itself by deleting the
// group. Its two users stay behind, under example.com addresses.

/** Signs up through the form; the admin approves them unless the site lets everyone in at once. */
async function signUp(browser: Browser, name: string) {
  const email = unique(name.toLowerCase().replace(/\W+/g, "-"));
  const page = await (await browser.newContext()).newPage();
  await signIn(page, email);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign up" })).toBeVisible();
  await page.getByLabel("Display name").fill(name);
  await page.getByRole("button", { name: "Sign up" }).click();
  const hi = page.getByRole("heading", { name: `Hi, ${name}!` });
  const waiting = page.getByRole("heading", { name: "Waiting for approval" });
  await expect(hi.or(waiting)).toBeVisible();
  if (await waiting.isVisible()) {
    const admin = await adminPage(browser);
    await admin.getByRole("link", { name: "Admin" }).click();
    const row = admin.getByRole("listitem").filter({ hasText: email });
    await row.getByRole("button", { name: "Approve" }).click();
    await expect(row).toHaveCount(0);
    await admin.context().close();
    await page.reload();
  }
  await expect(hi).toBeVisible();
  return { page, email };
}

const balance = (page: Page, name: string) => page.locator(".balance-row").filter({ hasText: name });

test("sign up, get approved, share an expense, settle up and export", async ({ browser }) => {
  test.setTimeout(REMOTE ? 180_000 : 60_000);
  const { page: ana } = await signUp(browser, "Launch Ana");
  const { page: ben, email: benEmail } = await signUp(browser, "Launch Ben");

  // Ana makes a group and adds Ben.
  const group = `Launch check ${Math.random().toString(36).slice(2, 6)}`;
  await ana.getByRole("link", { name: "New group" }).click();
  await ana.getByLabel("Group name").fill(group);
  await ana.getByLabel("Currency").selectOption("USD");
  await ana.getByRole("button", { name: "Create group" }).click();
  await expect(ana.getByRole("heading", { name: group })).toBeVisible();
  await ana.getByLabel("Their Google email").fill(benEmail);
  await ana.getByRole("button", { name: "Add", exact: true }).click();
  await expect(ana.getByText("Launch Ben was added.")).toBeVisible();

  // She pays $42 for both of them.
  await ana.getByRole("link", { name: "Add expense" }).click();
  await ana.getByLabel("Description").fill("Groceries");
  await ana.getByLabel("Amount (USD)").fill("42");
  await ana.getByRole("button", { name: "Save expense" }).click();
  await expect(balance(ana, "Launch Ben")).toContainText("owes $21.00");
  await expect(ana.getByText("Launch Ben pays Launch Ana $21.00")).toBeVisible();

  // Ben pays her back as suggested, and she confirms it arrived.
  await ben.goto("/");
  await ben.getByRole("link", { name: new RegExp(group) }).click();
  await ben
    .locator(".suggestion-row")
    .filter({ hasText: "Launch Ben pays Launch Ana $21.00" })
    .getByRole("link", { name: "Pay" })
    .click();
  await expect(ben.getByLabel("Amount (USD)")).toHaveValue("21.00");
  await ben.getByRole("button", { name: "Record payment" }).click();
  await expect(ben.getByText("Waiting for Launch Ana to confirm it.")).toBeVisible();
  await ana.reload();
  await ana.getByRole("button", { name: "Received" }).click();
  await expect(balance(ana, "Launch Ben")).toContainText("settled up");
  await expect(balance(ana, "Launch Ana")).toContainText("settled up");

  // The records come out as a spreadsheet: the expense, then the payment (in the payee's column).
  const [download] = await Promise.all([
    ana.waitForEvent("download"),
    ana.getByRole("button", { name: "Download CSV" }).click(),
  ]);
  const csv = (await readFile(await download.path())).toString("utf8").split("\r\n");
  expect(csv[0]).toBe("﻿Date,Description,Type,Paid by,Total,Currency,Launch Ana,Launch Ben");
  expect(csv[1]).toMatch(/^\d{4}-\d{2}-\d{2},Groceries,Expense,Launch Ana,42\.00,USD,21\.00,21\.00$/);
  expect(csv[2]).toMatch(/^\d{4}-\d{2}-\d{2},Launch Ben paid Launch Ana,Payment,Launch Ben,21\.00,USD,21\.00,$/);

  // Settled, so the group can go (which keeps the test site tidy).
  ana.once("dialog", (d) => d.accept());
  await ana.getByRole("button", { name: "Delete group" }).click();
  await expect(ana.getByRole("heading", { name: "Hi, Launch Ana!" })).toBeVisible();
  expect(new URL(ana.url()).origin).toBe(SITE);
});
