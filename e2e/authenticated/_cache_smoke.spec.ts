import { test, expect } from "@playwright/test";
import { requireTestAccount, signIn } from "./helpers";

// TEMP — verifies AI Report result caching: first visit generates ~4, a
// reload generates 0, Regenerate generates exactly 1. Delete after use.
test("AI Report cache: first-load budget, reload = 0, regenerate = 1", async ({ page }) => {
  test.setTimeout(240_000);
  const { email, password } = requireTestAccount();

  const aiCalls: string[] = [];
  const track = (u: string) => {
    if (/\/functions\/v1\/(ai-report-modules|ai-health-score)\b/.test(u)) aiCalls.push(u);
  };
  page.on("request", (r) => track(r.url()));

  await signIn(page, email, password);
  await page.goto("/dashboard/properties", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page
    .locator(".card-elev")
    .filter({ hasText: "3330 EASTPARK" })
    .filter({ has: page.getByRole("button", { name: "Open AI Report" }) })
    .getByRole("button", { name: "Open AI Report" })
    .click();
  await expect(page.getByRole("heading", { name: "10 Premium AI Modules" })).toBeVisible({
    timeout: 20_000,
  });
  // Let the eager batch + comps-after-strategy settle.
  await page.waitForTimeout(20_000);
  const firstLoad = aiCalls.length;
  console.log(`>>> first-load AI calls: ${firstLoad}`);

  // ── reload — should be served entirely from cache ──
  aiCalls.length = 0;
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "10 Premium AI Modules" })).toBeVisible({
    timeout: 20_000,
  });
  await page.waitForTimeout(15_000);
  const onReload = aiCalls.length;
  console.log(`>>> reload AI calls: ${onReload}`);

  // ── open Strategy modal, click Regenerate ──
  aiCalls.length = 0;
  await page
    .locator(".card-elev.overflow-hidden")
    .filter({ has: page.getByRole("heading", { name: "Protest Strategy" }) })
    .getByRole("button", { name: "Open", exact: true })
    .click();
  await page.getByRole("button", { name: "Close" }).waitFor({ state: "visible" });
  await page.waitForTimeout(2000);
  const regen = page.getByRole("button", { name: "Regenerate" });
  await expect(regen).toBeVisible();
  await regen.click();
  await page.waitForTimeout(15_000);
  const onRegen = aiCalls.length;
  console.log(`>>> regenerate AI calls: ${onRegen}`);

  console.log(`\n=== first=${firstLoad}  reload=${onReload}  regenerate=${onRegen} ===`);
  expect(firstLoad, "first load stays within the reduced budget").toBeLessThanOrEqual(6);
  expect(onReload, "reload serves everything from cache").toBe(0);
  expect(onRegen, "Regenerate calls the AI exactly once").toBe(1);
});
