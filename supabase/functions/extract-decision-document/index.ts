// Deploy via CLI: `supabase functions deploy extract-decision-document`.
// Requires the GEMINI_API_KEY secret (shared with the other AI functions).
//
// Reads a real document the user (or staff) uploaded showing a final or
// proposed value outcome — an ARB Order, hearing decision, settlement, a
// revised value notice, a county decision, or a settlement offer awaiting
// signature — and extracts exactly what it says. Same discipline as
// extract-hearing-notice/index.ts:
// 1. Discrepancies against the case's own known facts are computed HERE,
//    deterministically, after parsing — never the model's own say-so.
// 2. documentCategory is hard-clamped to a fixed enum.
// Shared by two real callers with different downstream uses (see
// decision-notice.ts and settlement-agreement.ts): a post-hearing
// decision record, and a pending settlement offer awaiting the user's
// signature. Both need the same real facts off the same kind of document,
// so this is one function, not two.
import { GEMINI_MODEL_FAST, geminiUrl } from "../_shared/gemini.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

const MAX_DOCS = 3;

const CATEGORIES = [
  "ARB Order",
  "Hearing Decision",
  "Settlement",
  "Revised Value Notice",
  "County Decision",
  "Other",
] as const;

const SYSTEM = `You are CorvusPT's Texas property tax protest assistant. The user has uploaded a real document from their county or Appraisal Review Board (ARB) showing a value outcome — this could be a final ARB Order, a hearing decision, a settlement agreement, a revised value notice, another county decision, or a settlement offer they're about to sign. Read the document's REAL, actual content and extract exactly what it says — never invent a number, date, or term that isn't actually printed on it.

Rules:
- Every field is null when the document genuinely doesn't state it — never guess or fill in a typical value.
- documentCategory: one of "ARB Order", "Hearing Decision", "Settlement", "Revised Value Notice", "County Decision", "Other" — based on what kind of document this actually is.
- originalValue: the value BEFORE this outcome (the county's prior/noticed assessed value), if stated.
- finalValue: the value this document actually settles/decides/proposes (the new value), if stated.
- decisionDate: as printed, in MM/DD/YYYY if a real date is given.
- settlementTerms: 1-3 sentences summarizing any real stated terms/conditions of the agreement or decision — "Not specified" if none are stated.
- refundIndicator: a short real statement of what the document says about a refund (e.g. "Refund of $X stated" or "No refund mentioned") — null if refunds aren't mentioned at all.
- otherConditions: any other real condition stated (e.g. required future actions, expiration) — null if none.
- Plain prose only in free-text fields — no markdown.
- Return ONLY a JSON object matching this exact shape: {"documentCategory":"<one of: ARB Order | Hearing Decision | Settlement | Revised Value Notice | County Decision | Other>","originalValue":<number|null>,"finalValue":<number|null>,"decisionDate":<string|null>,"taxYear":<string|null>,"accountNumber":<string|null>,"propertyAddress":<string|null>,"settlementTerms":<string|null>,"appealDeadline":<string|null>,"refundIndicator":<string|null>,"otherConditions":<string|null>}`;

function normalize(v: string | null | undefined): string {
  return (v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { caseContext, documents } = await req.json();
    if (!Array.isArray(documents) || documents.length === 0) {
      return new Response(JSON.stringify({ error: "At least one document is required." }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

    const contextLines = [
      caseContext?.address ? `Property address on file: ${caseContext.address}` : null,
      caseContext?.cad ? `Appraisal district: ${caseContext.cad}` : null,
      caseContext?.accountNumber ? `Account number on file: ${caseContext.accountNumber}` : null,
      caseContext?.taxYear ? `Tax year on file: ${caseContext.taxYear}` : null,
      caseContext?.originalValue != null
        ? `Original assessed value on file: $${caseContext.originalValue}`
        : null,
    ].filter(Boolean);

    const usableDocs = documents
      .slice(0, MAX_DOCS)
      .filter((doc: { dataUrl?: string }) => String(doc.dataUrl ?? "").includes(","));
    if (usableDocs.length === 0) {
      return new Response(JSON.stringify({ error: "Could not read the uploaded file." }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> = [
      {
        text: `Case context (real, already on file — use only to spot discrepancies, never as the source of the extracted fields themselves, which must come only from the document):\n${contextLines.length > 0 ? contextLines.join("\n") : "(none on file)"}\n\nExtract the real content of the attached document and produce the full JSON response.`,
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
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : {};
    }

    const str = (v: unknown, len: number): string | null => {
      const s = typeof v === "string" ? v.trim() : "";
      return s ? s.slice(0, len) : null;
    };
    const num = (v: unknown): number | null => {
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const documentCategory = (CATEGORIES as readonly string[]).includes(
      parsed.documentCategory as string,
    )
      ? (parsed.documentCategory as (typeof CATEGORIES)[number])
      : "Other";

    const extraction = {
      documentCategory,
      originalValue: num(parsed.originalValue),
      finalValue: num(parsed.finalValue),
      decisionDate: str(parsed.decisionDate, 20),
      taxYear: str(parsed.taxYear, 10),
      accountNumber: str(parsed.accountNumber, 40),
      propertyAddress: str(parsed.propertyAddress, 200),
      settlementTerms: str(parsed.settlementTerms, 500) ?? "Not specified.",
      appealDeadline: str(parsed.appealDeadline, 20),
      refundIndicator: str(parsed.refundIndicator, 200),
      otherConditions: str(parsed.otherConditions, 300),
    };

    // Real, deterministic comparison against the case's own known facts —
    // never trusting the model's own say-so on whether something matches.
    const discrepancies: string[] = [];
    if (
      extraction.accountNumber &&
      caseContext?.accountNumber &&
      normalize(extraction.accountNumber) !== normalize(caseContext.accountNumber)
    ) {
      discrepancies.push(
        `Account number on this document (${extraction.accountNumber}) doesn't match the account number on file (${caseContext.accountNumber}).`,
      );
    }
    if (
      extraction.taxYear &&
      caseContext?.taxYear &&
      String(extraction.taxYear).trim() !== String(caseContext.taxYear).trim()
    ) {
      discrepancies.push(
        `Tax year on this document (${extraction.taxYear}) doesn't match the tax year on file (${caseContext.taxYear}).`,
      );
    }
    if (extraction.propertyAddress && caseContext?.address) {
      const a = normalize(extraction.propertyAddress);
      const b = normalize(caseContext.address);
      if (!a.includes(b.slice(0, 12)) && !b.includes(a.slice(0, 12))) {
        discrepancies.push(
          `Property address on this document ("${extraction.propertyAddress}") doesn't clearly match the address on file ("${caseContext.address}").`,
        );
      }
    }
    if (
      extraction.originalValue != null &&
      caseContext?.originalValue != null &&
      Math.abs(extraction.originalValue - caseContext.originalValue) > 1
    ) {
      discrepancies.push(
        `Original value on this document ($${extraction.originalValue.toLocaleString()}) doesn't match the original value on file ($${Number(caseContext.originalValue).toLocaleString()}).`,
      );
    }

    return new Response(JSON.stringify({ ...extraction, discrepancies }), {
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
