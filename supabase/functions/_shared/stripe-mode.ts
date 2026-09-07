// Runtime Stripe environment switch.
//
//   effective mode = this admin's override (admin_stripe_overrides), else the
//                    global default (app_settings.stripe_mode)
//
// The global default is meant to be 'live' — every ordinary user pays for real.
// An admin can put JUST THEMSELVES into 'test' via the admin Settings tab
// (admin_stripe_overrides, admin-only by RLS) for staff testing. Every payment
// edge function resolves this per request and uses the matching secret key.
//
// Secrets (set with `supabase secrets set`):
//   test  -> STRIPE_SECRET_KEY_TEST, falling back to the original
//            STRIPE_SECRET_KEY so nothing breaks before the rename
//   live  -> STRIPE_SECRET_KEY_LIVE (must be set before the global goes live)
//
// The webhook is the exception — it verifies against every configured signing
// secret and keys its outbound client off event.livemode; see
// stripe-webhook/index.ts.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export type StripeMode = "test" | "live";

// Uses a service-role client (bypasses RLS) so it can read the caller's own
// override row by id — only admins ever have one, since the RLS insert policy
// on admin_stripe_overrides is admin-only. Pass null for `userId` where there's
// no authenticated caller.
export async function getStripeMode(userId: string | null): Promise<StripeMode> {
  try {
    const client = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: settings } = await client
      .from("app_settings")
      .select("stripe_mode")
      .eq("id", true)
      .maybeSingle();
    const globalMode: StripeMode = settings?.stripe_mode === "live" ? "live" : "test";

    if (!userId) return globalMode;

    const { data: override } = await client
      .from("admin_stripe_overrides")
      .select("mode")
      .eq("user_id", userId)
      .maybeSingle();
    if (override?.mode === "test" || override?.mode === "live") return override.mode;
    return globalMode;
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
          "Set it, or switch the global default back to test in the admin Settings tab.",
      );
    }
    return k;
  }
  const k = Deno.env.get("STRIPE_SECRET_KEY_TEST") ?? Deno.env.get("STRIPE_SECRET_KEY");
  if (!k) throw new Error("Missing STRIPE_SECRET_KEY_TEST / STRIPE_SECRET_KEY.");
  return k;
}
