// Deploy via CLI: `supabase functions deploy list-my-subscriptions`.
// Read-only: lists the signed-in customer's real Stripe subscriptions so the
// in-app Billing page (src/routes/dashboard/_layout.billing.tsx) can show the
// authoritative monthly amount (including the 2nd-property discount that
// create-checkout-session applies via price_data, which the client's own
// TIER_BRACKET_PRICES copy can't reproduce), the real next billing date, and
// the card on file — none of which live in our own DB. The property address
// each subscription is for comes from subscription metadata.propertyId, which
// create-checkout-session sets; the client joins that to its property list.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";
import { getStripeMode, stripeSecretKey } from "../_shared/stripe-mode.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  // Without this, supabase-js's functions.invoke() parses the body as plain text
  // (a JSON string) instead of a parsed object, based on the response Content-Type.
  "Content-Type": "application/json",
};

const toIso = (unixSeconds: number | null | undefined): string | null =>
  typeof unixSeconds === "number" ? new Date(unixSeconds * 1000).toISOString() : null;

type CardInfo = { brand: string; last4: string } | null;

function cardOf(pm: Stripe.PaymentMethod | string | null | undefined): CardInfo {
  if (!pm || typeof pm === "string" || !pm.card) return null;
  return { brand: pm.card.brand, last4: pm.card.last4 };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
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
    const { data: profile } = await adminClient
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", user.id)
      .single();

    // No Stripe customer yet (never subscribed) — an empty list, not an error,
    // so the page can just render its "no paid subscriptions" state.
    if (!profile?.stripe_customer_id) {
      return new Response(JSON.stringify({ subscriptions: [] }), {
        status: 200,
        headers: corsHeaders,
      });
    }

    const stripe = new Stripe(secretKey, { apiVersion: "2024-06-20" });

    // Customer-level default card, used as the fallback when a subscription
    // doesn't carry its own default_payment_method.
    let customerCard: CardInfo = null;
    let list: Stripe.ApiList<Stripe.Subscription>;
    try {
      const customer = (await stripe.customers.retrieve(profile.stripe_customer_id, {
        expand: ["invoice_settings.default_payment_method"],
      })) as Stripe.Customer;
      customerCard = cardOf(customer.invoice_settings?.default_payment_method);

      list = await stripe.subscriptions.list({
        customer: profile.stripe_customer_id,
        status: "all",
        expand: ["data.default_payment_method"],
        limit: 100,
      });
    } catch (e) {
      // The stored customer id belongs to the OTHER Stripe environment (an
      // admin flipped their test/live override after subscribing) — Stripe
      // 404s it. That just means "no subscriptions in this mode", not an error.
      if (e && typeof e === "object" && (e as { code?: string }).code === "resource_missing") {
        return new Response(JSON.stringify({ subscriptions: [] }), {
          status: 200,
          headers: corsHeaders,
        });
      }
      throw e;
    }

    // "canceled"/"incomplete_expired" are dead subscriptions — nothing to show
    // or act on. Everything else (active, trialing, past_due, unpaid, and
    // active-but-set-to-cancel-at-period-end) is a live line the user is or
    // was being billed for.
    const LIVE = new Set(["active", "trialing", "past_due", "unpaid", "incomplete"]);

    const subscriptions = list.data
      .filter((s) => LIVE.has(s.status))
      .map((s) => {
        const item = s.items.data[0];
        const price = item?.price;
        return {
          id: s.id,
          status: s.status,
          propertyId: (s.metadata?.propertyId as string | undefined) ?? null,
          tier: (s.metadata?.tier as string | undefined) ?? null,
          bracket: (s.metadata?.bracket as string | undefined) ?? null,
          productName:
            typeof price?.product === "object" && price.product && !("deleted" in price.product)
              ? (price.product.name ?? null)
              : null,
          amountCents: price?.unit_amount ?? null,
          currency: price?.currency ?? "usd",
          interval: price?.recurring?.interval ?? "month",
          quantity: item?.quantity ?? 1,
          currentPeriodEnd: toIso(s.current_period_end),
          cancelAtPeriodEnd: s.cancel_at_period_end,
          cancelAt: toIso(s.cancel_at),
          card: cardOf(s.default_payment_method as Stripe.PaymentMethod | null) ?? customerCard,
        };
      });

    return new Response(JSON.stringify({ subscriptions }), {
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
