// Deploy via CLI: `supabase functions deploy map-import-columns`.
// Requires the GEMINI_API_KEY secret (shared with the other AI functions).
//
// Bulk Property Upload — maps a spreadsheet's own column headers onto our
// property fields. Text only, no file. The client sends ONLY the headers its
// deterministic alias pass couldn't place, plus a few sample rows for
// context. Never invents a header; the field is clamped to our enum here and
// again on the client.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

const FIELDS = [
  "address",
  "cad",
  "accountNumber",
  "ownerName",
  "propertyType",
  "landValue",
  "improvementValue",
  "totalValue",
  "taxYear",
  "ignore",
];

const SYSTEM = `You map spreadsheet column headers onto a fixed set of property-record fields for a Texas property-tax platform.

The target fields:
- address — the property's street address (a.k.a. situs / location / property address)
- cad — the county or county appraisal district name
- accountNumber — the CAD account / parcel / property id number
- ownerName — the owner or business name on the county record
- propertyType — commercial / residential / land / etc.
- landValue — assessed land value (dollars)
- improvementValue — assessed improvement / building value (dollars)
- totalValue — total assessed / market / notice value (dollars)
- taxYear — the tax year (a 4-digit year)
- ignore — this column is not one of the above

For each header given, pick the single best field. Use the sample values to disambiguate (e.g. a column of dollar amounts labelled "2026 Value" is totalValue; a column of 4-digit years is taxYear). If a header clearly matches none, use "ignore". Never output a header that was not given.

Return ONLY a JSON object: {"mapping": [{"header": "<verbatim header>", "field": "<one of the fields above>", "confidence": <integer 0-100>}], "notes": "<one short sentence on anything ambiguous, or empty string>"}`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { headers, sampleRows } = (await req.json()) as {
      headers?: unknown;
      sampleRows?: unknown;
    };
    const headerList = Array.isArray(headers)
      ? headers.filter((h): h is string => typeof h === "string").slice(0, 60)
      : [];
    if (headerList.length === 0) {
      return new Response(JSON.stringify({ mapping: [], notes: "" }), {
        status: 200,
        headers: corsHeaders,
      });
    }
    const rows = Array.isArray(sampleRows)
      ? sampleRows
          .filter((r): r is unknown[] => Array.isArray(r))
          .slice(0, 5)
          .map((r) => r.map((c) => String(c ?? "").slice(0, 80)))
      : [];

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

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

    const prompt =
      `Headers to map:\n${headerList.map((h, i) => `${i + 1}. ${h}`).join("\n")}\n\n` +
      `Sample rows (each row's cells in header order):\n${
        rows.length ? rows.map((r) => r.join(" | ")).join("\n") : "(none)"
      }`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0 },
        }),
      },
    );
    if (!res.ok) {
      const t = await res.text();
      if (res.status === 429) {
        return new Response(
          JSON.stringify({ error: "AI is rate-limited. Please retry in a moment." }),
          { status: 429, headers: corsHeaders },
        );
      }
      throw new Error(`Gemini API error ${res.status}: ${t.slice(0, 200)}`);
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

    const sent = new Set(headerList);
    const allowed = new Set(FIELDS);
    const mapping = Array.isArray(parsed.mapping)
      ? parsed.mapping
          .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
          .map((x) => ({
            header: typeof x.header === "string" ? x.header : "",
            field: typeof x.field === "string" ? x.field : "ignore",
            confidence: Math.max(0, Math.min(100, Math.round(Number(x.confidence)) || 0)),
          }))
          .filter((x) => sent.has(x.header) && allowed.has(x.field))
      : [];

    return new Response(
      JSON.stringify({
        mapping,
        notes: typeof parsed.notes === "string" ? parsed.notes.slice(0, 300) : "",
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
