// Deploy via CLI: `supabase functions deploy create-checkout-session`.
// Requires only STRIPE_SECRET_KEY — no per-bracket Stripe Price id secrets.
// Price is computed here and passed to Stripe as price_data (ad hoc, no
// pre-created Price/Product needed), so the 15%-off-2nd-property discount can
// be applied without a separate fixed Price per case. Mirrors
// bracketForValue/TIER_BRACKET_PRICES/ADDITIONAL_PROPERTY_DISCOUNT in
// src/lib/billing.ts, which a Deno function can't import directly — keep
// both in sync by hand.
//
// One real, independent Stripe subscription per PROPERTY (not one shared
// subscription with bracket quantities, as before) — see the property-level
// columns this writes via stripe-webhook's checkout.session.completed
// handler (stripe_subscription_id, subscription_status, plan_tier,
// value_bracket on the properties row itself).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  // Without this, supabase-js's functions.invoke() parses the body as plain text
  // (a JSON string) instead of a parsed object, based on the response Content-Type.
  "Content-Type": "application/json",
};

type Tier = "owner_managed" | "corvusrf_managed";
type Bracket = "under2m" | "mid2m10m" | "over10m";

const TIER_LABEL: Record<Tier, string> = {
  owner_managed: "Owner-Managed",
  corvusrf_managed: "CorvusPT-Managed",
};

// "over10m" is the capped $10M-$25M bracket — see billing.ts.
const BRACKET_LABEL: Record<Bracket, string> = {
  under2m: "$0 - $2M",
  mid2m10m: "$2M - $10M",
  over10m: "$10M - $25M",
};

const TIER_BRACKET_PRICES: Record<Tier, Record<Bracket, number>> = {
  owner_managed: { under2m: 99, mid2m10m: 299, over10m: 499 },
  corvusrf_managed: { under2m: 199, mid2m10m: 499, over10m: 799 },
};

const ADDITIONAL_PROPERTY_DISCOUNT = 0.15;

// Same $2M/$10M boundaries as src/lib/billing.ts's bracketForValue.
function bracketForValue(value: number | null): Bracket {
  if (value == null) return "under2m";
  if (value < 2_000_000) return "under2m";
  if (value < 10_000_000) return "mid2m10m";
  return "over10m";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { propertyId, tier, successPath, cancelPath } = (await req.json()) as {
      propertyId?: string;
      tier?: Tier;
      successPath?: string;
      cancelPath?: string;
    };
    if (tier !== "owner_managed" && tier !== "corvusrf_managed") {
      return new Response(
        JSON.stringify({ error: "tier must be owner_managed or corvusrf_managed" }),
        { status: 400, headers: corsHeaders },
      );
    }
    if (typeof propertyId !== "string" || !propertyId) {
      return new Response(JSON.stringify({ error: "propertyId is required" }), {
        status: 400,
        headers: corsHeaders,
      });
    }
    // Only ever appended to a server-validated origin below, never used as a whole
    // URL — but requiring a leading "/" (not "//", which a browser would treat as
    // protocol-relative) keeps this from being coaxed into pointing off-origin.
    const safePath = (p: string | undefined, fallback: string) =>
      p && p.startsWith("/") && !p.startsWith("//") ? p : fallback;

    const secretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!secretKey) throw new Error("Missing STRIPE_SECRET_KEY");

    const callerClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );
    const {
      data: { user },
      error: userErr,
    } = await callerClient.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "unauthenticated" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Ownership check via .eq("user_id", user.id) — a caller can only ever
    // start a checkout for their own property.
    const { data: property } = await adminClient
      .from("properties")
      .select("id, address, total_value, stripe_subscription_id, subscription_status")
      .eq("id", propertyId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!property) {
      return new Response(JSON.stringify({ error: "Property not found." }), {
        status: 404,
        headers: corsHeaders,
      });
    }
    if (property.subscription_status === "active") {
      return new Response(
        JSON.stringify({ error: "This property already has an active subscription." }),
        { status: 400, headers: corsHeaders },
      );
    }

    const bracket = bracketForValue(property.total_value as number | null);

    // Real 2nd-property-in-this-bracket discount check — count this
    // customer's OTHER properties already actively subscribed under the
    // same tier+bracket.
    const { count } = await adminClient
      .from("properties")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("plan_tier", tier)
      .eq("value_bracket", bracket)
      .eq("subscription_status", "active")
      .neq("id", propertyId);
    const isAdditionalInBracket = (count ?? 0) > 0;

    const basePrice = TIER_BRACKET_PRICES[tier][bracket];
    const baseCents = Math.round(basePrice * 100);
    const unitAmount = isAdditionalInBracket
      ? Math.round(baseCents * (1 - ADDITIONAL_PROPERTY_DISCOUNT))
      : baseCents;
    // Lead with the property address so each line is identifiable in Stripe's
    // hosted billing portal (which only shows the product name) when a
    // customer has several property subscriptions — otherwise two rows like
    // "Owner-Managed — $2M - $10M" are indistinguishable. Stripe's product
    // name limit is 250 chars; a situs address is well under that, but trim
    // defensively. Also set the subscription description to the bare address
    // for portals/emails that surface it.
    const address = ((property.address as string | null) ?? "").trim();
    const planLabel = `${TIER_LABEL[tier]} (${BRACKET_LABEL[bracket]})${
      isAdditionalInBracket ? ", 2nd+ property 15% off" : ""
    }`;
    const name = (address ? `${address} — ${planLabel}` : planLabel).slice(0, 240);

    const { data: profile } = await adminClient
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", user.id)
      .single();

    const stripe = new Stripe(secretKey, { apiVersion: "2024-06-20" });
    const origin = req.headers.get("origin") ?? new URL(req.url).origin;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: unitAmount,
            recurring: { interval: "month" },
            product_data: { name, metadata: { tier, bracket } },
          },
        },
      ],
      client_reference_id: user.id,
      customer: profile?.stripe_customer_id ?? undefined,
      customer_email: profile?.stripe_customer_id ? undefined : (user.email ?? undefined),
      subscription_data: {
        ...(address ? { description: address } : {}),
        metadata: { tier, bracket, propertyId },
      },
      metadata: { tier, bracket, propertyId },
      success_url: `${origin}${safePath(successPath, "/dashboard/properties?checkout=success")}`,
      cancel_url: `${origin}${safePath(cancelPath, "/dashboard/properties")}`,
    });

    if (!session.url) throw new Error("Stripe did not return a Checkout URL");

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: corsHeaders,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "unknown error" }),
      { status: 500, headers: corsHeaders },
    );
  }
});
