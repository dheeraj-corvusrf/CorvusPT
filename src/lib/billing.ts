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

// "over10m" now means the capped $10M-$25M bracket, not open-ended — anything
// above $25M moved to CUSTOM_TIER below, which isn't part of this bracket
// system (no checkout).
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
// "Contact Us" link instead of Subscribe. Never enters checkout or the DB.
export const CUSTOM_TIER = {
  label: "$25M+",
  tag: "Custom pricing",
  blurb: "Portfolios above $25M per property are priced individually — talk to us.",
};

// A property's own real value classifies it into a bracket automatically —
// no self-declared quantity picker anymore (each property gets its own
// subscription; see create-property-checkout-session). Same $2M/$10M
// boundaries as VALUE_BRACKETS above. Mirrored by hand into
// create-checkout-session/index.ts, which can't import this file.
export function bracketForValue(value: number | null | undefined): PropertyValueBracket {
  if (value == null) return "under2m";
  if (value < 2_000_000) return "under2m";
  if (value < 10_000_000) return "mid2m10m";
  return "over10m";
}

// 1st property in a bracket is full price; every additional property a
// customer already has an active subscription for in that SAME bracket
// gets this discount on the new one. Mirrored in create-checkout-session/
// index.ts, which can't import this file.
export const ADDITIONAL_PROPERTY_DISCOUNT = 0.15;

// The 15%-off math produces amounts like $84.15 — plain integers still print
// as-is (no trailing ".00"), but anything with cents gets exactly 2 decimals
// instead of raw floating-point noise (e.g. 267.29999999999995).
export function formatMoney(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}

// Real price for ONE property's own subscription — full rate, or the
// 2nd-property discount once `isAdditionalInBracket` (the customer already
// has another active property in this same tier+bracket) is true. Display
// only; create-checkout-session computes and charges the authoritative
// amount server-side the same way.
export function propertyMonthlyPrice(
  tier: Tier,
  bracket: PropertyValueBracket,
  isAdditionalInBracket: boolean,
): number {
  const base = TIER_BRACKET_PRICES[tier][bracket];
  return isAdditionalInBracket
    ? Math.round(base * (1 - ADDITIONAL_PROPERTY_DISCOUNT) * 100) / 100
    : base;
}

export const PLAN_OPTIONS: { value: PlanValue; label: string }[] = [
  { value: "free_ai_review", label: "Free AI Review" },
  { value: "owner_managed", label: "Owner-Managed ($99–$499/mo/property, by value)" },
  { value: "corvusrf_managed", label: "CorvusPT-Managed ($199–$799/mo/property, by value)" },
  { value: "beta", label: "Beta (free, full access)" },
];

// A coarse, account-level signal only — "the tier of this customer's most
// recently created active property subscription" (kept in sync by
// stripe-webhook), used just where a quick at-a-glance plan label is needed
// (pricing.tsx's own-plan banner, admin panel, get_my_referrals()'s
// `converted` check in schema.sql). Real per-property access/billing always
// reads the PROPERTY's own subscriptionStatus/planTier/valueBracket
// (src/lib/properties.ts) instead — never this.
export type BillingInfo = {
  plan: PlanValue;
};

export async function getMyBilling(userId: string): Promise<BillingInfo> {
  const { data, error } = await supabase.from("profiles").select("plan").eq("id", userId).single();
  if (error) throw error;
  return { plan: (data as { plan: PlanValue }).plan };
}

