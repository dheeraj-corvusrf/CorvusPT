// Deploy via CLI: `supabase functions deploy extract-hearing-notice`.
// Requires the GEMINI_API_KEY secret (shared with the other AI functions).
//
// Reads the user's own uploaded hearing notice (or other notice received
// from the county) and extracts its real, actual content — a structured
// read of what the notice says, never a guess at what a typical notice
// would say. Two things this function does NOT trust the AI alone for:
// 1. Discrepancies against the case's own known facts (account number, tax
//    year, property address) are computed HERE, deterministically, after
//    parsing — not self-reported by the model.
// 2. hearingMode is hard-clamped to the fixed 5-value enum the UI actually
//    renders; anything else the model returns becomes "Unknown".
//
// informalReviewAvailable/proceduralDifferences ARE genuinely AI judgment
// (reading the notice's real text, informed by the county's real reference
// data the caller passes in from county-protest-info.ts) — grounded, but
// not independently hard-verifiable the way the fields above are.
import { GEMINI_MODEL_FAST, geminiUrl } from "../_shared/gemini.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

const MAX_DOCS = 3;

const HEARING_MODES = ["In Person", "Phone", "Videoconference", "Affidavit", "Unknown"] as const;

const SYSTEM = `You are CorvusPT's Texas property tax protest assistant. The user has uploaded a real hearing notice (or other notice) they received from their county appraisal district or Appraisal Review Board (ARB). Read the document's REAL, actual content and extract exactly what it says — never invent a date, name, deadline, or instruction that isn't actually printed on it.

Rules:
- Every field is null (or "Unclear" for informalReviewAvailable) when the notice genuinely doesn't state it — never guess or fill in a "typical" value.
- hearingDate/evidenceSubmissionDeadline/appealDeadline: as printed, in MM/DD/YYYY if a real date is given.
- hearingMode: one of "In Person", "Phone", "Videoconference", "Affidavit", "Unknown" — based on what the notice actually says about how the hearing will be conducted (or how the owner is instructed to appear).
- requiredDocuments: a real list of documents the notice says to bring or submit — empty array if none are listed.
- informalReviewAvailable: "Yes" only if the notice or the real county reference data below clearly says an informal review/conference is offered before the formal hearing; "No" if either clearly says it isn't; "Unclear" if neither says either way.
- proceduralDifferences: 1-3 sentences on how the informal and formal procedures actually differ for THIS county, if that's actually stated in the notice or the reference data below (deadlines, contacts, forms, filing methods, evidence requirements, scheduling) — say "Not specified" if the real sources don't actually say, rather than describing typical/generic Texas ARB procedure.
- Plain prose only in free-text fields — no markdown.
- Return ONLY a JSON object matching this exact shape: {"hearingDate":<string|null>,"hearingTime":<string|null>,"hearingLocation":<string|null>,"hearingMode":"<one of: In Person | Phone | Videoconference | Affidavit | Unknown>","evidenceSubmissionDeadline":<string|null>,"hearingType":<string|null>,"accountNumber":<string|null>,"taxYear":<string|null>,"propertyAddress":<string|null>,"countyContact":<string|null>,"appraiserContact":<string|null>,"submissionInstructions":<string|null>,"requiredDocuments":[<string>, ...],"appealDeadline":<string|null>,"informalReviewAvailable":"<Yes|No|Unclear>","proceduralDifferences":<string>}`;

function normalize(v: string | null | undefined): string {
  return (v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { caseContext, countyReference, documents } = await req.json();
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
      countyReference?.informalReview?.howToRequest
        ? `Real county reference — how to request an informal review: ${countyReference.informalReview.howToRequest}`
        : null,
      countyReference?.informalReview?.notes
        ? `Real county reference — informal review notes: ${countyReference.informalReview.notes}`
        : null,
      countyReference?.arbContact
        ? `Real county reference — ARB contact: ${[
            countyReference.arbContact.phone,
            countyReference.arbContact.email,
          ]
            .filter(Boolean)
            .join(", ")}`
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
        text: `Case context (real, already on file — use only to spot discrepancies and inform informalReviewAvailable, never as the source of the extracted fields themselves, which must come only from the document):\n${contextLines.length > 0 ? contextLines.join("\n") : "(none on file)"}\n\nExtract the real content of the attached hearing notice and produce the full JSON response.`,
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
    const hearingMode = HEARING_MODES.includes(parsed.hearingMode as (typeof HEARING_MODES)[number])
      ? (parsed.hearingMode as (typeof HEARING_MODES)[number])
      : "Unknown";
    const requiredDocuments = Array.isArray(parsed.requiredDocuments)
      ? parsed.requiredDocuments
          .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
          .map((x) => x.slice(0, 120))
          .slice(0, 10)
      : [];
    const informalReviewAvailable = (["Yes", "No", "Unclear"] as const).includes(
      parsed.informalReviewAvailable as "Yes" | "No" | "Unclear",
    )
      ? (parsed.informalReviewAvailable as "Yes" | "No" | "Unclear")
      : "Unclear";

    const extraction = {
      hearingDate: str(parsed.hearingDate, 20),
      hearingTime: str(parsed.hearingTime, 20),
      hearingLocation: str(parsed.hearingLocation, 200),
      hearingMode,
      evidenceSubmissionDeadline: str(parsed.evidenceSubmissionDeadline, 20),
      hearingType: str(parsed.hearingType, 80),
      accountNumber: str(parsed.accountNumber, 40),
      taxYear: str(parsed.taxYear, 10),
      propertyAddress: str(parsed.propertyAddress, 200),
      countyContact: str(parsed.countyContact, 200),
      appraiserContact: str(parsed.appraiserContact, 200),
      submissionInstructions: str(parsed.submissionInstructions, 400),
      requiredDocuments,
      appealDeadline: str(parsed.appealDeadline, 20),
      informalReviewAvailable,
      proceduralDifferences: str(parsed.proceduralDifferences, 500) ?? "Not specified.",
    };

    // Real, deterministic comparison against the case's own known facts —
    // never trusting the model's own say-so on whether something matches.
    // Only compares a field when BOTH sides actually have a real value;
    // never flags a discrepancy against something we don't actually know.
    const discrepancies: string[] = [];
    if (
      extraction.accountNumber &&
      caseContext?.accountNumber &&
      normalize(extraction.accountNumber) !== normalize(caseContext.accountNumber)
    ) {
      discrepancies.push(
        `Account number on the notice (${extraction.accountNumber}) doesn't match the account number on file (${caseContext.accountNumber}).`,
      );
    }
    if (
      extraction.taxYear &&
      caseContext?.taxYear &&
      String(extraction.taxYear).trim() !== String(caseContext.taxYear).trim()
    ) {
      discrepancies.push(
        `Tax year on the notice (${extraction.taxYear}) doesn't match the tax year on file (${caseContext.taxYear}).`,
      );
    }
    if (extraction.propertyAddress && caseContext?.address) {
      const a = normalize(extraction.propertyAddress);
      const b = normalize(caseContext.address);
      // Substring check, not exact equality — real addresses on a notice
      // and on file legitimately differ in formatting/suite numbers/city
      // spelling even when they're the same property, so only flag a
      // genuinely unrelated address, not a formatting difference.
      if (!a.includes(b.slice(0, 12)) && !b.includes(a.slice(0, 12))) {
        discrepancies.push(
          `Property address on the notice ("${extraction.propertyAddress}") doesn't clearly match the address on file ("${caseContext.address}").`,
        );
      }
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
