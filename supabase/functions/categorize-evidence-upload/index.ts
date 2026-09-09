// Deploy via CLI: `supabase functions deploy categorize-evidence-upload`.
// Requires the GEMINI_API_KEY secret (shared with the other AI functions).
//
// Module 8's bulk "Upload Evidence" button uploads files with no category
// chosen up front — this reads each file's real content and matches it
// against the property's own current evidence checklist (the exact real
// item strings from MODULE_SPECS.evidence, sent in on every call, never a
// fixed/invented taxonomy), so ai-report.tsx can tag the upload with the
// matching category automatically instead of leaving it uncategorized.
// Never invents a category outside the list it was given, and a document
// that doesn't clearly fit any of them comes back uncategorized rather than
// forced into the closest-sounding one.
import { GEMINI_MODEL_FAST, geminiUrl } from "../_shared/gemini.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

const MAX_DOCS = 8;

const SYSTEM = `You are CorvusPT's property tax protest assistant. The user just uploaded one or more evidence documents in bulk, and separately has a real evidence checklist for this property (a list of specific categories, given below). Look at each document's REAL, actual content and decide which ONE checklist item (if any) it best satisfies.

Rules:
- matchedItem must be either the EXACT text of one of the checklist items given below, copied verbatim, or null if the document doesn't clearly fit any of them. Never invent a category, never paraphrase a checklist item, never guess when it's genuinely unclear — null is the honest answer for an unrelated or ambiguous file.
- Base the match only on what's actually visible/legible in the document — a photo of a fence is "Site Photos..." only if that's genuinely a real checklist item and the photo genuinely shows what that item describes.
- findings must have exactly one entry per document provided, in the same order, using the exact fileName given for each.
- Return ONLY a JSON object matching this exact shape: {"findings":[{"fileName":"...","matchedItem":"<exact checklist item text, or null>"}]}`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { items, documents } = await req.json();
    if (!Array.isArray(items) || items.length === 0) {
      return new Response(JSON.stringify({ findings: [] }), { status: 200, headers: corsHeaders });
    }
    if (!Array.isArray(documents) || documents.length === 0) {
      return new Response(JSON.stringify({ error: "At least one document is required." }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

    const checklist: string[] = items.filter((x: unknown): x is string => typeof x === "string");
    const checklistText = checklist.map((it, i) => `${i + 1}. ${it}`).join("\n");

    const usableDocs = documents
      .slice(0, MAX_DOCS)
      .filter((doc: { dataUrl?: string }) => String(doc.dataUrl ?? "").includes(","));

    const fileList = usableDocs
      .map(
        (doc: { fileName?: string }, i: number) =>
          `${i + 1}. ${doc.fileName ?? `Document ${i + 1}`}`,
      )
      .join("\n");

    const parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> = [
      {
        text:
          `Evidence checklist for this property:\n${checklistText}\n\n` +
          `Documents provided, in order:\n${fileList}\n\n` +
          `Analyze each document below (in the same order listed above) and produce the full JSON response.`,
      },
    ];
    for (const doc of usableDocs) {
      const base64 = String(doc.dataUrl ?? "").split(",", 2)[1] ?? "";
      if (!base64) continue;
      parts.push({ inline_data: { mime_type: doc.mimeType, data: base64 } });
    }

    const body = {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts }],
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
    let parsed: { findings?: Array<{ fileName?: string; matchedItem?: string | null }> };
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : {};
    }

    // Hard-verified, not trusted from the model alone — matchedItem must be
    // an EXACT match against the real checklist this call was given, or the
    // upload gets left uncategorized rather than tagged with a category
    // that doesn't actually exist (a paraphrase, a typo, a fabricated one).
    const findings = Array.isArray(parsed.findings)
      ? parsed.findings.map((f, i) => {
          const matched = typeof f.matchedItem === "string" ? f.matchedItem : null;
          return {
            fileName: f.fileName ?? usableDocs[i]?.fileName ?? `Document ${i + 1}`,
            matchedItem: matched && checklist.includes(matched) ? matched : null,
          };
        })
      : [];

    return new Response(JSON.stringify({ findings }), { status: 200, headers: corsHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "unknown error" }),
      { status: 500, headers: corsHeaders },
    );
  }
});