// Starts a real, independent Stripe subscription for exactly this one
// property — see create-checkout-session/index.ts, which classifies the
// property's own bracket from its real value and prices the 2nd-property
// discount itself. Stripe redirects back to a path the edge function can't
// know on its own (it runs server-side, with no view of Vite's base path) —
// the client computes it via import.meta.env.BASE_URL, same pattern
// forgot-password.tsx's redirectTo already uses.
//
// `newTab: true` (both Subscribe buttons — properties.tsx and ai-report.tsx
// — so clicking one doesn't navigate away from whatever the customer was
// looking at) opens a blank tab BEFORE the await, not after — window.open()
// called from inside a .then()/await continuation is treated as not
// user-initiated by most browsers' popup blockers and gets silently
// blocked. Deliberately no `noopener` here: that would return null for the
// handle this needs to later point at the real Stripe URL once it resolves.
export async function startPropertyCheckout(
  propertyId: string,
  tier: Tier,
  options?: { newTab?: boolean },
): Promise<void> {
  const newTabHandle = options?.newTab ? window.open("", "_blank") : null;
  try {
    const basePath = import.meta.env.BASE_URL;
    const { url } = await invokeEdgeFunction<{ url: string }>("create-checkout-session", {
      propertyId,
      tier,
      successPath: `${basePath}dashboard/properties?checkout=success`,
      cancelPath: `${basePath}dashboard/properties`,
    });
    if (!url) throw new Error("Stripe did not return a checkout URL. Please try again.");
    if (newTabHandle) newTabHandle.location.href = url;
    else window.location.href = url;
  } catch (err) {
    newTabHandle?.close();
    throw err;
  }
}

// Opens Stripe's real Customer Portal — with one subscription per property
// now, the portal itself lists every property's subscription separately,
// each with its own real "Cancel subscription," update payment method, etc.
// No property-specific parameter needed; Stripe scopes it to the signed-in
// Customer's full subscription list on its own.
export async function openBillingPortal(options?: { newTab?: boolean }): Promise<void> {
  // Same popup-blocker-safe pattern as startPropertyCheckout: open the blank
  // tab synchronously (inside the click handler), then point it at the real
  // Stripe URL once the edge function resolves. No `noopener` — that would
  // null out the handle this needs to keep.
  const newTabHandle = options?.newTab ? window.open("", "_blank") : null;
  try {
    const basePath = import.meta.env.BASE_URL;
    const { url } = await invokeEdgeFunction<{ url: string }>("create-billing-portal-session", {
      returnPath: `${basePath}dashboard`,
    });
    if (!url) throw new Error("Stripe did not return a billing portal URL. Please try again.");
    if (newTabHandle) newTabHandle.location.href = url;
    else window.location.href = url;
  } catch (err) {
    newTabHandle?.close();
    throw err;
  }
}

// Cancels exactly one property's own subscription — trivial now that each
// property has its own (see cancel-property-subscription/index.ts): no more
// bracket-quantity guessing about which property actually loses coverage.
export async function cancelPropertySubscription(propertyId: string): Promise<void> {
  await invokeEdgeFunction<{ ok: boolean }>("cancel-property-subscription", { propertyId });
}

// Undoes a scheduled cancel-at-period-end on one property's own subscription,
// in one click, rather than sending the user into the full Stripe Customer
// Portal to find the "renew" option.
export async function resumePropertySubscription(propertyId: string): Promise<void> {
  await invokeEdgeFunction<{ ok: boolean }>("resume-subscription", { propertyId });
}

// One live Stripe subscription, as returned by the list-my-subscriptions edge
// function. `amountCents`/`currentPeriodEnd`/`card` are the authoritative
// Stripe values — the real charged amount here already includes the
// 2nd-property discount that create-checkout-session bakes into price_data,
// which propertyMonthlyPrice() above can only estimate. `propertyId` (from
// subscription metadata) is how the Billing page joins each subscription back
// to its property for the address.
export type MySubscription = {
  id: string;
  status: string;
  propertyId: string | null;
  tier: Tier | null;
  bracket: PropertyValueBracket | null;
  productName: string | null;
  amountCents: number | null;
  currency: string;
  interval: string;
  quantity: number;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  cancelAt: string | null;
  card: { brand: string; last4: string } | null;
};

export async function listMySubscriptions(): Promise<MySubscription[]> {
  const { subscriptions } = await invokeEdgeFunction<{ subscriptions: MySubscription[] }>(
    "list-my-subscriptions",
    {},
  );
  return subscriptions ?? [];
}
