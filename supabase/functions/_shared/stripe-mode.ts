// Runtime Stripe environment switch. Every payment edge function reads
// app_settings.stripe_mode (flipped from the admin panel's Settings tab) at
// the start of a request and uses the matching secret key — so going live, or
// falling back to test, is a toggle, not a redeploy.
//
// Secrets (set with `supabase secrets set`):
//   test  -> STRIPE_SECRET_KEY_TEST, falling back to the original
//            STRIPE_SECRET_KEY so nothing breaks before the rename
//   live  -> STRIPE_SECRET_KEY_LIVE (must be set before flipping to live)
//
// The webhook is the exception — it verifies against BOTH signing secrets and
// keys its outbound client off event.livemode; see stripe-webhook/index.ts.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export type StripeMode = "test" | "live";

// app_settings is world-readable (RLS "Anyone can read app settings"), so this
// builds its own anon client and needs no caller context.
export async function getStripeMode(): Promise<StripeMode> {
  try {
    const client = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );
    const { data } = await client
      .from("app_settings")
      .select("stripe_mode")
      .eq("id", true)
      .maybeSingle();
    return data?.stripe_mode === "live" ? "live" : "test";
  } catch {
    // Fail safe: any lookup problem means test, never surprise-live.
    return "test";
  }
}

export function stripeSecretKey(mode: StripeMode): string {
  if (mode === "live") {
    const k = Deno.env.get("STRIPE_SECRET_KEY_LIVE");
    if (!k) {
      throw new Error(
        "Payments are set to LIVE but STRIPE_SECRET_KEY_LIVE is not configured. " +
          "Set it, or switch back to test in the admin Settings tab.",
      );
    }
    return k;
  }
  const k = Deno.env.get("STRIPE_SECRET_KEY_TEST") ?? Deno.env.get("STRIPE_SECRET_KEY");
  if (!k) throw new Error("Missing STRIPE_SECRET_KEY_TEST / STRIPE_SECRET_KEY.");
  return k;
}
