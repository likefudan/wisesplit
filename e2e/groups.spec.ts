import { type Browser, expect, type Page, test } from "@playwright/test";

const unique = (name: string) => `${name}-${Math.random().toString(36).slice(2, 8)}@example.com`;

/** Signs this page's browser in as a Google identity through the local test login. */
async function signIn(page: Page, email: string, name = "Tester") {
  const res = await page.request.post("/api/test/login", {
    headers: { "X-Test-Login-Secret": "e2e-secret", Origin: "http://localhost:8788" },
    data: { email, name },
  });
  expect(res.status()).toBe(204);
}

/** A signed-up, approved user in a browser of their own: the admin approves on signing up. */
async function approvedUser(browser: Browser, email: string, name: string) {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, email, name);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign up" })).toBeVisible();
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.getByRole("heading", { name: "Waiting for approval" })).toBeVisible();
  const admin = await (await browser.newContext()).newPage();
  await signIn(admin, "admin@example.com", "Admin");
  await admin.goto("/");
  const signupForm = admin.getByRole("heading", { name: "Sign up" });
  await expect(admin.getByRole("heading", { name: /^Hi, / }).or(signupForm)).toBeVisible();
  if (await signupForm.isVisible()) await admin.getByRole("button", { name: "Sign up" }).click();
  await admin.goto("/admin");
  await admin.getByRole("listitem").filter({ hasText: email }).getByRole("button", { name: "Approve" }).click();
  await expect(admin.getByRole("listitem").filter({ hasText: email })).toHaveCount(0);
  await admin.context().close();
  await page.reload();
  await expect(page.getByRole("heading", { name: `Hi, ${name}!` })).toBeVisible();
  return page;
}

