// Deploy via CLI: `supabase functions deploy route-intent`.
// Requires the GEMINI_API_KEY secret (shared with classify-document/ask-about-document).
//
// No Supabase auth — this is a guest-accessible homepage feature, same known-risk
// pattern already accepted for classify-document (rate-limited free API, no per-user
// state at stake).
import { GEMINI_MODEL_FAST, geminiUrl } from "../_shared/gemini.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

// Fixed allow-list of real destinations. The model must pick one of these paths —
// never invent a page that doesn't exist (e.g. no fake "deadline checker" route).
//
// Deliberately excludes /property-protest, /bpp-rendition, /tax-payment: those are
// static marketing pages whose own CTAs just link back to "/" to start a review —
// functional dead-ends. Routing the assistant there instead of straight to /intake
// would just add an extra click with no new capability, so every actionable intent
// (protest, BPP, deadlines, EPIN, tax value/payment questions) points at /intake.
const DESTINATIONS = [
  {
    path: "/intake",
    about:
      "Start a property review: upload a Texas appraisal notice or enter a property address. " +
      "This is the right destination for essentially every property-tax action today — " +
      "protesting an overvaluation, filing a BPP rendition, checking a deadline, retrieving " +
      "an EPIN, or checking what's owed — since uploading a notice or entering an address is " +
      "the real way AI extracts and acts on all of those.",
  },
  { path: "/pricing", about: "See CorvusPT's pricing plans." },
  { path: "/sign-in", about: "Sign in or create an account." },
  {
    path: "/contact",
    about: "Talk to a human at CorvusPT — the fallback for anything else.",
  },
] as const;

const ALLOWED_PATHS = new Set(DESTINATIONS.map((d) => d.path));

const SYSTEM = `You are CorvusPT's homepage assistant for Texas commercial property tax questions.
Given a short user query, pick the single best destination from this fixed list — never invent a
destination outside it — and write a short, friendly one-sentence response explaining why:

${DESTINATIONS.map((d) => `${d.path}: ${d.about}`).join("\n")}

If nothing fits well, use /contact. Return ONLY a JSON object: {"destination":"...","message":"..."}`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { query } = await req.json();
    if (!query || typeof query !== "string") {
      return new Response(JSON.stringify({ error: "query is required" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

    const body = {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: query }] }],
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
    let parsed: { destination?: string; message?: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : {};
    }

    const destination =
      parsed.destination &&
      ALLOWED_PATHS.has(parsed.destination as (typeof DESTINATIONS)[number]["path"])
        ? parsed.destination
        : "/contact";
    const message = parsed.message ?? "Here's where I'd start.";

    return new Response(JSON.stringify({ destination, message }), {
      status: 200,
      headers: corsHeaders,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "unknown error" }),
      { status: 500, headers: corsHeaders },
    );
  }
});
