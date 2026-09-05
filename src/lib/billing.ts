import { supabase } from "./supabase";
import { invokeEdgeFunction } from "./edge-functions";

// "ai_report" and the old contingency-based "managed_protest" are retained only for
// backward compatibility with any pre-existing rows from before the per-property
// pricing overhaul — new subscriptions always write owner_managed/corvusrf_managed.
// "beta" is a free, full-access grant set only at signup (see handle_new_user() in
// supabase/schema.sql) or manually via the admin panel — never through Stripe.
export type PlanValue =
  | "free_ai_review"
  | "ai_report"
  | "managed_protest"
  | "owner_managed"
  | "corvusrf_managed"
  | "beta";

export type Tier = "owner_managed" | "corvusrf_managed";

// Property-value-tiered pricing — each paid tier has 3 monthly price points
// instead of one flat per-property rate, keyed by which value bracket a
// given property falls in. The real amount charged is computed dynamically by
// create-checkout-session (Stripe price_data, not a fixed Price ID) — these
// numbers are for display/estimate only, kept in sync by hand with that
// function's own copy of the same math (Deno functions can't import from
// src/lib).
export type PropertyValueBracket = "under2m" | "mid2m10m" | "over10m";

export type BracketQuantities = Record<PropertyValueBracket, number>;

export const EMPTY_BRACKETS: BracketQuantities = { under2m: 0, mid2m10m: 0, over10m: 0 };

// "over10m" now means the capped $10M-$25M bracket, not open-ended — anything
// above $25M moved to CUSTOM_TIER below, which isn't part of this bracket
// system (no quantity, no checkout).
export const VALUE_BRACKETS: { value: PropertyValueBracket; label: string }[] = [
  { value: "under2m", label: "$0 - $2M" },
  { value: "mid2m10m", label: "$2M - $10M" },
  { value: "over10m", label: "$10M - $25M" },
];

export const TIER_BRACKET_PRICES: Record<Tier, Record<PropertyValueBracket, number>> = {
  owner_managed: { under2m: 99, mid2m10m: 299, over10m: 499 },
  corvusrf_managed: { under2m: 199, mid2m10m: 499, over10m: 799 },
};

// Non-metered — shown on /pricing as a third, always-visible card with a
// "Contact Us" link instead of Subscribe. Never enters BracketQuantities,
// checkout, or the DB.
export const CUSTOM_TIER = {
  label: "$25M+",
  tag: "Custom pricing",
  blurb: "Portfolios above $25M per property are priced individually — talk to us.",
};

// 1st property in a bracket is full price; every additional property in that
// same bracket is 15% off. Mirrored in create-checkout-session/index.ts,
// which can't import this file.
export const ADDITIONAL_PROPERTY_DISCOUNT = 0.15;

export function bracketLineTotal(basePrice: number, qty: number): number {
  if (qty <= 0) return 0;
  return basePrice + (qty - 1) * basePrice * (1 - ADDITIONAL_PROPERTY_DISCOUNT);
}

// The 15%-off math produces amounts like $84.15 — plain integers still print
// as-is (no trailing ".00"), but anything with cents gets exactly 2 decimals
// instead of raw floating-point noise (e.g. 267.29999999999995).
export function formatMoney(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}

export function bracketMonthlyTotal(tier: Tier, brackets: BracketQuantities): number {
  return VALUE_BRACKETS.reduce(
    (sum, { value }) => sum + bracketLineTotal(TIER_BRACKET_PRICES[tier][value], brackets[value]),
    0,
  );
}

export function bracketPropertyCount(brackets: BracketQuantities): number {
  return VALUE_BRACKETS.reduce((sum, { value }) => sum + brackets[value], 0);
}

// ── Per-property entitlement ────────────────────────────────────────────
// Real business rule: a subscription's bracket quantities pay for that many
// PROPERTIES, not for the account as a whole — one payment does not unlock
// every property the customer ever adds. This is unconditionally enforced
// (an earlier admin-toggleable kill switch was removed per explicit product
// direction — "it should be completely enabled") everywhere a paid action
// depends on a specific property being covered: AI Report access
// (ai-report.tsx), the Paid/Not Paid badge and Request Protest Filing gate
// on /dashboard/properties.
//
// Rule: the first `paidPropertyCount` properties, oldest first (by
// createdAt), are entitled; everything added after that isn't, until the
// subscription's bracket quantities increase. Deliberately NOT trying to
// match a specific property's real value against a specific bracket
// (under2m/mid2m10m/over10m) — those quantities are self-declared by the
// customer at checkout (create-checkout-session doesn't itself validate a
// property's value against the bracket chosen for it either), so the only
// number that's actually real and unambiguous here is the total paid count.
export function getEntitledPropertyIds(
  properties: { id: string; createdAt: string }[],
  paidPropertyCount: number,
): Set<string> {
  if (paidPropertyCount <= 0) return new Set();
  const oldestFirst = [...properties].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  return new Set(oldestFirst.slice(0, paidPropertyCount).map((p) => p.id));
}

