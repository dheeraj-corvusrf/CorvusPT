// Deploy via CLI: `supabase functions deploy validate-document`.
// Requires the GEMINI_API_KEY secret (shared with classify-document).
//
// Stage 1 of a two-stage upload pipeline: the client sends only page 1 of the
// upload here for a cheap yes/no check before running the full multi-field
// extraction (classify-document) across the entire document. Catches the wrong
// file (a photo of a pet, an unrelated PDF, a notice from outside Texas) fast,
// with a clear reason, instead of quietly wasting a full OCR pass and surfacing
// a confusing all-nulls confirm screen.
import { GEMINI_MODEL_FAST, geminiUrl } from "../_shared/gemini.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

const SYSTEM = `You are a fast pre-check for Texas property tax document uploads. You are given only the
first page of an uploaded file. Decide if this looks like a real Texas County Appraisal District (CAD)
or tax office document (an appraisal notice, tax bill/statement, BPP rendition, hearing/ARB notice,
refund notice, EPIN/PIN notice, or exemption notice) — not whether every field is extractable, just
whether the document type and source look right.

Return ONLY a JSON object: {"isValid":true|false,"cadName":"..."|null,"reason":"..."}
- cadName: the county appraisal district or tax office name if visible, else null.
- reason: one short sentence. If isValid is false, explain what the page actually looks like instead
  (e.g. "This looks like a personal photo, not a property tax document." or "This looks like an
  appraisal notice from outside Texas."). If isValid is true, briefly confirm what was recognized.`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { fileName, mimeType, dataUrl } = await req.json();
    if (!fileName || !mimeType || !dataUrl) {
      return new Response(
        JSON.stringify({ error: "fileName, mimeType, and dataUrl are required" }),
        { status: 400, headers: corsHeaders },
      );
    }

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

    const base64 = String(dataUrl).split(",", 2)[1] ?? "";

    const body = {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [
        {
          role: "user",
          parts: [
            { text: "Is this the first page of a valid Texas property tax document?" },
            { inline_data: { mime_type: mimeType, data: base64 } },
          ],
        },
      ],
      // 0, not left at Gemini's default — this gates whether classify-document
      // even runs; same rationale as classify-document's own temperature: 0.
      generationConfig: { responseMimeType: "application/json", temperature: 0 },
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
    let parsed: { isValid?: boolean; cadName?: string | null; reason?: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : {};
    }

    return new Response(
      JSON.stringify({
        isValid: parsed.isValid !== false,
        cadName: parsed.cadName ?? null,
        reason: parsed.reason ?? null,
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
