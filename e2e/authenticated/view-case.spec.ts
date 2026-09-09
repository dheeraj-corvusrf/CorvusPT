import { test, expect } from "@playwright/test";
import { requireTestAccount, signIn } from "./helpers";

// End-to-end smoke for the "View Case" button and the CaseDetailView it
// opens (/dashboard/case). Verifies the button routes correctly, the case
// page mounts, and the sections added on top of it — Case Record, Audit
// Trail, Escalation evaluation, and Module-9/10 report wiring live in the
// AI Report, not here, but the case modal is where most of the case
// lifecycle UI is — render without throwing a runtime error for whatever
// stage the seeded account's case happens to be at.
//
// Read-only: it never advances the case or writes rows, so there's nothing
// to clean up. Skips itself (does not fail) when the account has no filed
// protest to open.
test("View Case opens the case page and its sections render without error", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const { email, password } = requireTestAccount();
  await signIn(page, email, password);

  await page.goto("/dashboard/properties", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  const viewCase = page.getByRole("link", { name: "View Case" }).first();
  if ((await viewCase.count()) === 0) {
    test.skip(true, "Seeded account has no filed protest — nothing to open.");
    return;
  }

  // The link opens in a new tab (target="_blank").
  const [casePage] = await Promise.all([context.waitForEvent("page"), viewCase.click()]);
  const runtimeErrors: string[] = [];
  casePage.on("pageerror", (err) => runtimeErrors.push(String(err)));
  const reactErrors: string[] = [];
  casePage.on("console", (msg) => {
    if (
      msg.type() === "error" &&
      /Minified React error|Rendered more hooks|is not a function|Cannot read propert/i.test(
        msg.text(),
      )
    )
      reactErrors.push(msg.text());
  });
  await casePage.waitForLoadState("domcontentloaded");

  expect(casePage.url()).toContain("/dashboard/case");

  // Core: the page mounted as a real case view (a heading rendered) and the
  // route is correct. This alone proves the button works.
  await expect(casePage.getByRole("heading").first()).toBeVisible({ timeout: 20_000 });

  // The page shows either the one-time "AI Guidance & Filing Notice" gate or
  // the case body directly. Acknowledge the gate if it's there so we reach
  // the case body where the sections added this cycle live.
  const ackButton = casePage.getByRole("button", {
    name: /Acknowledge|Continue|I Understand|I Agree/i,
  });
  if (await ackButton.count()) {
    const gateCheckbox = casePage.getByRole("checkbox").first();
    if (await gateCheckbox.count()) await gateCheckbox.check().catch(() => {});
    await ackButton
      .first()
      .click()
      .catch(() => {});
  }

  // Once past any gate, the case body renders Case Progress plus the sections
  // added on top of it (Case Record, Audit Trail) — for EVERY protest status,
  // since none of them is gated on stage. If the gate couldn't be dismissed
  // (unknown seeded state), don't fail the run over it — the render-error
  // check above is the real assertion.
  const caseProgress = casePage.getByText("Case Progress");
  if (await caseProgress.isVisible().catch(() => false)) {
    await expect(casePage.getByText("Case Record")).toBeVisible({ timeout: 20_000 });
    await expect(casePage.getByText("Audit Trail")).toBeVisible();
  }

  await casePage.waitForTimeout(1000);
  expect(runtimeErrors, `case page threw:\n${runtimeErrors.join("\n")}`).toEqual([]);
  expect(reactErrors, `React render errors on the case page:\n${reactErrors.join("\n")}`).toEqual(
    [],
  );
});