// Plans this entitlement cap actually applies to — the two real, current
// per-property-bracket-priced tiers. "beta" is deliberately excluded: every
// AI module is unlocked on every property for free for the whole beta
// (see pricing.tsx's own "You have full Beta access" copy) — that's an
// explicit, unlimited grant, not a bracket-quantity purchase. The legacy
// "ai_report"/"managed_protest" values predate the per-property model
// entirely (kept only for old rows — see the PlanValue comment above) and
// were never sold with a bracket quantity to check against, so they're left
// uncapped too rather than retroactively restricting a grandfathered account.
const BRACKET_PRICED_PLANS: PlanValue[] = ["owner_managed", "corvusrf_managed"];

export function planUsesPerPropertyEntitlement(plan: PlanValue): boolean {
  return BRACKET_PRICED_PLANS.includes(plan);
}

export const PLAN_OPTIONS: { value: PlanValue; label: string }[] = [
  { value: "free_ai_review", label: "Free AI Review" },
  { value: "owner_managed", label: "Owner-Managed ($99–$499/mo/property, by value)" },
  { value: "corvusrf_managed", label: "CorvusPT-Managed ($199–$799/mo/property, by value)" },
  { value: "beta", label: "Beta (free, full access)" },
];

export type BillingInfo = {
  plan: PlanValue;
  subscriptionStatus: string | null;
  subscriptionQuantity: number;
  subscriptionBrackets: BracketQuantities;
  cancelAtPeriodEnd: boolean;
  cancelAt: string | null;
};

export async function getMyBilling(userId: string): Promise<BillingInfo> {
  const { data, error } = await supabase
    .from("profiles")
    .select(
      "plan, subscription_status, subscription_quantity, qty_under_2m, qty_2m_10m, qty_over_10m, cancel_at_period_end, cancel_at",
    )
    .eq("id", userId)
    .single();
  if (error) throw error;
  const row = data as {
    plan: PlanValue;
    subscription_status: string | null;
    subscription_quantity: number;
    qty_under_2m: number;
    qty_2m_10m: number;
    qty_over_10m: number;
    cancel_at_period_end: boolean;
    cancel_at: string | null;
  };
  return {
    plan: row.plan,
    subscriptionStatus: row.subscription_status,
    subscriptionQuantity: row.subscription_quantity,
    subscriptionBrackets: {
      under2m: row.qty_under_2m,
      mid2m10m: row.qty_2m_10m,
      over10m: row.qty_over_10m,
    },
    cancelAtPeriodEnd: row.cancel_at_period_end,
    cancelAt: row.cancel_at,
  };
}

export async function startCheckout(tier: Tier, brackets: BracketQuantities): Promise<void> {
  // Stripe redirects back to a path the edge function can't know on its own (it
  // runs server-side, with no view of Vite's base path) — the client computes it
  // via import.meta.env.BASE_URL, same pattern already used in
  // forgot-password.tsx's redirectTo, and passes it along instead of the edge
  // function guessing/hardcoding it (which is exactly how this one went stale
  // pointing at a pre-custom-domain path).
  const basePath = import.meta.env.BASE_URL;
  const { url } = await invokeEdgeFunction<{ url: string }>("create-checkout-session", {
    tier,
    brackets,
    successPath: `${basePath}dashboard?checkout=success`,
    cancelPath: `${basePath}pricing`,
  });
  if (!url) throw new Error("Stripe did not return a checkout URL. Please try again.");
  window.location.href = url;
}

export async function openBillingPortal(): Promise<void> {
  const basePath = import.meta.env.BASE_URL;
  const { url } = await invokeEdgeFunction<{ url: string }>("create-billing-portal-session", {
    returnPath: `${basePath}dashboard`,
  });
  if (!url) throw new Error("Stripe did not return a billing portal URL. Please try again.");
  window.location.href = url;
}

// Undoes a scheduled cancel-at-period-end in one click, rather than sending the user
// into the full Stripe Customer Portal to find the "renew" option.
export async function resumeSubscription(): Promise<void> {
  await invokeEdgeFunction<{ ok: boolean }>("resume-subscription", {});
}
