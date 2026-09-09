// Deploy via CLI: `supabase functions deploy admin-case-summary`.
// Requires GEMINI_API_KEY (shared with the other AI functions) plus the
// auto-injected SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY.
//
// Unlike every other AI function in this app (classify-document, route-intent,
// ask-about-document, ai-health-score, ai-report-modules — all guest-accessible),
// this one is staff-only: it summarizes internal case data (notes, requester
// email, document list), so it's gated the same way admin-create-user /
// admin-delete-user are.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GEMINI_MODEL_FAST, geminiUrl } from "../_shared/gemini.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { propertyContext, protestContext, documentsContext } = await req.json();
    if (!propertyContext || !protestContext) {
      return new Response(
        JSON.stringify({ error: "propertyContext and protestContext are required" }),
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
    const { data: profile } = await adminClient
      .from("profiles")
      .select("is_admin")
      .eq("id", user.id)
      .single();
    if (!profile?.is_admin) {
      return new Response(JSON.stringify({ error: "not authorized" }), {
        status: 403,
        headers: corsHeaders,
      });
    }

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

    const body = {
      systemInstruction: {
        parts: [
          {
            text: 'You are an internal assistant for CorvusPT\'s property tax protest staff. Given a case\'s property details, protest status/notes, and uploaded document list, respond with JSON only: {"summary": one or two staff-facing sentences on where this case stands, "nextAction": a short imperative sentence on what staff should do next, "evidenceGaps": an array of short strings naming anything that looks missing or insufficient given the current status (empty array if nothing stands out)}. Be concrete and brief. Do not invent facts not present in the given context.',
          },
        ],
      },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Property:\n${propertyContext}\n\nProtest:\n${protestContext}\n\nDocuments on file:\n${documentsContext ?? "(none)"}`,
            },
          ],
        },
      ],
      generationConfig: { responseMimeType: "application/json" },
    };

    const res = await fetch(geminiUrl(GEMINI_MODEL_FAST, apiKey), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 429) {
        return new Response(
          JSON.stringify({ error: "AI is rate-limited. Please retry in a moment." }),
          { status: 429, headers: corsHeaders },
        );
      }
      throw new Error(`Gemini API error ${res.status}: ${text.slice(0, 200)}`);
    }

    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const raw = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";

    let parsed: { summary?: string; nextAction?: string; evidenceGaps?: string[] } = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      // fall through to defaults below
    }

    return new Response(
      JSON.stringify({
        summary: parsed.summary ?? "No summary available.",
        nextAction: parsed.nextAction ?? "",
        evidenceGaps: Array.isArray(parsed.evidenceGaps) ? parsed.evidenceGaps : [],
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
