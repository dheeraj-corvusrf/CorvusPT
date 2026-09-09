// Deploy via CLI: `supabase functions deploy market-listings --no-verify-jwt`.
// Requires the GEMINI_API_KEY secret (shared with the other AI functions).
//
// Phase 2 of Module 3 (Market Value) — see the plan file this was built from
// (synchronous-painting-sky.md) for the full context: Texas is a non-
// disclosure state, so no sale price exists anywhere; Phase 1 (already
// shipped) uses real CAD-assessed-value comps. This function is the
// deliberately separate, clearly-labeled "listing" track — real estate
// listings (asking prices, not sale prices, not market value) found via
// Gemini's own live Google Search grounding tool, NOT scraping LoopNet/
// Crexi directly (which would risk the same Cloudflare/ToS blocks that
// already shut out Collin/Harris CAD this session).
//
// No Supabase auth check — same known-risk pattern already accepted for the
// other guest-accessible AI functions.
//
// STATUS (validation spike, 2026-09-01): NOT working, NOT wired into the
// client. Every real call with `tools: [{ google_search: {} }] }]` hangs
// and never returns — confirmed with 5 real attempts up to 70s each,
// including the absolute simplest possible request (a bare "what's today's
// headline" prompt, no system instruction, no JSON mode, no property-
// specific content) — same result every time, zero variance. This is a
// different failure mode than the real-but-intermittent Gemini congestion
// seen elsewhere in this app (those calls do eventually succeed some
// fraction of the time); a 100%-of-5 hang on the minimal case points to
// Search grounding not being enabled/available for this API key or this
// model right now, not "the model is just slow." Left deployed (harmless —
// nothing calls it) in case it starts working once grounding is enabled on
// the Google Cloud Console side; do not wire this into the client or trust
// its output until a real call actually succeeds.
import { GEMINI_MODEL_FAST, geminiUrl } from "../_shared/gemini.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

type MarketListingsInput = {
  address?: string;
  propertyType?: string;
};

const SYSTEM = `You are CorvusPT's Texas commercial real estate research assistant. Using live web
search, find REAL, currently-active commercial property listings for sale or lease near the given
address, similar in type/use.

Critical rules:
- Every listing must be REAL — a real address, a real listing price, from a real, currently
  findable web page (LoopNet, Crexi, a brokerage site, etc.). NEVER invent a listing, price, or
  address that isn't backed by an actual search result you found.
- This is a LISTING (asking price), never a "sale." Do not use the words "sold," "sale price," or
  "transaction" anywhere.
- If you cannot find any real, relevant listings, return an empty listings array — do not force a
  result.
- Be precise and concise: short, direct phrases, no filler.

Return ONLY a JSON object with exactly this shape:
{"listings": [{"address": "<real address from the listing>", "askingPrice": <number, USD, null if
not stated>, "listingType": "<one of: For Sale | For Lease | Unknown>", "propertyType": "<short
real description from the listing, or null>", "sourceUrl": "<the real page URL you found this
on>", "sourceName": "<e.g. LoopNet, Crexi, a brokerage name>"}, ...] (up to 5, empty array if none
found)}`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const input = (await req.json()) as MarketListingsInput;
    if (!input.address) {
      return new Response(JSON.stringify({ error: "address is required" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

    const query = `Find real active commercial property listings for sale or lease near ${input.address}${input.propertyType ? `, similar to a ${input.propertyType} property` : ""}.`;

    const body = {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: query }] }],
      tools: [{ google_search: {} }],
      generationConfig: { responseMimeType: "application/json" },
    };

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 20_000);
    let res: Response;
    try {
      res = await fetch(geminiUrl(GEMINI_MODEL_FAST, apiKey), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return new Response(JSON.stringify({ error: "AI response timed out. Please try again." }), {
          status: 504,
          headers: corsHeaders,
        });
      }
      throw err;
    } finally {
      clearTimeout(t);
    }

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 429) {
        return new Response(
          JSON.stringify({ error: "AI is rate-limited. Please retry in a moment." }),
          { status: 429, headers: corsHeaders },
        );
      }
      throw new Error(`Gemini API error ${res.status}: ${text.slice(0, 400)}`);
    }

    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const raw = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : {};
    }

    return new Response(JSON.stringify({ listings: parsed.listings ?? [] }), {
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
