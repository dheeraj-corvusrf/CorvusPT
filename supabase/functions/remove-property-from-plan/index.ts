// Deploy via CLI: `supabase functions deploy remove-property-from-plan`.
// Requires STRIPE_SECRET_KEY.
//
// Real per-property "stop paying for this one" action — reduces the
// caller's paid property count by exactly one, directly on their live
// Stripe subscription, rather than sending them into the generic Customer
// Portal (which only offers "cancel everything," see the properties.tsx
// comment this replaces) or requiring a support request.
//
// A subscription's paid count is a QUANTITY per value bracket, not a
// specific line item per property (see billing.ts's own comment on
// getEntitledPropertyIds) — properties aren't individually tied to a
// specific paid "slot." This picks a real bracket to decrement (the
// property's own value bracket if it has a paid slot, otherwise whichever
// bracket does), matching what the client already showed the user before
// they confirmed (see handleRemoveFromPlan's own comment in
// _layout.properties.tsx for why the actual property that loses coverage,
// per the oldest-properties-first rule, isn't always guaranteed to be this
// exact one).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

type Bracket = "under2m" | "mid2m10m" | "over10m";
const BRACKETS: Bracket[] = ["under2m", "mid2m10m", "over10m"];

// Same $2M/$10M boundaries shown on /pricing (VALUE_BRACKETS) — the one
// place in the app that classifies a property's own real value into a
// bracket, since bracket quantities are otherwise purchased as a plain
// self-declared count (create-checkout-session), never tied to a specific
// property. Duplicated here by hand — Deno can't import src/lib/billing.ts.
function bracketForValue(value: number | null): Bracket {
  if (value == null) return "under2m";
  if (value < 2_000_000) return "under2m";
  if (value < 10_000_000) return "mid2m10m";
  return "over10m";
}

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

    // Ownership check via .eq("user_id", user.id) — never trust propertyId
    // alone; a caller can only ever remove coverage for their own property.
    const { data: property } = await adminClient
      .from("properties")
      .select("id, total_value")
      .eq("id", propertyId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!property) {
      return new Response(JSON.stringify({ error: "Property not found." }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    const { data: profileRow } = await adminClient
      .from("profiles")
      .select("plan, stripe_subscription_id")
      .eq("id", user.id)
      .single();
    if (!profileRow?.stripe_subscription_id) {
      return new Response(JSON.stringify({ error: "No active subscription found." }), {
        status: 400,
        headers: corsHeaders,
      });
    }
    const tier = profileRow.plan === "corvusrf_managed" ? "corvusrf_managed" : "owner_managed";

    const stripe = new Stripe(secretKey, { apiVersion: "2024-06-20" });
    const subscription = await stripe.subscriptions.retrieve(profileRow.stripe_subscription_id, {
      expand: ["items.data.price.product"],
    });

    type Item = Stripe.SubscriptionItem;
    function itemBracket(item: Item): Bracket | null {
      const product = item.price?.product;
      if (!product || typeof product !== "object" || product.deleted) return null;
      const meta = (product as Stripe.Product).metadata;
      return meta?.tier === tier && BRACKETS.includes(meta.bracket as Bracket)
        ? (meta.bracket as Bracket)
        : null;
    }

    const itemsByBracket = new Map<Bracket, Item[]>();
    for (const item of subscription.items.data) {
      const b = itemBracket(item);
      if (!b) continue;
      itemsByBracket.set(b, [...(itemsByBracket.get(b) ?? []), item]);
    }

    // Prefer the property's own real value bracket; fall back to whichever
    // bracket actually has a paid quantity, since brackets aren't tied to
    // specific properties (see the top-of-file comment) — the real goal is
    // "reduce the total paid count by one," not "find THIS property's
    // slot," which doesn't exist as a distinct thing to find.
    const preferred = bracketForValue(property.total_value as number | null);
    const targetBracket =
      (itemsByBracket.get(preferred)?.length ?? 0) > 0
        ? preferred
        : BRACKETS.find((b) => (itemsByBracket.get(b)?.length ?? 0) > 0);
    const targetItems = targetBracket ? (itemsByBracket.get(targetBracket) ?? []) : [];
    if (!targetBracket || targetItems.length === 0) {
      return new Response(
        JSON.stringify({ error: "You don't have any paid properties to remove." }),
        { status: 400, headers: corsHeaders },
      );
    }

    // create-checkout-session splits each bracket into up to 2 line items:
    // one at full price (always quantity 1) and, only once a 2nd+ property
    // exists in that bracket, a second at the 15%-off price (quantity =
    // count - 1). Higher unit_amount is always the full-price item.
    targetItems.sort((a, b) => (b.price?.unit_amount ?? 0) - (a.price?.unit_amount ?? 0));
    const [fullPriceItem, discountedItem] = targetItems;

    // A quantity decrement never removes an item; anything else (deleting
    // the discounted item once its own quantity hits 1, or deleting the
    // sole full-price item when there's no discounted item at all) does.
    const decrementingQuantity = !!discountedItem && (discountedItem.quantity ?? 0) > 1;
    const willDeleteAnItem = !decrementingQuantity;
    // Stripe refuses to delete the last item on an active subscription —
    // cancel the whole thing instead when that's what this would do. Real,
    // honest outcome: zero paid properties left really does mean no more
    // active subscription.
    const cancelsWholeSubscription = willDeleteAnItem && subscription.items.data.length === 1;

    if (decrementingQuantity) {
      await stripe.subscriptionItems.update(discountedItem.id, {
        quantity: (discountedItem.quantity ?? 1) - 1,
      });
    } else if (cancelsWholeSubscription) {
      await stripe.subscriptions.cancel(subscription.id);
    } else if (discountedItem) {
      // Discounted item's quantity was exactly 1 (2 total properties in
      // this bracket) — removing one more leaves the discounted item with
      // nothing to represent; delete it and keep the full-price item at 1.
      await stripe.subscriptionItems.del(discountedItem.id);
    } else {
      await stripe.subscriptionItems.del(fullPriceItem.id);
    }

    // Real remaining count, re-read fresh rather than computed by hand from
    // the mutation above — cheaper to just ask Stripe again than risk this
    // function's own arithmetic drifting from summarizeItems' (the webhook's
    // own tally, which is what the DB will actually end up holding).
    const remainingPaidCount = cancelsWholeSubscription
      ? 0
      : (
          await stripe.subscriptions.retrieve(subscription.id, {
            expand: ["items.data"],
          })
        ).items.data.reduce((sum, item) => sum + (item.quantity ?? 0), 0);

    // The real profiles.qty_*/subscription_status sync for this change is
    // the existing customer.subscription.updated / customer.subscription.
    // deleted webhook (stripe-webhook/index.ts) — already fires for any
    // subscription-item change regardless of source (Portal, here, or
    // anywhere else), so it isn't duplicated here.
    return new Response(JSON.stringify({ ok: true, remainingPaidCount }), {
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
