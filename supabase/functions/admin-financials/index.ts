// Deploy via CLI: `supabase functions deploy admin-financials`.
// Requires STRIPE_SECRET_KEY_LIVE (preferred) or the test key; Stripe npm:17.
//
// Admin-only. Aggregates the real financial picture for the admin dashboard:
// MRR + active-subscription count from Stripe, gross collected (all-time and
// last 12 months) from Stripe charges, a plan mix from each subscription's
// price, and headline counts (signups, properties by subscription status)
// from our own DB. Read-only; returns numbers, never a secret or a raw
// Stripe object.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";
import { getStripeMode, stripeSecretKey, type StripeMode } from "../_shared/stripe-mode.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

const monthKey = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 7); // YYYY-MM

// Normalise a Stripe recurring price to a monthly amount (yearly -> /12).
function monthlyAmount(price: Stripe.Price | null | undefined): number {
  if (!price || !price.recurring || price.unit_amount == null) return 0;
  const per = price.recurring.interval === "year" ? price.unit_amount / 12 : price.unit_amount;
  const count = price.recurring.interval_count || 1;
  return price.recurring.interval === "year" ? per / count : per / count;
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

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: profile } = await adminClient
      .from("profiles")
      .select("is_admin")
      .eq("id", user.id)
      .maybeSingle();
    if (!profile?.is_admin) {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: corsHeaders,
      });
    }

    // Prefer the real live key for a production financial picture; fall back
    // to whatever mode is effective for this admin (test, for staging).
    let mode: StripeMode = "test";
    let secret: string;
    if (Deno.env.get("STRIPE_SECRET_KEY_LIVE")) {
      mode = "live";
      secret = stripeSecretKey("live");
    } else {
      mode = await getStripeMode(user.id);
      secret = stripeSecretKey(mode);
    }
    const stripe = new Stripe(secret, { apiVersion: "2024-06-20" });

    // ── Subscriptions -> MRR, active count, status mix, plan mix ──
    const byStatus: Record<string, number> = {};
    const planMap = new Map<string, { label: string; count: number; mrrCents: number }>();
    let mrrCents = 0;
    let activeCount = 0;
    const customers = new Set<string>();

    for await (const sub of stripe.subscriptions.list({
      status: "all",
      limit: 100,
      expand: ["data.items.data.price"],
    })) {
      byStatus[sub.status] = (byStatus[sub.status] ?? 0) + 1;
      if (typeof sub.customer === "string") customers.add(sub.customer);
      const live = sub.status === "active" || sub.status === "trialing";
      const subMonthly = sub.items.data.reduce(
        (n, it) => n + monthlyAmount(it.price) * (it.quantity ?? 1),
        0,
      );
      if (live) {
        activeCount++;
        mrrCents += subMonthly;
        const tier = sub.metadata?.planTier ?? "unknown";
        const bracket = sub.metadata?.valueBracket ?? "";
        const key = `${tier}|${bracket}`;
        const label = bracket ? `${tier} · ${bracket}` : tier;
        const slot = planMap.get(key) ?? { label, count: 0, mrrCents: 0 };
        slot.count++;
        slot.mrrCents += subMonthly;
        planMap.set(key, slot);
      }
    }

    // ── Charges -> gross collected, by month (last 12) ──
    const since = Math.floor(Date.now() / 1000) - 400 * 24 * 60 * 60; // ~13 months
    let collectedAllTimeCents = 0;
    let refundedAllTimeCents = 0;
    const byMonth = new Map<string, number>();
    for await (const ch of stripe.charges.list({ limit: 100, created: { gte: since } })) {
      if (!ch.paid || ch.status !== "succeeded") continue;
      const net = ch.amount - (ch.amount_refunded ?? 0);
      collectedAllTimeCents += net;
      refundedAllTimeCents += ch.amount_refunded ?? 0;
      const m = monthKey(ch.created);
      byMonth.set(m, (byMonth.get(m) ?? 0) + net);
    }
    // Also pull an all-time gross via the balance summary is heavier; the ~13
    // month charge window is the practical "collected" figure for a young SaaS.

    const months: { month: string; amountCents: number }[] = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const m = d.toISOString().slice(0, 7);
      months.push({ month: m, amountCents: byMonth.get(m) ?? 0 });
    }

    // ── DB counts ──
    const { count: signups } = await adminClient
      .from("profiles")
      .select("id", { count: "exact", head: true });
    const { data: props } = await adminClient
      .from("properties")
      .select("subscription_status");
    const propsByStatus: Record<string, number> = {};
    for (const p of props ?? []) {
      const s = (p.subscription_status as string | null) ?? "none";
      propsByStatus[s] = (propsByStatus[s] ?? 0) + 1;
    }

    return new Response(
      JSON.stringify({
        mode,
        currency: "usd",
        mrrCents: Math.round(mrrCents),
        activeSubscriptions: activeCount,
        subscriptionCustomers: customers.size,
        subscriptionsByStatus: byStatus,
        planMix: [...planMap.values()]
          .map((p) => ({ label: p.label, count: p.count, mrrCents: Math.round(p.mrrCents) }))
          .sort((a, b) => b.mrrCents - a.mrrCents),
        collectedRecentCents: Math.round(collectedAllTimeCents),
        refundedRecentCents: Math.round(refundedAllTimeCents),
        collectedByMonth: months,
        signups: signups ?? 0,
        propertiesByStatus: propsByStatus,
      }),
      { status: 200, headers: corsHeaders },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "unknown error" }),
      { status: 500, headers: corsHeaders },
    );
  }
});
