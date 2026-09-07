// Deploy via CLI: `supabase functions deploy cancel-property-subscription`.
// Requires STRIPE_SECRET_KEY.
//
// Replaces the old bracket-quantity-decrementing remove-property-from-plan —
// trivial now that every property has its own independent Stripe
// subscription (see create-checkout-session): cancels exactly this
// property's subscription, unambiguously, with no guessing about which
// property actually loses coverage. The real profiles.plan/properties.
// subscription_status sync happens via the existing customer.subscription.
// deleted webhook (stripe-webhook/index.ts), not duplicated here.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";
import { getStripeMode, stripeSecretKey } from "../_shared/stripe-mode.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { propertyId } = (await req.json()) as { propertyId?: string };
    if (typeof propertyId !== "string" || !propertyId) {
      return new Response(JSON.stringify({ error: "propertyId is required" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

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

    // Test vs live Stripe — the global default, overridden per admin. Resolved
    // from the authenticated caller; see ../_shared/stripe-mode.ts.
    const secretKey = stripeSecretKey(await getStripeMode(user.id));

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Ownership check via .eq("user_id", user.id) — never trust propertyId
    // alone; a caller can only ever cancel their own property's subscription.
    const { data: property } = await adminClient
      .from("properties")
      .select("id, stripe_subscription_id")
      .eq("id", propertyId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!property?.stripe_subscription_id) {
      return new Response(
        JSON.stringify({ error: "This property has no active subscription to cancel." }),
        { status: 400, headers: corsHeaders },
      );
    }

    const stripe = new Stripe(secretKey, { apiVersion: "2024-06-20" });
    await stripe.subscriptions.cancel(property.stripe_subscription_id);

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "unknown error" }),
      { status: 500, headers: corsHeaders },
    );
  }
});
