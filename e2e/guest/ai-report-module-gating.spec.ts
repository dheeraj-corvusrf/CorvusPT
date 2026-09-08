import { test, expect } from "@playwright/test";

// Regression test for the exact bug fixed this session: every module card
// showed "Free preview" regardless of subscription status, because
// ModuleCard only checked the generic `unlocked` boolean, not *why* it was
// unlocked. This covers the guest/free-tier half of that fix (deterministic,
// no sign-in needed); the "subscribed -> Included" half needs a real
// account with a subscription and belongs in e2e/authenticated.
//
// Seeds IntakeState directly into sessionStorage (the same key/shape
// src/lib/intake-store.ts reads) instead of driving the full address/upload
// flow, so this test is independent of live CAD/AI calls — accountNumber is
// deliberately omitted so estimateSavings() takes its network-free formula
// path instead of attempting a live comps lookup.
const SEEDED_STATE = {
  address: "123 Test Street, Denton, TX 76201",
  propertyKind: "residential",
  cad: "Denton Central Appraisal District",
  propertyType: "Residential",
  totalValue: 400000,
  landValue: 100000,
  improvementValue: 300000,
  taxYear: 2024,
  confirmed: true,
  previewsUsed: [],
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript((state) => {
    window.sessionStorage.setItem("crf_intake", JSON.stringify(state));
  }, SEEDED_STATE);
});

test("unsubscribed guest sees free preview on modules 1-3 and a subscription gate on 4-10", async ({
  page,
}) => {
  // Relative, no leading slash — see pricing-tiers.spec.ts for why.
  await page.goto("ai-report");

  await expect(page.getByRole("heading", { name: "10 Premium AI Modules" })).toBeVisible();

  const freeLabels = page.getByText("Free preview", { exact: true });
  const gatedLabels = page.getByText("Requires subscription", { exact: true });

  await expect(freeLabels).toHaveCount(3);
  await expect(gatedLabels).toHaveCount(7);

  // A subscribed-only label should never appear for a guest.
  await expect(page.getByText("Included", { exact: true })).toHaveCount(0);

  await expect(page.getByRole("button", { name: "Subscribe to unlock" })).toHaveCount(7);

  // The old prominent "View preview" / "View report" button is gone — the
  // free-preview modules now open via a subtle "Open" link (plus the
  // clickable colored insight band). One "Open" per free-preview module.
  await expect(page.getByRole("button", { name: "View preview" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open", exact: true })).toHaveCount(3);
  await page.getByRole("button", { name: "Open", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Close" })).toBeVisible();
});
