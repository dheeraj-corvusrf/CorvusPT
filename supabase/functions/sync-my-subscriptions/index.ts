// Deploy via CLI: `supabase functions deploy sync-my-subscriptions`.
// Requires STRIPE_SECRET_KEY.
//
// Pull-based reconciliation of the signed-in user's property subscriptions.
// stripe-webhook (checkout.session.completed / customer.subscription.updated /
// .deleted) is the push path that keeps properties.subscription_status et al.
// in sync, but a missed, delayed, or (in a sandbox) unconfigured webhook
// leaves a genuinely paid property showing "Not Paid" — and that column gates
// AI Report access and protest filing, not just a badge. This re-derives each
// property's state straight from Stripe (the source of truth) and writes the
// exact same columns the webhook does, so simply loading the app self-heals.
// Only writes rows that actually differ; returns how many changed.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";
import { getStripeMode, stripeSecretKey } from "../_shared/stripe-mode.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

// A subscription in one of these states still confers access; anything else
// (canceled, incomplete_expired, paused) does not.
const LIVE = new Set(["active", "trialing", "past_due", "unpaid", "incomplete"]);

type Row = {
  id: string;
  stripe_subscription_id: string | null;
  subscription_status: string | null;
  plan_tier: string | null;
  value_bracket: string | null;
  cancel_at_period_end: boolean;
  cancel_at: string | null;
};

// Same rule as stripe-webhook's syncProfilePlan — profiles.plan is just "the
// tier of this customer's most recently created active property subscription."
// Never touches a beta account.
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
      .maybeSingle();
    if (!profile?.stripe_customer_id) {
      return new Response(JSON.stringify({ updated: 0 }), { status: 200, headers: corsHeaders });
    }

    const { data: propsData } = await adminClient
      .from("properties")
      .select(
        "id, stripe_subscription_id, subscription_status, plan_tier, value_bracket, cancel_at_period_end, cancel_at",
      )
      .eq("user_id", user.id);
    const rows = (propsData ?? []) as Row[];
    if (rows.length === 0) {
      return new Response(JSON.stringify({ updated: 0 }), { status: 200, headers: corsHeaders });
    }

    const stripe = new Stripe(secretKey, { apiVersion: "2024-06-20" });
    const list = await stripe.subscriptions.list({
      customer: profile.stripe_customer_id,
      status: "all",
      limit: 100,
    });

    // Best Stripe subscription for a given property: a LIVE one beats a dead
    // one; between two of the same liveness, the more recently created wins.
    const pickBest = (a: Stripe.Subscription, b: Stripe.Subscription): Stripe.Subscription => {
      const aLive = LIVE.has(a.status);
      const bLive = LIVE.has(b.status);
      if (aLive !== bLive) return aLive ? a : b;
      return a.created >= b.created ? a : b;
    };

    let updated = 0;
    for (const row of rows) {
      const matches = list.data.filter(
        (s) => s.metadata?.propertyId === row.id || s.id === row.stripe_subscription_id,
      );
      // No Stripe subscription ever associated with this property and none on
      // the row either — genuinely never subscribed, leave it alone.
      if (matches.length === 0 && !row.stripe_subscription_id) continue;

      const best = matches.length > 0 ? matches.reduce(pickBest) : null;

      let desired: Partial<Row>;
      if (best && LIVE.has(best.status)) {
        desired = {
          stripe_subscription_id: best.id,
          subscription_status: best.status,
          plan_tier: (best.metadata?.tier as string | undefined) ?? row.plan_tier,
          value_bracket: (best.metadata?.bracket as string | undefined) ?? row.value_bracket,
          cancel_at_period_end: best.cancel_at_period_end,
          cancel_at: best.cancel_at ? new Date(best.cancel_at * 1000).toISOString() : null,
        };
      } else {
        // Only dead subscriptions (or none) match, but the row still points at
        // one — reflect that it's over. Tier/bracket are left as historical.
        desired = {
          subscription_status: "canceled",
          cancel_at_period_end: false,
          cancel_at: null,
        };
      }

      const changed = (Object.keys(desired) as (keyof Row)[]).some(
        (k) => desired[k] !== undefined && desired[k] !== row[k],
      );
      if (!changed) continue;

      await adminClient
        .from("properties")
        .update(desired)
        .eq("id", row.id)
        .eq("user_id", user.id);
      updated += 1;
    }

    if (updated > 0) await syncProfilePlan(adminClient, user.id);

    return new Response(JSON.stringify({ updated }), { status: 200, headers: corsHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "unknown error" }),
      { status: 500, headers: corsHeaders },
    );
  }
});
