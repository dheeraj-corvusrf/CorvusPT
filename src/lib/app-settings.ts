import { supabase } from "./supabase";

// Single-row global config (public.app_settings, id = true). World-readable;
// only admins can update (RLS). Currently just the Stripe environment switch.
export type StripeMode = "test" | "live";

export type AppSettings = {
  stripeMode: StripeMode;
};

export async function getAppSettings(): Promise<AppSettings> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("stripe_mode")
    .eq("id", true)
    .maybeSingle();
  if (error) throw error;
  return { stripeMode: data?.stripe_mode === "live" ? "live" : "test" };
}

// Cheap standalone read for the pieces that only need the mode (stripe.ts,
// the mode banner). Never throws — a lookup problem resolves to "test", never
// a surprise "live".
export async function getStripeMode(): Promise<StripeMode> {
  try {
    const { stripeMode } = await getAppSettings();
    return stripeMode;
  } catch {
    return "test";
  }
}

// Admin-only (enforced by RLS). Also writes an admin_audit_log row — flipping
// to live means real charges, so it's a tracked action.
export async function setStripeMode(mode: StripeMode): Promise<void> {
  const { error } = await supabase
    .from("app_settings")
    .update({ stripe_mode: mode, updated_at: new Date().toISOString() })
    .eq("id", true);
  if (error) throw error;

  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      await supabase.from("admin_audit_log").insert({
        actor_id: user.id,
        actor_email: user.email ?? "",
        action: "stripe_mode_changed",
        detail: `Payments switched to ${mode.toUpperCase()} mode`,
      });
    }
  } catch (err) {
    console.error("admin_audit_log insert failed:", err);
  }
}
