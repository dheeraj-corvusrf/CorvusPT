import { createClient } from "@supabase/supabase-js";
import { type Page, test } from "@playwright/test";

// These specs need a real signed-in account with at least one saved property.
// In CI (see .github/workflows/deploy.yml) they run against a dedicated,
// permanent test account (crf-ci-e2e-test@example.com) that exists only for
// this — protest-authorization.spec.ts cleans up the protest row it creates
// each run (see cleanupLatestProtest below) so nothing piles up in the real
// admin queue; checkout-redirect.spec.ts only creates a Stripe Checkout
// *session* against test-mode price IDs, never a completed payment.
//
// To run locally against your own seeded account instead:
//
//   E2E_TEST_EMAIL=you@example.com E2E_TEST_PASSWORD=... npx playwright test e2e/authenticated
//
// Each test calls requireTestAccount() first and skips itself (not fails)
// when the env vars aren't set, so `npm run test:e2e` (guest-only) is
// unaffected and a contributor without a seeded account isn't blocked.
export function requireTestAccount() {
  const email = process.env.E2E_TEST_EMAIL;
  const password = process.env.E2E_TEST_PASSWORD;
  test.skip(
    !email || !password,
    "E2E_TEST_EMAIL / E2E_TEST_PASSWORD not set — see e2e/authenticated/helpers.ts",
  );
  return { email: email!, password: password! };
}

export async function signIn(page: Page, email: string, password: string) {
  // "networkidle" (not just the default "load") so the click below always
  // lands after client-side hydration attaches the form's onSubmit handler —
  // clicking too early on a freshly server-rendered/prerendered page is a
  // silent no-op, not an error, and was the actual cause of this helper
  // timing out (confirmed while debugging: the click landed, but nothing
  // happened because React hadn't taken over the button yet).
  await page.goto("/sign-in", { waitUntil: "networkidle" });
  await page.locator('input[type="email"]').waitFor({ state: "visible" });
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').first().fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
  // Sign-in redirects to "/" (see sign-in.tsx's onSubmit — nav({ to: "/" })),
  // not "/dashboard", so wait for the redirect away from /sign-in rather than
  // assuming a specific destination.
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 15_000 });
}

// Deletes the most recently requested protest for this account — run after
// protest-authorization.spec.ts asserts success, so the row it just created
// doesn't linger in the real admin queue (see the "Users can delete their own
// protests" RLS policy in supabase/schema.sql, added specifically for this).
// Uses a separate Node-side Supabase client (not the Playwright page) since
// that's simpler than reaching into the app's own browser-side client.
//
// Guarded to only ever delete a row requested in the last 10 minutes — this
// account is dedicated to CI and should only ever hold rows a just-finished
// run created, but the time window means a slow/stuck run's cleanup can never
// reach back and delete an older, unrelated row.
export async function cleanupLatestProtest(email: string, password: string) {
  const url = process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return;

  const client = createClient(url, anonKey);
  const { data: signInData, error: signInError } = await client.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError || !signInData.user) return;

  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: recent } = await client
    .from("protests")
    .select("id, requested_at")
    .eq("user_id", signInData.user.id)
    .gte("requested_at", tenMinutesAgo)
    .order("requested_at", { ascending: false })
    .limit(1);

  const latest = recent?.[0];
  if (latest) await client.from("protests").delete().eq("id", latest.id);

  // The authorization flow now also records a Service Agreement acceptance and
  // files a "Service Agreement" document copy. The acceptance row is an
  // immutable compliance record with no delete policy (fine — it's a
  // dedicated CI account, and real acceptances aren't deleted either), but
  // clear the recent document copy so the test account's Documents tab
  // doesn't fill up run over run.
  const { data: recentDocs } = await client
    .from("documents")
    .select("id, storage_path, uploaded_at")
    .eq("user_id", signInData.user.id)
    .eq("document_type", "Service Agreement")
    .gte("uploaded_at", tenMinutesAgo)
    .order("uploaded_at", { ascending: false })
    .limit(3);
  for (const d of recentDocs ?? []) {
    await client.storage.from("documents").remove([d.storage_path as string]);
    await client.from("documents").delete().eq("id", d.id);
  }

  await client.auth.signOut();
}
