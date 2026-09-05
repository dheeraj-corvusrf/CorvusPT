// Deploy via CLI: `supabase functions deploy stripe-webhook`.
// Requires STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET secrets. After deploying, add
// this function's URL as a webhook endpoint in the Stripe Dashboard, subscribed to
// checkout.session.completed, customer.subscription.updated, and
// customer.subscription.deleted.
//
// No Supabase auth here — Stripe calls this directly and authenticates via an HMAC
// signature (verified below) instead of a Supabase JWT. The service-role client is
// used to write to profiles, bypassing RLS, since there is no end-user session.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, stripe-signature",
  "Content-Type": "application/json",
};

// create-checkout-session prices every bracket via ad hoc price_data (a fresh
// Price/Product per checkout, to support the 15%-off-2nd-property discount),
// so there's no fixed, known-ahead-of-time Price id to match line items
// against any more. Instead it stamps { tier, bracket } as metadata on each
// line item's Product (see that function), which persists on the Product for
// the life of the subscription — read back here via BRACKET_COLUMN. This also
// correctly re-derives brackets after a quantity change made through the
// Stripe Billing Portal, not just at fresh-checkout time. Anything with no
// recognizable bracket metadata (e.g. a manually-created test subscription)
// still counts toward subscription_quantity below, just without a bracket
// breakdown.
const BRACKET_COLUMN: Record<string, "qty_under_2m" | "qty_2m_10m" | "qty_over_10m"> = {
  under2m: "qty_under_2m",
  mid2m10m: "qty_2m_10m",
  over10m: "qty_over_10m",
};

// Sums every line item's quantity (a subscription now has up to 6 — up to 2
// per non-empty value bracket, full-price + discounted — instead of always
// exactly 1) for the total, and separately buckets each line item's quantity
// into its matching bracket column via the Product metadata BRACKET_COLUMN
// reads. `items` must come from a subscription fetched with
// `expand: ["items.data.price.product"]` so `item.price.product` is a full
// object, not just an id string.
function summarizeItems(items: Stripe.SubscriptionItem[]) {
  const totals = { qty_under_2m: 0, qty_2m_10m: 0, qty_over_10m: 0 };
  let quantity = 0;
  for (const item of items) {
    const q = item.quantity ?? 0;
    quantity += q;
    const product = item.price?.product;
    const bracket =
      product && typeof product === "object" && !product.deleted
        ? (product as Stripe.Product).metadata?.bracket
        : undefined;
    const column = bracket ? BRACKET_COLUMN[bracket] : undefined;
    if (column) totals[column] += q;
  }
  return { quantity: quantity || 1, ...totals };
}

// One month free for whoever referred this NEW paying customer — real
// business rule ("each referral gives one month free"), so the credit
// amount is the REFERRER's own real current monthly total (summed straight
// off their real Stripe subscription line items), never a guessed flat
// dollar figure. Granted via Stripe's customer balance (a negative balance
// transaction), which Stripe applies to the referrer's own next invoice(s)
// automatically — not a coupon/promo code, which would need per-price setup
// this per-property/per-bracket pricing doesn't have a fixed Price id for
// (see create-checkout-session's own comment on ad hoc price_data).
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
      .select("stripe_customer_id, stripe_subscription_id")
      .eq("id", referrerId)
      .maybeSingle();
    const customerId = referrer?.stripe_customer_id as string | null | undefined;
    const subscriptionId = referrer?.stripe_subscription_id as string | null | undefined;
    if (!customerId || !subscriptionId) return; // referrer isn't a paying customer themselves yet

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
      const tier = session.metadata?.tier === "corvusrf_managed" ? "corvusrf_managed" : "owner_managed";
      if (userId) {
        let summary = summarizeItems([]);
        if (typeof session.subscription === "string") {
          const sub = await stripe.subscriptions.retrieve(session.subscription, {
            expand: ["items.data.price.product"],
          });
          summary = summarizeItems(sub.items.data);
        }
        await adminClient
          .from("profiles")
          .update({
            plan: tier,
            subscription_status: "active",
            subscription_quantity: summary.quantity,
            qty_under_2m: summary.qty_under_2m,
            qty_2m_10m: summary.qty_2m_10m,
            qty_over_10m: summary.qty_over_10m,
            stripe_customer_id: typeof session.customer === "string" ? session.customer : null,
            stripe_subscription_id:
              typeof session.subscription === "string" ? session.subscription : null,
          })
          .eq("id", userId);

        await grantReferralRewardIfDue(stripe, adminClient, userId);
      }
    } else if (event.type === "customer.subscription.updated") {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId = typeof subscription.customer === "string" ? subscription.customer : null;
      if (customerId) {
        const tier =
          subscription.metadata?.tier === "corvusrf_managed" ? "corvusrf_managed" : "owner_managed";
        // The event payload's subscription.items.data isn't expanded to full
        // Product objects — re-fetch so summarizeItems can read bracket
        // metadata off item.price.product.
        const expandedSub = await stripe.subscriptions.retrieve(subscription.id, {
          expand: ["items.data.price.product"],
        });
        const summary = summarizeItems(expandedSub.items.data);
        const update: Record<string, string | number | boolean | null> = {
          subscription_status: subscription.status,
          subscription_quantity: summary.quantity,
          qty_under_2m: summary.qty_under_2m,
          qty_2m_10m: summary.qty_2m_10m,
          qty_over_10m: summary.qty_over_10m,
          cancel_at_period_end: subscription.cancel_at_period_end,
          cancel_at: subscription.cancel_at
            ? new Date(subscription.cancel_at * 1000).toISOString()
            : null,
        };
        if (subscription.status === "active") update.plan = tier;
        if (subscription.status === "canceled") update.plan = "free_ai_review";
        await adminClient.from("profiles").update(update).eq("stripe_customer_id", customerId);
      }
    } else if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId = typeof subscription.customer === "string" ? subscription.customer : null;
      if (customerId) {
        await adminClient
          .from("profiles")
          .update({
            plan: "free_ai_review",
            subscription_status: "canceled",
            subscription_quantity: 1,
            qty_under_2m: 0,
            qty_2m_10m: 0,
            qty_over_10m: 0,
            cancel_at_period_end: false,
            cancel_at: null,
          })
          .eq("stripe_customer_id", customerId);
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
