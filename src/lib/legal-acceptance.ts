import { supabase } from "./supabase";
import { invokeEdgeFunction } from "./edge-functions";
import { TERMS_VERSION, PRIVACY_VERSION, SIGNUP_ACK_VERSION, AI_ACK_VERSION } from "./legal";

export type TermsAcceptance = {
  termsVersion: string;
  privacyVersion: string;
  ackVersion: string;
  acceptedAt: string;
};

// The most recent Terms/Privacy acceptance on file for the signed-in user,
// or null if there is none.
export async function getLatestTermsAcceptance(): Promise<TermsAcceptance | null> {
  const { data, error } = await supabase
    .from("terms_acceptances")
    .select("terms_version, privacy_version, ack_version, accepted_at")
    .order("accepted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return {
    termsVersion: data.terms_version as string,
    privacyVersion: data.privacy_version as string,
    ackVersion: data.ack_version as string,
    acceptedAt: data.accepted_at as string,
  };
}

// True when the user needs to (re-)accept — no acceptance on file, or the
// stored versions are behind the current constants in legal.ts.
export function termsAcceptanceNeeded(acc: TermsAcceptance | null): boolean {
  if (!acc) return true;
  return (
    acc.termsVersion !== TERMS_VERSION ||
    acc.privacyVersion !== PRIVACY_VERSION ||
    acc.ackVersion !== SIGNUP_ACK_VERSION
  );
}

// Records an acceptance for the current versions. Goes through the edge
// function so the request IP + user agent are captured server-side. Used by
// LegalGate for re-acceptance (signup itself is recorded by handle_new_user).
export async function recordTermsAcceptance(): Promise<void> {
  await invokeEdgeFunction("record-terms-acceptance", {
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION,
    ackVersion: SIGNUP_ACK_VERSION,
  });
}

// "Review Before Proceeding" acknowledgement, recorded per property/case the
// first time (or every time) an owner is about to rely on / submit AI output.
export async function recordAiAcknowledgement(input: {
  propertyId: string;
  protestId?: string | null;
}): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in.");
  const { error } = await supabase.from("ai_acknowledgements").insert({
    user_id: user.id,
    property_id: input.propertyId,
    protest_id: input.protestId ?? null,
    ack_version: AI_ACK_VERSION,
  });
  if (error) throw error;
}
