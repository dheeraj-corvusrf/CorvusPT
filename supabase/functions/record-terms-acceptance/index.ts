// Deploy via CLI: `supabase functions deploy record-terms-acceptance`.
//
// Records a signed-in user's (re-)acceptance of the Terms of Service and
// Privacy Policy. The signup acceptance itself is written by the
// handle_new_user() trigger; this endpoint is for LegalGate, which prompts
// when the stored versions fall behind the current ones. Writing here (rather
// than a client insert) lets us capture the request IP and user agent.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { termsVersion, privacyVersion, ackVersion } = (await req.json()) as {
      termsVersion?: string;
      privacyVersion?: string;
      ackVersion?: string;
    };
    if (!termsVersion || !privacyVersion || !ackVersion) {
      return new Response(
        JSON.stringify({ error: "termsVersion, privacyVersion and ackVersion are required" }),
        { status: 400, headers: corsHeaders },
      );
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

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const ipAddress =
      (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() ||
      req.headers.get("cf-connecting-ip") ||
      null;

    const { error } = await adminClient.from("terms_acceptances").insert({
      user_id: user.id,
      email: user.email ?? null,
      terms_version: termsVersion,
      privacy_version: privacyVersion,
      ack_version: ackVersion,
      ip_address: ipAddress,
      user_agent: req.headers.get("user-agent"),
      source: "reacceptance",
    });
    if (error) throw error;

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "unknown error" }),
      { status: 500, headers: corsHeaders },
    );
  }
});
