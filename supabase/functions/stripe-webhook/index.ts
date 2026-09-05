// Deploy via CLI: `supabase functions deploy stripe-webhook`.
// Requires STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET secrets. After deploying, add
// this function's URL as a webhook endpoint in the Stripe Dashboard, subscribed to
// checkout.session.completed, customer.subscription.updated, and
// customer.subscription.deleted.
//
// No Supabase auth here — Stripe calls this directly and authenticates via an HMAC
// signature (verified below) instead of a Supabase JWT. The service-role client is
// used to write to profiles/properties, bypassing RLS, since there is no end-user
// session.
//
// One real, independent Stripe subscription per PROPERTY (not one shared
// subscription per customer with bracket quantities, as before) — every
// event here is keyed by which PROPERTY row a subscription belongs to
// (matched via properties.stripe_subscription_id), not by customer alone,
// since one customer can now have many active subscriptions at once.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, stripe-signature",
  "Content-Type": "application/json",
};

// profiles.plan is a coarse, account-level signal only now (see its own
// comment in src/lib/billing.ts) — "the tier of this customer's most
// recently created active property subscription," recomputed here after
// every property-subscription change. Never touched for a 'beta' account:
// that's an unconditional, non-Stripe grant (see handle_new_user() in
// schema.sql) that must never be overwritten by ordinary subscription
// activity.
async function syncProfilePlan(
  adminClient: ReturnType<typeof createClient>,
  userId: string,
): Promise<void> {
  const { data: profile } = await adminClient
    .from("profiles")
    .select("plan")
    .eq("id", userId)
    .maybeSingle();
  if (profile?.plan === "beta") return;

  const { data: activeProps } = await adminClient
    .from("properties")
    .select("plan_tier")
    .eq("user_id", userId)
    .eq("subscription_status", "active")
    .order("created_at", { ascending: false })
    .limit(1);
  const mostRecentTier = activeProps?.[0]?.plan_tier as string | null | undefined;
  await adminClient
    .from("profiles")
    .update({ plan: mostRecentTier ?? "free_ai_review" })
    .eq("id", userId);
}

