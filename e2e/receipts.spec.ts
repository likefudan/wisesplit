import { expect, type Page, test } from "@playwright/test";

/** Signs in as the admin, whose sign-up is approved at once (it may have happened in another test). */
async function signInAsAdmin(page: Page) {
  const res = await page.request.post("/api/test/login", {
    headers: { "X-Test-Login-Secret": "e2e-secret", Origin: "http://localhost:8788" },
    data: { email: "admin@example.com", name: "Admin" },
  });
  expect(res.status()).toBe(204);
  await page.goto("/");
  const signupForm = page.getByRole("heading", { name: "Sign up" });
  await expect(page.getByRole("heading", { name: /^Hi, / }).or(signupForm)).toBeVisible();
  if (await signupForm.isVisible()) await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.getByRole("heading", { name: /^Hi, / })).toBeVisible();
}

/** A big PNG drawn in the page, as a phone's camera roll might hand over (but not a JPEG). */
async function bigPicture(page: Page, colour: string) {
  const dataUrl = await page.evaluate((fill) => {
    const canvas = document.createElement("canvas");
    canvas.width = 3200;
    canvas.height = 2000;
    const context = canvas.getContext("2d")!;
    context.fillStyle = fill;
    context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  }, colour);
  return { name: "receipt.png", mimeType: "image/png", buffer: Buffer.from(dataUrl.split(",")[1]!, "base64") };
}

test("add a receipt photo with an expense, then replace and remove it", async ({ page }) => {
  await signInAsAdmin(page);
  const groupName = `Receipts ${Math.random().toString(36).slice(2, 6)}`;
  await page.getByRole("link", { name: "New group" }).click();
  await page.getByLabel("Group name").fill(groupName);
  await page.getByLabel("Currency").selectOption("USD");
  await page.getByRole("button", { name: "Create group" }).click();
  await expect(page.getByRole("heading", { name: groupName })).toBeVisible();

  // Picked in the form: shrunk in the browser and shown before saving.
  await page.getByRole("link", { name: "Add expense" }).click();
  await page.getByLabel("Description").fill("Groceries");
  await page.getByLabel("Amount (USD)").fill("42.10");
  await page.getByLabel("Add receipt photo").setInputFiles(await bigPicture(page, "#3a7"));
  const preview = page.getByRole("img", { name: "The receipt photo you picked" });
  await expect(preview).toBeVisible();
  expect(await preview.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight])).toEqual([
    1600, 1000,
  ]);
  await page.getByRole("button", { name: "Save expense" }).click();

  // In the list it is marked, and shows once the expense is opened: a JPEG, no bigger than 1600px.
  await expect(page.getByRole("heading", { name: groupName })).toBeVisible();
  const row = page.getByRole("listitem").filter({ hasText: "Groceries" });
  await expect(row.locator(".badge")).toHaveText("receipt");
  await row.getByText("Groceries").click();
  const photo = row.getByRole("img", { name: "Receipt for Groceries" });
  await expect(photo).toBeVisible();
  await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1600);
  const src = await photo.getAttribute("src");
  const res = await page.request.get(src!);
  expect(res.headers()["content-type"]).toBe("image/jpeg");
  expect([...(await res.body()).subarray(0, 2)]).toEqual([0xff, 0xd8]);

  // Replaced: a new address, so the page shows the new one.
  await row.getByLabel("Replace photo").setInputFiles(await bigPicture(page, "#c33"));
  await expect(photo).not.toHaveAttribute("src", src!);
  await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1600);

  // Removed.
  page.once("dialog", (d) => d.accept());
  await row.getByRole("button", { name: "Remove photo" }).click();
  await expect(photo).toHaveCount(0);
  await expect(row.locator(".badge")).toHaveCount(0);
  await expect(row.getByLabel("Add receipt photo")).toBeAttached();
  expect((await page.request.get(src!)).status()).toBe(404);

  // Something that isn't a picture is refused in the browser.
  await row
    .getByLabel("Add receipt photo")
    .setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not a photo") });
  await expect(row.getByRole("alert")).toContainText("can't be opened as a picture");
});
