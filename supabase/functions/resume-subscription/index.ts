// Deploy via CLI: `supabase functions deploy resume-subscription`.
// Undoes a scheduled "cancel at period end" on one property's own
// subscription — lets a user who canceled change their mind with one click,
// instead of having to go into the full Stripe Customer Portal to find the
// "renew subscription" option buried in there.
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
    const { data: property } = await adminClient
      .from("properties")
      .select("id, stripe_subscription_id")
      .eq("id", propertyId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!property?.stripe_subscription_id) {
      return new Response(JSON.stringify({ error: "No subscription found for this property" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const stripe = new Stripe(secretKey, { apiVersion: "2024-06-20" });
    await stripe.subscriptions.update(property.stripe_subscription_id, {
      cancel_at_period_end: false,
    });

    // Update immediately rather than waiting on the customer.subscription.updated
    // webhook round trip, so the UI reflects this right away; the webhook will also
    // confirm the same values when it arrives (idempotent, not a conflict).
    await adminClient
      .from("properties")
      .update({ cancel_at_period_end: false, cancel_at: null })
      .eq("id", propertyId);

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "unknown error" }),
      { status: 500, headers: corsHeaders },
    );
  }
});
