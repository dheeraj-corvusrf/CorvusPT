import { supabase } from "./supabase";

// One month free, per successful referral — see stripe-webhook/index.ts for
// where the actual Stripe credit is granted (real amount = the referrer's
// own current subscription total, computed from their real Stripe
// subscription line items, never a guessed flat number). This file is just
// the read side: the user's own shareable code/link, and their real
// referral list (via get_my_referrals(), a security-definer RPC — see its
// own comment in schema.sql for why this isn't a plain table SELECT).
export type ReferralRecord = {
  id: string;
  firstName: string | null;
  signedUpAt: string;
  // True once the referred person's plan is a real paid tier
  // (owner_managed/corvusrf_managed) — not just "signed up."
  converted: boolean;
  // True once stripe-webhook has actually granted the referrer's one month
  // free for this specific referral.
  rewarded: boolean;
};

type ReferralRow = {
  id: string;
  first_name: string | null;
  signed_up_at: string;
  converted: boolean;
  rewarded: boolean;
};

export async function getMyReferralCode(userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("referral_code")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data?.referral_code as string | null) ?? null;
}

export async function getMyReferrals(): Promise<ReferralRecord[]> {
  const { data, error } = await supabase.rpc("get_my_referrals");
  if (error) throw error;
  return (data as ReferralRow[]).map((row) => ({
    id: row.id,
    firstName: row.first_name,
    signedUpAt: row.signed_up_at,
    converted: row.converted,
    rewarded: row.rewarded,
  }));
}

// A real, working sign-up link — ?ref= is read by sign-in.tsx and threaded
// through supabase.auth.signUp()'s options.data, resolved server-side by
// handle_new_user() (see schema.sql) into a real referred_by user id. Never
// trust/resolve the code client-side — this function only ever builds the
// URL, it doesn't look anyone up.
export function buildReferralLink(code: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/sign-in?mode=signup&ref=${encodeURIComponent(code)}`;
}
