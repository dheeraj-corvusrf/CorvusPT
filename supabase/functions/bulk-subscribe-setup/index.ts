// Deploy via CLI: `supabase functions deploy bulk-subscribe-setup`.
// Requires STRIPE_SECRET_KEY.
//
// Step 1 of the bulk-subscribe flow (many properties, one card, no hosted
// Checkout). Ensures the caller has a Stripe customer — today only
// checkout.session.completed creates one, so a customer who has never
// subscribed has no customer id yet — then returns a SetupIntent client
// secret for the inline PaymentElement to collect + save a card (handling SCA
// client-side). bulk-subscribe (step 2) then creates one subscription per
// property off-session against that saved card.
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
    // Test vs live Stripe environment — flipped from the admin Settings tab.
    const secretKey = stripeSecretKey(await getStripeMode());

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
    const { data: profile } = await adminClient
      .from("profiles")
      .select("stripe_customer_id, first_name, last_name")
      .eq("id", user.id)
      .maybeSingle();

    const stripe = new Stripe(secretKey, { apiVersion: "2024-06-20" });

    let customerId = profile?.stripe_customer_id as string | null | undefined;
    if (!customerId) {
      const name =
        [profile?.first_name, profile?.last_name].filter(Boolean).join(" ").trim() || undefined;
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        name,
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;
      await adminClient
        .from("profiles")
        .update({ stripe_customer_id: customerId })
        .eq("id", user.id);
    }

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      usage: "off_session",
      payment_method_types: ["card"],
      metadata: { supabase_user_id: user.id, purpose: "bulk_subscribe" },
    });

    return new Response(
      JSON.stringify({ clientSecret: setupIntent.client_secret, customerId }),
      { status: 200, headers: corsHeaders },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "unknown error" }),
      { status: 500, headers: corsHeaders },
    );
  }
});