async function createGroup(page: Page, name: string, currency: string) {
  await page.goto("/");
  await page.getByRole("link", { name: "New group" }).click();
  await page.getByLabel("Group name").fill(name);
  await page.getByLabel("Currency").selectOption(currency);
  await page.getByRole("button", { name: "Create group" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

const member = (page: Page, name: string) => page.locator(".user-row").filter({ hasText: name });

test("create a group, add a friend by email, and they can leave", async ({ browser }) => {
  const ownerEmail = unique("owner");
  const owner = await approvedUser(browser, ownerEmail, "Owner Olga");
  const friendEmail = unique("friend");
  const friend = await approvedUser(browser, friendEmail, "Friend Finn");

  await createGroup(owner, "Beach trip", "EUR");
  await expect(owner.getByText("Currency: EUR")).toBeVisible();
  await expect(member(owner, "Owner Olga")).toContainText("owner");

  await owner.getByLabel("Their Google email").fill("nobody@example.com");
  await owner.getByRole("button", { name: "Add", exact: true }).click();
  await expect(owner.getByRole("alert")).toContainText("No wisesplit user has this email");
  await owner.getByLabel("Their Google email").fill(friendEmail.toUpperCase());
  await owner.getByRole("button", { name: "Add", exact: true }).click();
  await expect(owner.getByText("Friend Finn was added.")).toBeVisible();
  await expect(member(owner, "Friend Finn")).toBeVisible();

  // The friend finds it on their front page.
  await friend.goto("/");
  await friend.getByRole("link", { name: /Beach trip/ }).click();
  await expect(friend.getByRole("heading", { name: "Beach trip" })).toBeVisible();
  await expect(friend.getByRole("button", { name: "Delete group" })).toHaveCount(0);
  friend.once("dialog", (d) => d.accept());
  await friend.getByRole("button", { name: "Leave group" }).click();
  await expect(friend.getByRole("heading", { name: "Hi, Friend Finn!" })).toBeVisible();
  await expect(friend.getByText("You are not in any group yet.")).toBeVisible();

  // The owner can't leave, only delete.
  await owner.reload();
  await expect(member(owner, "Friend Finn")).toHaveCount(0);
  await expect(owner.getByRole("button", { name: "Leave group" })).toHaveCount(0);
  owner.once("dialog", (d) => d.accept());
  await owner.getByRole("button", { name: "Delete group" }).click();
  await expect(owner.getByText("You are not in any group yet.")).toBeVisible();
});

test("the owner removes a member", async ({ browser }) => {
  const owner = await approvedUser(browser, unique("owner2"), "Owner Oscar");
  const friendEmail = unique("friend2");
  await approvedUser(browser, friendEmail, "Friend Fay");
  await createGroup(owner, "Flat", "USD");
  await owner.getByLabel("Their Google email").fill(friendEmail);
  await owner.getByRole("button", { name: "Add", exact: true }).click();
  owner.once("dialog", (d) => d.accept());
  await member(owner, "Friend Fay").getByRole("button", { name: "Remove" }).click();
  await expect(member(owner, "Friend Fay")).toHaveCount(0);
});

test("a friend without an account signs up through an invite link and is in at once", async ({ browser, context }) => {
  const owner = await approvedUser(browser, unique("inviter"), "Inviter Ivy");
  await createGroup(owner, "Ski week", "JPY");
  await owner.getByRole("button", { name: "Make an invite link" }).click();
  const link = await owner.getByRole("textbox", { name: /^Invite link/ }).inputValue();
  expect(link).toMatch(/^http:\/\/localhost:8788\/invite\/[\w-]{43}$/);

  // Signed out, the link says what it is for and offers Google sign-in.
  const guest = await context.newPage();
  await guest.goto(link);
  await expect(guest.getByText("Inviter Ivy invited you to join “Ski week” on wisesplit.")).toBeVisible();
  await expect(guest.getByText("Google sign-in is not set up on this site yet.")).toBeVisible();

  // Signed in with Google (approval is on by default), they sign up and land in the group.
  await signIn(guest, unique("newbie"), "Newbie Nora");
  await guest.reload();
  await guest.getByRole("button", { name: "Sign up" }).click();
  await expect(guest.getByRole("heading", { name: "Ski week" })).toBeVisible();
  await expect(member(guest, "Inviter Ivy")).toBeVisible();
  await guest.goto("/");
  await expect(guest.getByRole("heading", { name: "Hi, Newbie Nora!" })).toBeVisible();

  // The link is used up.
  const late = await (await browser.newContext()).newPage();
  await late.goto(link);
  await expect(late.getByText("This invite link has already been used.")).toBeVisible();
  // While the one who used it is sent to the group.
  await guest.goto(link);
  await guest.getByRole("button", { name: "Open the group" }).click();
  await expect(guest.getByRole("heading", { name: "Ski week" })).toBeVisible();
});

test("someone already signed up joins through an invite link with one click", async ({ browser }) => {
  const owner = await approvedUser(browser, unique("inviter2"), "Inviter Ian");
  const friend = await approvedUser(browser, unique("joiner"), "Joiner Jo");
  await createGroup(owner, "Book club", "GBP");
  await owner.getByRole("button", { name: "Make an invite link" }).click();
  await friend.goto(await owner.getByRole("textbox", { name: /^Invite link/ }).inputValue());
  await friend.getByRole("button", { name: "Join group" }).click();
  await expect(friend.getByRole("heading", { name: "Book club" })).toBeVisible();
  await owner.reload();
  await expect(member(owner, "Joiner Jo")).toBeVisible();
});

test("add expenses, see who owes whom, and leave once settled", async ({ browser }) => {
  const owner = await approvedUser(browser, unique("payer"), "Payer Pat");
  const friendEmail = unique("sharer");
  const friend = await approvedUser(browser, friendEmail, "Sharer Sam");
  await createGroup(owner, "Road trip", "USD");
  await owner.getByLabel("Their Google email").fill(friendEmail);
  await owner.getByRole("button", { name: "Add", exact: true }).click();
  await expect(owner.getByText("Sharer Sam was added.")).toBeVisible();
  await expect(owner.getByText("No expenses yet.")).toBeVisible();

  // 30.01 split equally: one of them pays the extra cent, and the form shows each share as it's typed.
  await owner.getByRole("link", { name: "Add expense" }).click();
  await owner.getByLabel("Description").fill("Gas");
  await owner.getByLabel("Amount (USD)").fill("abc");
  await owner.getByRole("button", { name: "Save expense" }).click();
  await expect(owner.getByText("Enter an amount such as 12.50.")).toBeVisible();
  await owner.getByLabel("Amount (USD)").fill("30.01");
  await expect(owner.getByText("$15.01")).toBeVisible();
  await expect(owner.getByText("$15.00")).toBeVisible();
  await owner.getByLabel("Date").fill("2026-10-03");
  await owner.getByRole("button", { name: "Save expense" }).click();

  await expect(owner.getByRole("heading", { name: "Road trip" })).toBeVisible();
  const gas = owner.getByRole("listitem").filter({ hasText: "Gas" });
  await expect(gas).toContainText("Oct 3, 2026 · Payer Pat paid $30.01");
  await expect(gas).toContainText(/you lent \$15\.0[01]/);
  const balance = (page: Page, name: string) => page.locator(".balance-row").filter({ hasText: name });
  await expect(balance(owner, "Payer Pat")).toContainText(/gets back \$15\.0[01]/);
  await expect(balance(owner, "Sharer Sam")).toContainText(/owes \$15\.0[01]/);

  // The friend owes money, so can't leave yet.
  await friend.goto("/");
  await friend.getByRole("link", { name: /Road trip/ }).click();
  await expect(friend.getByRole("listitem").filter({ hasText: "Gas" })).toContainText(/you borrowed \$15\.0[01]/);
  friend.once("dialog", (d) => d.accept());
  await friend.getByRole("button", { name: "Leave group" }).click();
  await expect(friend.getByRole("alert")).toContainText("Everyone in the group needs to be settled up first.");

  // An expense paid by the friend, for the owner only, evens it up (in Chinese this time).
  await friend.getByRole("button", { name: "中文" }).click();
  await friend.getByRole("link", { name: "记一笔" }).click();
  await friend.getByLabel("说明").fill("还油钱");
  const owed = (await balance(owner, "Sharer Sam").textContent())!.match(/\$(\d+\.\d\d)/)![1]!;
  await friend.getByLabel("金额（USD）").fill(owed);
  await friend.getByLabel("付款人").selectOption({ label: "Sharer Sam (你)" });
  await friend.getByRole("checkbox", { name: "Sharer Sam" }).uncheck();
  await friend.getByRole("button", { name: "保存" }).click();
  await expect(balance(friend, "Sharer Sam")).toContainText("已结清");
  await expect(balance(friend, "Payer Pat")).toContainText("已结清");
  friend.once("dialog", (d) => d.accept());
  await friend.getByRole("button", { name: "退出群组" }).click();
  await expect(friend.getByRole("heading", { name: "你好，Sharer Sam！" })).toBeVisible();
});

test("split by shares, exact amounts, adjustments and percentages", async ({ browser }) => {
  const owner = await approvedUser(browser, unique("splitter"), "Split Sue");
  const friendEmail = unique("splittee");
  await approvedUser(browser, friendEmail, "Other Otto");
  await createGroup(owner, "Ski week", "USD");
  await owner.getByLabel("Their Google email").fill(friendEmail);
  await owner.getByRole("button", { name: "Add", exact: true }).click();
  await expect(owner.getByText("Other Otto was added.")).toBeVisible();
  const balance = owner.locator(".balance-row").filter({ hasText: "Split Sue" });

  async function start(description: string, amount: string, method: string) {
    await owner.getByRole("link", { name: "Add expense" }).click();
    await owner.getByLabel("Description").fill(description);
    await owner.getByLabel("Amount (USD)").fill(amount);
    await owner.getByLabel("How to split").selectOption({ label: method });
  }
  const save = () => owner.getByRole("button", { name: "Save expense" }).click();

  // $90 by shares, 2 to 1: each starts with one share.
  await start("Cabin", "90", "By shares");
  await expect(owner.getByLabel("Shares for Other Otto")).toHaveValue("1");
  await owner.getByLabel("Shares for Split Sue").fill("2");
  await expect(owner.getByText("$60.00")).toBeVisible();
  await expect(owner.getByText("$30.00")).toBeVisible();
  await save();
  await expect(balance).toContainText("gets back $30.00");

  // $50 in exact amounts, with a running tally.
  await start("Lift passes", "50", "Exact amounts");
  await owner.getByLabel("Amount for Split Sue").fill("20");
  await expect(owner.getByText("$30.00 left to assign")).toBeVisible();
  await owner.getByLabel("Amount for Other Otto").fill("35");
  await expect(owner.getByText("$5.00 too much")).toBeVisible();
  await save();
  await expect(owner.getByText("$5.00 too much")).toHaveClass(/error/);
  await owner.getByLabel("Amount for Other Otto").fill("30");
  await expect(owner.getByText("Adds up to the total.")).toBeVisible();
  await save();
  await expect(balance).toContainText("gets back $60.00");

  // $10 equally, but Otto pays $2 more; too much less shows at once.
  await start("Snacks", "10", "Equally, with adjustments");
  await owner.getByLabel("Adjustment for Other Otto").fill("-20");
  await expect(owner.getByText("An adjustment leaves someone paying less than nothing.")).toBeVisible();
  await owner.getByLabel("Adjustment for Other Otto").fill("2");
  await expect(owner.getByText("$4.00")).toBeVisible();
  await expect(owner.getByText("$6.00")).toBeVisible();
  await save();
  await expect(balance).toContainText("gets back $66.00");

  // $100 by percentage; Otto left blank is left out, so it doesn't add up until he's in.
  await start("Dinner", "100", "By percentage");
  await owner.getByLabel("Percentage for Split Sue").fill("40");
  await expect(owner.getByText("60% left to assign")).toBeVisible();
  await owner.getByLabel("Percentage for Other Otto").fill("60");
  await save();
  await expect(balance).toContainText("gets back $126.00");

  const dinner = owner.getByRole("listitem").filter({ hasText: "Dinner" });
  await dinner.getByText("Dinner").click();
  await expect(dinner).toContainText("Split by percentage:");
  await expect(dinner).toContainText("Other Otto: $60.00 (60%)");
  const cabin = owner.getByRole("listitem").filter({ hasText: "Cabin" });
  await cabin.getByText("Cabin").click();
  await expect(cabin).toContainText("Split Sue: $60.00 (2 shares)");
  await expect(cabin).toContainText("Other Otto: $30.00 (1 share)");
  const snacks = owner.getByRole("listitem").filter({ hasText: "Snacks" });
  await snacks.getByText("Snacks").click();
  await expect(snacks).toContainText("Other Otto: $6.00 (+$2.00)");
});
