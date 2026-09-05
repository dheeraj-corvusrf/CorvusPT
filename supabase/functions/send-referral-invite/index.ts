// Deploy via CLI: `supabase functions deploy send-referral-invite`. Requires
// the RESEND_API_KEY secret (shared with send-signup-invite).
//
// Any signed-in user can send one of these (not admin-only, unlike
// send-signup-invite) — this is the real "email a friend" action on
// /dashboard/referrals. The referrer's own name and referral code are
// resolved SERVER-SIDE from their own authenticated profile row, never
// trusted from the client — a client can only ever send an invite carrying
// their OWN real referral link, never someone else's (which a client-
// supplied code/name would otherwise let them spoof).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

function emailHtml(referrerName: string, referralUrl: string): string {
  const intro = referrerName
    ? `${referrerName} thinks CorvusPT could help you lower your property taxes — and referred you directly.`
    : `A friend thinks CorvusPT could help you lower your property taxes — and referred you directly.`;
  return `<!doctype html>
<html>
  <body style="margin:0; padding:0; background-color:#eef2f4; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#eef2f4; padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background-color:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 2px 12px rgba(22,35,58,0.08);">
            <tr>
              <td style="background-color:#16233a; background-image:linear-gradient(135deg,#16233a 0%,#1d3b5c 55%,#0f9e6e 100%); padding:36px 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="width:44px; height:44px;">
                      <img src="https://raw.githubusercontent.com/dheeraj-corvusrf/CorvusRF/feature-dev-dheeraj/public/email/corvuspt-logo-badge.png" width="44" height="44" alt="CorvusPT" style="display:block; border-radius:10px;" />
                    </td>
                    <td style="padding-left:12px; vertical-align:middle;">
                      <span style="font-size:22px; font-weight:700; color:#ffffff; letter-spacing:-0.3px;">Corvus<span style="color:#5eead4;">PT</span></span><br />
                      <span style="font-size:12px; color:#b7c4d6; letter-spacing:0.4px; text-transform:uppercase;">AI-Powered Texas Property Tax</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:36px 32px 8px 32px;">
                <p style="margin:0 0 4px 0; font-size:13px; font-weight:700; letter-spacing:1px; text-transform:uppercase; color:#0f9e6e;">You were referred</p>
                <h1 style="margin:0 0 16px 0; font-size:26px; line-height:1.3; color:#16233a;">${referrerName ? `${referrerName} sent you to CorvusPT` : "You've been invited to CorvusPT"}</h1>
                <p style="margin:0 0 20px 0; font-size:15px; line-height:1.65; color:#42506a;">
                  ${intro} CorvusPT reads your county's real appraisal data, checks it against
                  comparable properties, and tells you — in plain language — whether you're
                  overpaying and what to do about it.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:4px 32px 28px 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td width="50%" style="padding:6px 6px 6px 0; vertical-align:top;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#ecfdf5; border-radius:10px;">
                        <tr><td style="padding:14px 16px;">
                          <span style="font-size:18px;">🔍</span>
                          <p style="margin:6px 0 0 0; font-size:13.5px; font-weight:600; color:#0f6b4f;">AI Value &amp; Protest Check</p>
                          <p style="margin:2px 0 0 0; font-size:12.5px; color:#4c6f61;">Flags overassessment and your real savings opportunity.</p>
                        </td></tr>
                      </table>
                    </td>
                    <td width="50%" style="padding:6px 0 6px 6px; vertical-align:top;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#eef4ff; border-radius:10px;">
                        <tr><td style="padding:14px 16px;">
                          <span style="font-size:18px;">📄</span>
                          <p style="margin:6px 0 0 0; font-size:13.5px; font-weight:600; color:#26467a;">Evidence &amp; Filing, Guided</p>
                          <p style="margin:2px 0 0 0; font-size:12.5px; color:#4c5f7a;">AI reads your evidence, drafts your protest, guides filing.</p>
                        </td></tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td width="50%" style="padding:6px 6px 0 0; vertical-align:top;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#fff7ed; border-radius:10px;">
                        <tr><td style="padding:14px 16px;">
                          <span style="font-size:18px;">💰</span>
                          <p style="margin:6px 0 0 0; font-size:13.5px; font-weight:600; color:#9a4a12;">Payments &amp; Refunds</p>
                          <p style="margin:2px 0 0 0; font-size:12.5px; color:#6d5138;">Track deadlines, dues, and savings in one dashboard.</p>
                        </td></tr>
                      </table>
                    </td>
                    <td width="50%" style="padding:6px 0 0 6px; vertical-align:top;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#fdf2f8; border-radius:10px;">
                        <tr><td style="padding:14px 16px;">
                          <span style="font-size:18px;">🗂️</span>
                          <p style="margin:6px 0 0 0; font-size:13.5px; font-weight:600; color:#9d2c6a;">BPP Rendition</p>
                          <p style="margin:2px 0 0 0; font-size:12.5px; color:#75425f;">Business personal property, handled the same easy way.</p>
                        </td></tr>
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:4px 32px 36px 32px;" align="center">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="background-color:#0f9e6e; border-radius:10px;">
                      <a href="${referralUrl}" style="display:inline-block; padding:14px 36px; font-size:15px; font-weight:700; color:#ffffff; text-decoration:none;">
                        Get Your Free AI Property Review
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:14px 0 0 0; font-size:12px; color:#8592a6;">No card required to start — free to review, pay only when you're ready to move forward.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px; background-color:#f6f8fa; border-top:1px solid #e7ecf1;">
                <p style="margin:0; font-size:12px; line-height:1.6; color:#8592a6;">
                  ${referrerName ? `${referrerName} shared this link from their own CorvusPT account.` : "Someone shared this link from their own CorvusPT account."}
                  No account has been created for you — nothing exists until you actually finish
                  signing up. If you weren't expecting this, you can safely ignore this email.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { toEmail, origin } = await req.json();
    if (typeof toEmail !== "string" || !toEmail.includes("@")) {
      return new Response(JSON.stringify({ error: "A valid email address is required." }), {
        status: 400,
        headers: corsHeaders,
      });
    }
    // origin is the caller's full origin+base prefix — e.g.
    // "https://corvusre.com/corvuspt/" (window.location.origin +
    // import.meta.env.BASE_URL from the client; see sendReferralInvite in
    // src/lib/referrals.ts) — same convention create-checkout-session's own
    // successPath/cancelPath already use. Only ever used as a URL prefix
    // below; the real security boundary is the referral CODE, always
    // resolved server-side from the caller's own row, never taken from the
    // client. Falls back to the real production URL, not a placeholder —
    // this app has no server, so a wrong fallback here would silently ship
    // a dead link in any request that omits it.
    const safeOrigin = (() => {
      const fallback = "https://corvusre.com/corvuspt/";
      if (typeof origin !== "string" || !/^https?:\/\/[^/\s]+(\/[^\s]*)?$/.test(origin)) {
        return fallback;
      }
      return origin.endsWith("/") ? origin : `${origin}/`;
    })();

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
      .select("first_name, referral_code")
      .eq("id", user.id)
      .maybeSingle();
    if (!profile?.referral_code) {
      throw new Error("Could not find your referral code — please try again shortly.");
    }

    // A clean path, not a "?" query string — see buildReferralLink's own
    // comment in src/lib/referrals.ts for why, and for how hub/404.html
    // forwards this exact shape into the real /join?ref=... page since this
    // is a static site with no server to make /join/CODE a real route.
    const referralUrl = `${safeOrigin}join/${encodeURIComponent(profile.referral_code)}`;
    const referrerName = (profile.first_name as string | null)?.trim() || "";

    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (!resendKey) throw new Error("Missing RESEND_API_KEY");

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "CorvusPT <info@corvusre.com>",
        to: toEmail,
        subject: referrerName
          ? `${referrerName} thinks CorvusPT can help you save on property taxes`
          : "You've been referred to CorvusPT",
        html: emailHtml(referrerName, referralUrl),
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Resend error ${res.status}: ${text.slice(0, 300)}`);
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "unknown error" }),
      { status: 500, headers: corsHeaders },
    );
  }
});