// One month free for whoever referred this NEW paying customer — real
// business rule ("each referral gives one month free"), so the credit
// amount is the REFERRER's own real current monthly total, never a guessed
// flat dollar figure. Granted via Stripe's customer balance (a negative
// balance transaction), which Stripe applies to the referrer's own next
// invoice(s) automatically — not a coupon/promo code, which would need
// per-price setup this ad hoc per-property pricing doesn't have a fixed
// Price id for (see create-checkout-session's own comment).
//
// A customer can now have MANY active property subscriptions at once (one
// per property) rather than a single shared one — there's no longer one
// canonical "their subscription" to read. Uses the referrer's most
// recently created active property subscription's own real monthly total
// as the credit amount, a reasonable real-money proxy for "their current
// spend" without summing every subscription they have.
//
// referral_reward_granted_at (on the REFERRED user's own row, set here)
// is the one-time guard — if this specific referred user's checkout ever
// fires checkout.session.completed again (e.g. they cancel and
// re-subscribe), the referrer is never paid out twice for the same
// referral. Never throws: a failure here must not roll back or fail the
// primary subscription sync above, which already succeeded.
async function grantReferralRewardIfDue(
  stripe: Stripe,
  adminClient: ReturnType<typeof createClient>,
  referredUserId: string,
): Promise<void> {
  try {
    const { data: referred } = await adminClient
      .from("profiles")
      .select("referred_by, referral_reward_granted_at")
      .eq("id", referredUserId)
      .maybeSingle();
    const referrerId = referred?.referred_by as string | null | undefined;
    if (!referrerId || referred?.referral_reward_granted_at) return;

    const { data: referrer } = await adminClient
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", referrerId)
      .maybeSingle();
    const customerId = referrer?.stripe_customer_id as string | null | undefined;
    if (!customerId) return; // referrer isn't a paying customer themselves yet

    const { data: activeProps } = await adminClient
      .from("properties")
      .select("stripe_subscription_id")
      .eq("user_id", referrerId)
      .eq("subscription_status", "active")
      .not("stripe_subscription_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1);
    const subscriptionId = activeProps?.[0]?.stripe_subscription_id as string | undefined;
    if (!subscriptionId) return; // referrer has no active property subscription of their own

    const referrerSub = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ["items.data.price"],
    });
    const creditCents = referrerSub.items.data.reduce(
      (sum, item) => sum + (item.price.unit_amount ?? 0) * (item.quantity ?? 1),
      0,
    );
    if (creditCents <= 0) return;

    await stripe.customers.createBalanceTransaction(customerId, {
      amount: -creditCents,
      currency: "usd",
      description: "CorvusPT referral reward — one month free for referring a new customer",
    });

    await adminClient
      .from("profiles")
      .update({ referral_reward_granted_at: new Date().toISOString() })
      .eq("id", referredUserId);
  } catch (err) {
    console.error("Referral reward grant failed (subscription sync above still succeeded):", err);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const secretKey = Deno.env.get("STRIPE_SECRET_KEY");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!secretKey || !webhookSecret) {
    return new Response(JSON.stringify({ error: "Missing Stripe secrets" }), {
      status: 500,
      headers: corsHeaders,
    });
  }
  const stripe = new Stripe(secretKey, { apiVersion: "2024-06-20" });

  // Signature verification needs the raw, unparsed body — read as text first.
  const rawBody = await req.text();
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return new Response(JSON.stringify({ error: "Missing stripe-signature header" }), {
      status: 400,
      headers: corsHeaders,
    });
  }

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed", err);
    return new Response(JSON.stringify({ error: "Invalid signature" }), {
      status: 400,
      headers: corsHeaders,
    });
  }

  const adminClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.client_reference_id;
      const propertyId = session.metadata?.propertyId;
      const tier =
        session.metadata?.tier === "corvusrf_managed" ? "corvusrf_managed" : "owner_managed";
      const bracket = session.metadata?.bracket ?? null;
      if (userId && propertyId && typeof session.subscription === "string") {
        await adminClient
          .from("properties")
          .update({
            stripe_subscription_id: session.subscription,
            subscription_status: "active",
            plan_tier: tier,
            value_bracket: bracket,
            cancel_at_period_end: false,
            cancel_at: null,
          })
          .eq("id", propertyId)
          .eq("user_id", userId);

        if (typeof session.customer === "string") {
          await adminClient
            .from("profiles")
            .update({ stripe_customer_id: session.customer })
            .eq("id", userId);
        }

        await syncProfilePlan(adminClient, userId);
        await grantReferralRewardIfDue(stripe, adminClient, userId);
      }
    } else if (event.type === "customer.subscription.updated") {
      const subscription = event.data.object as Stripe.Subscription;
      const { data: property } = await adminClient
        .from("properties")
        .select("id, user_id")
        .eq("stripe_subscription_id", subscription.id)
        .maybeSingle();
      if (property) {
        await adminClient
          .from("properties")
          .update({
            subscription_status: subscription.status,
            cancel_at_period_end: subscription.cancel_at_period_end,
            cancel_at: subscription.cancel_at
              ? new Date(subscription.cancel_at * 1000).toISOString()
              : null,
          })
          .eq("id", property.id);
        await syncProfilePlan(adminClient, property.user_id as string);
      }
    } else if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object as Stripe.Subscription;
      const { data: property } = await adminClient
        .from("properties")
        .select("id, user_id")
        .eq("stripe_subscription_id", subscription.id)
        .maybeSingle();
      if (property) {
        await adminClient
          .from("properties")
          .update({
            subscription_status: "canceled",
            cancel_at_period_end: false,
            cancel_at: null,
          })
          .eq("id", property.id);
        await syncProfilePlan(adminClient, property.user_id as string);
      }
    }
    // All other event types are intentionally ignored but still return 200 below so
    // Stripe doesn't keep retrying events we don't act on.

    return new Response(JSON.stringify({ received: true }), { status: 200, headers: corsHeaders });
  } catch (err) {
    console.error("Webhook handler failed", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "unknown error" }),
      { status: 500, headers: corsHeaders },
    );
  }
});
