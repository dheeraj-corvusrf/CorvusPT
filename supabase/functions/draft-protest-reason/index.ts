// Deploy via CLI: `supabase functions deploy draft-protest-reason`.
// Requires the GEMINI_API_KEY secret (shared with classify-document,
// ask-about-document).
//
// Reads the user's own uploaded evidence documents (rent roll, appraisal
// report, comps, photos, etc.) and produces a real, structured AI analysis:
// what each document actually shows (and whether it looks like real
// supporting evidence at all — flagging an obvious mismatch, like a signed
// form uploaded where evidence was expected), an overall summary of what
// the evidence supports, and a suggested paragraph for Form 50-132's
// "Facts that may help resolve this protest" field. Same real Gemini
// multimodal pattern as classify-document (inline_data per file,
// temperature 0, forced JSON), but every field here is something the
// customer reviews — never inserted or submitted automatically. Two real
// callers: PdfFormEditor.tsx's "Generate Suggested Reason" button (reads
// only suggestedReason) and ai-report.tsx's Module 8 "Analyze My Evidence"
// (reads the full analysis).
import { PROSE_STYLE } from "../_shared/prose-style.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

const MAX_DOCS = 5;

// Assigned per document — never includes "Duplicate": that's a byte-for-byte
// hash match, detected deterministically client-side (see hashEvidenceDocuments
// in src/lib/protest-reason.ts) before this function is ever called, so the AI
// is only ever asked to judge documents that are already known to be distinct.
const DOCUMENT_STATUSES = [
  "Accepted",
  "Needs Review",
  "Incorrect Document",
  "Additional Information Needed",
] as const;
type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

const SYSTEM = `You are CorvusPT's Texas property tax protest assistant. The user has uploaded evidence documents (e.g. a rent roll, an independent appraisal, comparable sales/equity data, a property condition assessment, photos of damage) for a property they are protesting the appraised value of. Analyze the real, actual content of each document and produce a structured analysis.

Rules:
- Base every claim ONLY on what is actually visible in the case data and the uploaded documents. Never invent a number, date, or fact that isn't actually there.
- Assign every document exactly one status:
  - "Accepted": clearly real, legible, on-topic evidence that supports a value/condition argument for this property.
  - "Needs Review": on-topic evidence, but low quality, ambiguous, or missing something (unclear scan, cut-off page, unclear date) — usable, but the property owner should look it over before submitting.
  - "Incorrect Document": doesn't look like protest evidence at all for this property (e.g. a signed form, an unrelated file, a document for a different property, no bearing on value/condition).
  - "Additional Information Needed": genuine, on-topic evidence, but incomplete on its own — supports the case only if paired with something the owner hasn't provided yet (e.g. one month of a rent roll with no full-year data, a repair estimate with no photos of the actual damage).
- If a document is unclear, low quality, or doesn't obviously support a value argument, say so plainly in its assessment rather than guessing what it might show.
- If a document doesn't look like real property-tax-protest evidence at all, say so directly in its assessment — do not force it into a supportive-sounding assessment it doesn't earn.
- documentFindings must have exactly one entry per document provided, in the same order, using the exact fileName given for each.
- summary: 2-4 sentences synthesizing what the evidence collectively shows and how strongly it supports a value reduction. If the evidence overall is weak or off-topic, say that plainly instead of writing generic filler.
- suggestedReason: a single paragraph suitable for the "Facts that may help resolve this protest" field on Texas Comptroller Form 50-132, written in the voice of the property owner ("The property's..." / "Comparable properties..."), not as an AI describing the documents. If none of the documents provide anything usable for this field, say so plainly instead of manufacturing filler.
- Plain prose only in every field — no markdown, no bullet points, no headers.
- Every field here is a SUGGESTION the property owner will review and can edit — do not claim certainty beyond what the documents actually show.
- Return ONLY a JSON object matching this exact shape: {"documentFindings":[{"fileName":"...","status":"<one of: Accepted | Needs Review | Incorrect Document | Additional Information Needed>","assessment":"..."}],"summary":"...","suggestedReason":"..."}

${PROSE_STYLE}`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { property, documents } = await req.json();
    if (!Array.isArray(documents) || documents.length === 0) {
      return new Response(JSON.stringify({ error: "At least one document is required." }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

    const contextLines = [
      property?.address ? `Property address: ${property.address}` : null,
      property?.cad ? `Appraisal district: ${property.cad}` : null,
      property?.taxYear ? `Tax year: ${property.taxYear}` : null,
      property?.totalValue ? `Current assessed value: $${property.totalValue}` : null,
      property?.strategyRecommendation
        ? `Case strategy on file: ${property.strategyRecommendation}`
        : null,
    ].filter(Boolean);

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
        text: `Case context:\n${contextLines.length > 0 ? contextLines.join("\n") : "(none on file)"}\n\nDocuments provided, in order:\n${fileList}\n\nAnalyze each document below (in the same order listed above) and produce the full JSON response.`,
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

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );

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
    let parsed: {
      documentFindings?: Array<{ fileName?: string; status?: string; assessment?: string }>;
      summary?: string;
      suggestedReason?: string;
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : {};
    }

    const result = {
      documentFindings: Array.isArray(parsed.documentFindings)
        ? parsed.documentFindings.map((f, i) => ({
            fileName: f.fileName ?? usableDocs[i]?.fileName ?? `Document ${i + 1}`,
            // "Needs Review" is the safe default when the AI omits/invents a
            // status — never silently defaults to "Accepted", which would
            // let an ungraded document slip into the evidence packet as if
            // it had been checked.
            status: (DOCUMENT_STATUSES as readonly string[]).includes(f.status ?? "")
              ? (f.status as DocumentStatus)
              : "Needs Review",
            assessment: f.assessment ?? "",
          }))
        : [],
      summary: parsed.summary ?? "",
      suggestedReason: parsed.suggestedReason ?? "",
      // Kept alongside suggestedReason for the existing File Protest
      // caller (PdfFormEditor.tsx), which only ever reads this field —
      // never remove without updating that caller too.
      text: parsed.suggestedReason ?? "",
    };

    return new Response(JSON.stringify(result), { status: 200, headers: corsHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "unknown error" }),
      { status: 500, headers: corsHeaders },
    );
  }
});
