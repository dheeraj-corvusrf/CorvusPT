import { supabase } from "./supabase";
import { invokeEdgeFunction } from "./edge-functions";

export type StripeMode = "test" | "live";

// Whether the live-mode Stripe config is fully in place. The edge function
// checks the two server secrets; the publishable key is a client build var so
// it's checked here. Used to gate the "set global default to LIVE" action.
export type LiveReadiness = {
  liveSecretKey: boolean;
  liveWebhookSecret: boolean;
  livePublishableKey: boolean;
  ready: boolean;
};

export async function getLiveReadiness(): Promise<LiveReadiness> {
  const { liveSecretKey, liveWebhookSecret } = await invokeEdgeFunction<{
    liveSecretKey: boolean;
    liveWebhookSecret: boolean;
  }>("stripe-live-readiness", {});
  const livePublishableKey = !!import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY_LIVE;
  return {
    liveSecretKey,
    liveWebhookSecret,
    livePublishableKey,
    ready: liveSecretKey && liveWebhookSecret && livePublishableKey,
  };
}

// ── Global default (public.app_settings, singleton) ──
// What every ordinary user's payments use. World-readable; only admins update.

export async function getGlobalStripeMode(): Promise<StripeMode> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("stripe_mode")
    .eq("id", true)
    .maybeSingle();
  if (error) throw error;
  return data?.stripe_mode === "live" ? "live" : "test";
}

export async function setGlobalStripeMode(mode: StripeMode): Promise<void> {
  const { error } = await supabase
    .from("app_settings")
    .update({ stripe_mode: mode, updated_at: new Date().toISOString() })
    .eq("id", true);
  if (error) throw error;
  await logStripeModeChange(`Global payments default set to ${mode.toUpperCase()}`);
}

// ── Per-admin override (public.admin_stripe_overrides) ──
// A row here puts this one admin in a different mode from the global — in
// practice 'test'. RLS scopes reads/writes to the caller's own row and admins
// only, so a plain query without a filter returns just your row (or nothing).

export async function getMyStripeOverride(): Promise<StripeMode | null> {
  const { data, error } = await supabase
    .from("admin_stripe_overrides")
    .select("mode")
    .maybeSingle();
  if (error) return null; // not an admin / no row
  return data?.mode === "test" || data?.mode === "live" ? data.mode : null;
}

// mode = 'test' | 'live' to set an override, null to clear it (follow global).
export async function setMyStripeOverride(mode: StripeMode | null): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in.");

  if (mode === null) {
    const { error } = await supabase.from("admin_stripe_overrides").delete().eq("user_id", user.id);
    if (error) throw error;
    await logStripeModeChange("Cleared personal payments override (now follows global)");
    return;
  }

  const { error } = await supabase
    .from("admin_stripe_overrides")
    .upsert(
      { user_id: user.id, mode, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
  if (error) throw error;
  await logStripeModeChange(`Personal payments override set to ${mode.toUpperCase()}`);
}

// ── Effective mode ── override, else global. Used by stripe.ts (which pk_ to
// load) and PaymentsModeChip. Never throws — resolves to "test" on any error,
// never a surprise "live".
export async function getStripeMode(): Promise<StripeMode> {
  try {
    const [override, global] = await Promise.all([getMyStripeOverride(), getGlobalStripeMode()]);
    return override ?? global;
  } catch {
    return "test";
  }
}

async function logStripeModeChange(detail: string): Promise<void> {
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    await supabase.from("admin_audit_log").insert({
      actor_id: user.id,
      actor_email: user.email ?? "",
      action: "stripe_mode_changed",
      detail,
    });
  } catch (err) {
    console.error("admin_audit_log insert failed:", err);
  }
}
