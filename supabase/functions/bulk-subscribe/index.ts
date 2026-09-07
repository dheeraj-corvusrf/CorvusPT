// Deploy via CLI: `supabase functions deploy bulk-subscribe`.
// Requires STRIPE_SECRET_KEY.
//
// Step 2 of the bulk-subscribe flow. Takes a list of {propertyId, tier} plus
// the payment method the client just collected + confirmed via bulk-subscribe-
// setup's SetupIntent, sets it as the customer's default, then creates ONE
// independent Stripe subscription per property off-session (same per-property
// model as create-checkout-session — see ../_shared/pricing.ts for the shared
// bracket + 2nd-property-discount math). Writes each property row directly
// (mirroring stripe-webhook's checkout.session.completed handler) so the UI
// updates immediately; the webhook's customer.subscription.created handler is
// the idempotent catch-up and the referral-reward path.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";
import { getStripeMode, stripeSecretKey } from "../_shared/stripe-mode.ts";
import {
  bracketForValue,
  isTier,
  subscriptionProductName,
  unitAmountCents,
  type Bracket,
  type Tier,
} from "../_shared/pricing.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

const MAX_ITEMS = 50;

// Same rule as stripe-webhook's syncProfilePlan (never touches a beta account).
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

type Item = { propertyId: string; tier: Tier };
type Result = {
  propertyId: string;
  status: "active" | "needs_action" | "error";
  message?: string;
  hostedInvoiceUrl?: string;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = (await req.json()) as { items?: unknown; paymentMethodId?: unknown };
    const paymentMethodId = body.paymentMethodId;
    if (typeof paymentMethodId !== "string" || !paymentMethodId.startsWith("pm_")) {
      return new Response(JSON.stringify({ error: "paymentMethodId is required" }), {
        status: 400,
        headers: corsHeaders,
      });
    }
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return new Response(JSON.stringify({ error: "items must be a non-empty array" }), {
        status: 400,
        headers: corsHeaders,
      });
    }
    if (body.items.length > MAX_ITEMS) {
      return new Response(JSON.stringify({ error: `at most ${MAX_ITEMS} properties at once` }), {
        status: 400,
        headers: corsHeaders,
      });
    }
    // Validate + dedupe (first tier wins for a repeated propertyId).
    const seen = new Set<string>();
    const items: Item[] = [];
    for (const raw of body.items) {
      const it = raw as { propertyId?: unknown; tier?: unknown };
      if (typeof it.propertyId !== "string" || !it.propertyId || !isTier(it.tier)) {
        return new Response(JSON.stringify({ error: "each item needs propertyId + a valid tier" }), {
          status: 400,
          headers: corsHeaders,
        });
      }
      if (seen.has(it.propertyId)) continue;
      seen.add(it.propertyId);
      items.push({ propertyId: it.propertyId, tier: it.tier });
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
    const { data: profile } = await adminClient
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", user.id)
      .maybeSingle();
    const customerId = profile?.stripe_customer_id as string | null | undefined;
    if (!customerId) {
      return new Response(
        JSON.stringify({ error: "No billing account — run bulk-subscribe-setup first." }),
        { status: 400, headers: corsHeaders },
      );
    }

    const stripe = new Stripe(secretKey, { apiVersion: "2024-06-20" });

    // The SetupIntent confirm already attaches the PM to the customer; attach
    // again defensively and ignore the "already attached" error.
    try {
      await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
    } catch (_e) {
      // already attached / not attachable — the update below still validates it
    }
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    // The caller's own properties for the requested ids, still unpaid.
    const ids = items.map((i) => i.propertyId);
    const { data: propRows } = await adminClient
      .from("properties")
      .select("id, address, total_value, subscription_status")
      .eq("user_id", user.id)
      .in("id", ids);
    const propById = new Map(
      (propRows ?? []).map((p) => [p.id as string, p as Record<string, unknown>]),
    );

    // Existing active subscriptions per tier+bracket — the base the
    // 2nd-property discount counts from, before this batch adds to it.
    const { data: activeRows } = await adminClient
      .from("properties")
      .select("plan_tier, value_bracket")
      .eq("user_id", user.id)
      .eq("subscription_status", "active");
    const bracketCount: Record<string, number> = {};
    const key = (t: string, b: string) => `${t}:${b}`;
    for (const r of activeRows ?? []) {
      if (r.plan_tier && r.value_bracket) {
        bracketCount[key(r.plan_tier as string, r.value_bracket as string)] =
          (bracketCount[key(r.plan_tier as string, r.value_bracket as string)] ?? 0) + 1;
      }
    }

    const results: Result[] = [];
    let anyActive = false;

    for (const { propertyId, tier } of items) {
      const prop = propById.get(propertyId);
      if (!prop) {
        results.push({ propertyId, status: "error", message: "Property not found." });
        continue;
      }
      if (prop.subscription_status === "active") {
        results.push({ propertyId, status: "error", message: "Already subscribed." });
        continue;
      }

      const bracket = bracketForValue(prop.total_value as number | null) as Bracket;
      const k = key(tier, bracket);
      const isAdditional = (bracketCount[k] ?? 0) > 0;
      const address = ((prop.address as string | null) ?? "").trim();
      const unitAmount = unitAmountCents(tier, bracket, isAdditional);
      const name = subscriptionProductName(tier, bracket, address, isAdditional);

      try {
        const sub = await stripe.subscriptions.create({
          customer: customerId,
          items: [
            {
              price_data: {
                currency: "usd",
                unit_amount: unitAmount,
                recurring: { interval: "month" },
                product_data: { name, metadata: { tier, bracket } },
              },
            },
          ],
          default_payment_method: paymentMethodId,
          off_session: true,
          payment_behavior: "allow_incomplete",
          description: address || undefined,
          metadata: { tier, bracket, propertyId },
          expand: ["latest_invoice.payment_intent"],
        });

        bracketCount[k] = (bracketCount[k] ?? 0) + 1;

        const live = sub.status === "active" || sub.status === "trialing";
        if (live) anyActive = true;

        await adminClient
          .from("properties")
          .update({
            stripe_subscription_id: sub.id,
            subscription_status: sub.status,
            plan_tier: tier,
            value_bracket: bracket,
            cancel_at_period_end: false,
            cancel_at: null,
          })
          .eq("id", propertyId)
          .eq("user_id", user.id);

        if (live) {
          results.push({ propertyId, status: "active" });
        } else {
          const invoice = sub.latest_invoice as Stripe.Invoice | null;
          results.push({
            propertyId,
            status: "needs_action",
            message: `Subscription is ${sub.status} — payment needs to be completed.`,
            hostedInvoiceUrl: invoice?.hosted_invoice_url ?? undefined,
          });
        }
      } catch (e) {
        results.push({
          propertyId,
          status: "error",
          message: e instanceof Error ? e.message : "Could not create this subscription.",
        });
      }
    }

    if (anyActive) await syncProfilePlan(adminClient, user.id);

    return new Response(JSON.stringify({ results }), { status: 200, headers: corsHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "unknown error" }),
      { status: 500, headers: corsHeaders },
    );
  }
});
