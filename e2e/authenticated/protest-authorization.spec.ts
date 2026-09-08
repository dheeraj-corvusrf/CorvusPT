import { test, expect } from "@playwright/test";
import { requireTestAccount, signIn, cleanupLatestProtest } from "./helpers";

// Cleans up whatever protest the test below created, even if an assertion in
// it failed partway through — so a flaky/failed run never leaves a row behind
// for the next run (or a real admin) to trip over. No-ops if requireTestAccount()
// skipped the test before credentials were ever set.
let credentials: { email: string; password: string } | null = null;
test.afterEach(async () => {
  if (credentials) await cleanupLatestProtest(credentials.email, credentials.password);
});

// Requires the seeded test account to already have at least one saved
// property with protestDeadline/totalValue set (add-a-property is exercised
// by the guest intake spec, not repeated here to keep this focused on the
// authorization + request step specifically).
test("signing the authorization and requesting a protest creates a case", async ({ page }) => {
  const { email, password } = requireTestAccount();
  credentials = { email, password };
  await signIn(page, email, password);

  await page.goto("/dashboard/properties");
  const firstProperty = page.locator(".card-elev", { hasText: "Open AI Report" }).first();
  await firstProperty.getByRole("button", { name: "Open AI Report" }).click();

  // The AI Report page swaps this button for "View Case" once its own
  // existingProtest fetch resolves — clicking before that settles is racing
  // a DOM swap, not a real interaction. Waiting for the fetches to quiet down
  // first avoids hitting the button mid-swap.
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Request Protest Filing" }).click();

  // The dialog (Radix Dialog, see ProtestAuthorizationFlow.tsx) briefly
  // re-renders its content as it finishes mounting/opening — interacting
  // with a field before that settles gets it detached mid-fill. Waiting for
  // the dialog's own heading avoids that race.
  await page
    .getByRole("heading", { name: "CorvusPT Service Agreement" })
    .waitFor({ state: "visible" });

  // Step 0: the Service Agreement — attest, then "Agree & Continue" (this
  // records the acceptance server-side and files a copy under Documents).
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Agree & Continue" }).click();

  await page.getByRole("heading", { name: "Property Owner Details" }).waitFor({ state: "visible" });

  // Step 1: owner details — only email is prefilled from the account; first/
  // last/phone start blank. Values are read into plain strings now since
  // these inputs unmount once we move to the next step.
  const firstNameField = page.getByLabel("First Name");
  if (!(await firstNameField.inputValue())) await firstNameField.fill("Test");
  const lastNameField = page.getByLabel("Last Name");
  if (!(await lastNameField.inputValue())) await lastNameField.fill("User");
  const phoneField = page.getByLabel("Phone Number");
  if (!(await phoneField.inputValue())) await phoneField.fill("5555555555");
  const fullName = `${await firstNameField.inputValue()} ${await lastNameField.inputValue()}`;
  await page.getByRole("button", { name: "Next" }).click();

  // Step 2: recent-purchase question.
  await page.getByRole("radio").last().check(); // "No"
  await page.getByRole("button", { name: "Next" }).click();

  // Step 3: review + typed signature.
  await page.getByRole("checkbox").check();
  await page.getByPlaceholder("Type your full legal name").fill(fullName);
  await page.getByRole("button", { name: "Sign & Submit" }).click();

  await expect(page.getByText(/Protest requested/i)).toBeVisible({ timeout: 15_000 });
});
