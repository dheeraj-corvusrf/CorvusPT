// Deploy via CLI: `supabase functions deploy classify-document`.
// Requires the GEMINI_API_KEY secret: `supabase secrets set GEMINI_API_KEY=<key>`
// (free tier key from https://aistudio.google.com — no card required).
//
// No Supabase auth check here — this runs during the guest intake flow, before
// sign-in, matching the app's existing "before you even sign in" design. Known
// tradeoff: an unauthenticated endpoint calling a rate-limited free API could be
// abused for quota exhaustion; the client already caps uploads at 15MB.
import { GEMINI_MODEL_FAST, geminiUrl } from "../_shared/gemini.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  // Without this, supabase-js's functions.invoke() parses the body as plain text
  // (a JSON string) instead of a parsed object, based on the response Content-Type.
  "Content-Type": "application/json",
};

type DocumentType =
  | "Real Property Appraisal Notice"
  | "BPP Rendition Form"
  | "BPP Appraisal Notice"
  | "Tax Bill / Statement"
  | "Hearing Notice / ARB"
  | "Refund Notice"
  | "EPIN / PIN Notice"
  | "Exemption Notice"
  | "Other";

type Extraction = {
  documentType: DocumentType;
  ownerName: string | null;
  propertyName: string | null;
  propertyAddress: string | null;
  situsAddress: string | null;
  county: string | null;
  cadName: string | null;
  accountNumber: string | null;
  parcelId: string | null;
  taxYear: number | null;
  noticeValue: number | null;
  landValue: number | null;
  improvementValue: number | null;
  bppValue: number | null;
  priorValue: number | null;
  noticeDate: string | null;
  mailDate: string | null;
  protestDeadline: string | null;
  hearingDate: string | null;
  hearingTime: string | null;
  hearingInstructions: string | null;
  paymentDueDate: string | null;
  taxAmountDue: number | null;
  taxableValue: number | null;
  taxRate: number | null;
  penaltyDate: string | null;
  refundAmount: number | null;
  pinOrEpin: string | null;
  exemptions: string[] | null;
  confidence: number;
  reasoning: string | null;
};

const SYSTEM = `You are a Texas property tax document classifier. The user uploads one document image or PDF page from a Texas County Appraisal District (CAD) or tax office. Extract fields precisely.

Rules:
- Never invent values. If a field is not clearly visible, return null.
- Money values are numbers (no commas, no $).
- Dates in ISO YYYY-MM-DD format, EXCEPT hearingTime which is a plain time string exactly as printed (e.g. "9:00 AM").
- hearingInstructions: if the document states how the hearing will be conducted, what documents/evidence to bring, any deadlines tied to the hearing, or other hearing-day instructions, copy that text VERBATIM (word-for-word, not summarized or reworded). If the document has no such instructions, return null.
- taxableValue is the value the tax rate was actually applied to on a "Tax Bill / Statement" (may differ from noticeValue due to exemptions) — null on other document types.
- taxRate is the combined/total tax rate shown on a tax bill, as a plain decimal (e.g. "2.1" for 2.1%, not 0.021) — null if not shown.
- penaltyDate is the date penalty/interest begins accruing on an unpaid bill, if shown — null otherwise.
- refundAmount is the dollar amount of a refund on a "Refund Notice" — null on other document types.
- documentType must be one of: "Real Property Appraisal Notice", "BPP Rendition Form", "BPP Appraisal Notice", "Tax Bill / Statement", "Hearing Notice / ARB", "Refund Notice", "EPIN / PIN Notice", "Exemption Notice", "Other".
- confidence is a single 0..1 score for the overall extraction quality (OCR clarity + completeness of key fields).
- This score gates whether the user can proceed — given the same document, always extract the same fields and report the same confidence, not a different read each time.
- Return ONLY a JSON object matching the schema. No prose.`;

const SCHEMA_HINT = `{"documentType":"...","ownerName":null,"propertyName":null,"propertyAddress":null,"situsAddress":null,"county":null,"cadName":null,"accountNumber":null,"parcelId":null,"taxYear":null,"noticeValue":null,"landValue":null,"improvementValue":null,"bppValue":null,"priorValue":null,"noticeDate":null,"mailDate":null,"protestDeadline":null,"hearingDate":null,"hearingTime":null,"hearingInstructions":null,"paymentDueDate":null,"taxAmountDue":null,"taxableValue":null,"taxRate":null,"penaltyDate":null,"refundAmount":null,"pinOrEpin":null,"exemptions":null,"confidence":0.0,"reasoning":null}`;

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

    // dataUrl looks like "data:application/pdf;base64,JVBERi0x..." — Gemini's
    // inline_data wants just the raw base64 payload, no prefix.
    const base64 = String(dataUrl).split(",", 2)[1] ?? "";

    const body = {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Classify and extract this Texas property tax document. Return JSON in this exact shape (nulls where unknown):\n${SCHEMA_HINT}`,
            },
            { inline_data: { mime_type: mimeType, data: base64 } },
          ],
        },
      ],
      // 0, not left at Gemini's default (~1) — this extraction directly
      // gates the "Confirm Details" button (via the confidence score below
      // LOW_CONFIDENCE_THRESHOLD) and feeds detectMismatch()'s comparison.
      // Confirmed live: re-uploading the exact same file could flip a
      // field between a real value and null, and the self-reported
      // confidence across the 0.6 threshold, between two calls — greedy
      // decoding removes sampling as a source of that variance (not a
      // guarantee of byte-identical output every time, but the same real
      // improvement already confirmed for ai-report-modules).
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
    let parsed: Partial<Extraction>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = m ? (JSON.parse(m[0]) as Partial<Extraction>) : {};
    }

    const extraction: Extraction = {
      documentType: (parsed.documentType as DocumentType) ?? "Other",
      ownerName: parsed.ownerName ?? null,
      propertyName: parsed.propertyName ?? null,
      propertyAddress: parsed.propertyAddress ?? null,
      situsAddress: parsed.situsAddress ?? null,
      county: parsed.county ?? null,
      cadName: parsed.cadName ?? null,
      accountNumber: parsed.accountNumber ?? null,
      parcelId: parsed.parcelId ?? null,
      taxYear: parsed.taxYear ?? null,
      noticeValue: parsed.noticeValue ?? null,
      landValue: parsed.landValue ?? null,
      improvementValue: parsed.improvementValue ?? null,
      bppValue: parsed.bppValue ?? null,
      priorValue: parsed.priorValue ?? null,
      noticeDate: parsed.noticeDate ?? null,
      mailDate: parsed.mailDate ?? null,
      protestDeadline: parsed.protestDeadline ?? null,
      hearingDate: parsed.hearingDate ?? null,
      hearingTime: parsed.hearingTime ?? null,
      hearingInstructions: parsed.hearingInstructions ?? null,
      paymentDueDate: parsed.paymentDueDate ?? null,
      taxAmountDue: parsed.taxAmountDue ?? null,
      taxableValue: parsed.taxableValue ?? null,
      taxRate: parsed.taxRate ?? null,
      penaltyDate: parsed.penaltyDate ?? null,
      refundAmount: parsed.refundAmount ?? null,
      pinOrEpin: parsed.pinOrEpin ?? null,
      exemptions: parsed.exemptions ?? null,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      reasoning: parsed.reasoning ?? null,
    };

    return new Response(JSON.stringify(extraction), { status: 200, headers: corsHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "unknown error" }),
      { status: 500, headers: corsHeaders },
    );
  }
});
