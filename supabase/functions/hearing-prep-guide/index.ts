// Deploy via CLI: `supabase functions deploy hearing-prep-guide`.
// Requires the GEMINI_API_KEY secret (shared with the other AI functions).
//
// Produces a real, step-by-step ARB hearing prep guide — grounded ONLY in
// real data the caller already has: the property's own real values, the
// case's own generated strategy, the real evidence documents actually
// uploaded, the real hearing notice (when one was extracted), the real
// county contact/filing data, and — critically — real comparable-sales
// numbers already computed client-side by computeComparableStats()
// (comps-analysis.ts), never invented here. The model never sees raw comp
// data to "make up" a table from; it only narrates around numbers the
// caller already computed and is passing in as fact.
//
// Two things this function does NOT trust the AI alone for:
// 1. The "no guaranteed outcome" disclaimer is always appended server-side,
//    regardless of what the model wrote — never conditional on the model
//    remembering to include it.
// 2. requestedValue guidance is instructed to stay grounded in the real
//    comps/case numbers given, but is free text (like every other
//    guidance field this app's AI functions return) — same discipline as
//    informal-review-guidance's requestedValueGuidance.
import { PROSE_STYLE } from "../_shared/prose-style.ts";
import { GEMINI_MODEL_FAST, geminiUrl } from "../_shared/gemini.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

const DISCLAIMER =
  "This guide is prepared from your case's real data to help you present your strongest case — it is not a guarantee of any specific reduction or outcome. The ARB makes its own independent decision.";

const SYSTEM = `You are CorvusPT's Texas property tax protest assistant, preparing a property owner for their real, upcoming ARB (Appraisal Review Board) hearing. You will be given real case data — the property's real values, the case's real strategy and evidence, a real hearing notice (if one was uploaded and extracted), real county contact/filing information, and — if available — REAL comparable-sales numbers already computed from actual CAD records (never numbers you invent).

Rules:
- NEVER invent a comparable property, a sale price, a specific dollar figure, or a percentage that isn't given to you in the input. If comps data is not provided (comps.available is false), say plainly that no comparable-sales data is available for this county and the argument should lean on other real evidence provided instead — do not describe hypothetical comps.
- valueToRequest / requestedValue: ground this in the real comps.indicated numbers when available (e.g. "near the comps-indicated median of $X"), or the real strategy/evidence context when comps aren't available. Never state a number that wasn't given to you.
- Every section should reference REAL specifics from the input (the real address, real evidence file names, real comp addresses/values when given) rather than generic advice that could apply to any hearing.
- Never guarantee, promise, or imply a specific outcome or reduction — describe this as what the evidence supports, not what will happen.
- Plain prose in free-text fields, no markdown. Arrays should have 2-6 short, concrete items each, never empty unless there is genuinely nothing real to say.
- Return ONLY a JSON object with this exact shape: {"hearingSummary":<string>,"evidencePacketNote":<string>,"beforeHearing":{"whatToReview":[<string>,...],"documentsToHaveReady":[<string>,...],"valueToRequest":<string>,"keyEvidence":[<string>,...],"howToOrganize":<string>,"questionPrep":<string>},"duringHearing":{"openingStatement":<string>,"valueExplanation":<string>,"comparableEvidencePresentation":<string>,"conditionArguments":<string>,"requestedValue":<string>,"closingStatement":<string>},"propertySpecificArguments":[<string>,...],"questionsToAsk":[<string>,...],"questionsArbMayAsk":[<string>,...],"weaknessesAndRisks":[<string>,...],"documentsToHave":[<string>,...],"submissionInstructions":<string>,"countyContact":<string>,"hearingLogistics":<string>}

${PROSE_STYLE}`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { caseContext, hearingNotice, countyReference, evidence, comps, attendanceType } =
      await req.json();

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

    const lines: string[] = [];
    lines.push(`Property: ${caseContext?.address ?? "unknown address"}`);
    if (caseContext?.cad) lines.push(`Appraisal district: ${caseContext.cad}`);
    if (caseContext?.accountNumber) lines.push(`Account number: ${caseContext.accountNumber}`);
    if (caseContext?.taxYear) lines.push(`Tax year: ${caseContext.taxYear}`);
    if (caseContext?.propertyType) lines.push(`Property type: ${caseContext.propertyType}`);
    if (caseContext?.totalValue != null)
      lines.push(`Current total assessed value: $${caseContext.totalValue}`);
    if (caseContext?.landValue != null) lines.push(`Land value: $${caseContext.landValue}`);
    if (caseContext?.improvementValue != null)
      lines.push(`Improvement value: $${caseContext.improvementValue}`);
    if (caseContext?.strategyRecommendation)
      lines.push(`Case strategy: ${caseContext.strategyRecommendation}`);
    if (caseContext?.strategyRationale)
      lines.push(`Strategy rationale: ${caseContext.strategyRationale}`);

    if (hearingNotice) {
      lines.push("--- Real hearing notice on file ---");
      if (hearingNotice.hearingDate) lines.push(`Hearing date: ${hearingNotice.hearingDate}`);
      if (hearingNotice.hearingTime) lines.push(`Hearing time: ${hearingNotice.hearingTime}`);
      if (hearingNotice.hearingLocation)
        lines.push(`Hearing location: ${hearingNotice.hearingLocation}`);
      if (hearingNotice.hearingMode) lines.push(`Hearing mode: ${hearingNotice.hearingMode}`);
      if (hearingNotice.hearingType) lines.push(`Hearing type: ${hearingNotice.hearingType}`);
      if (hearingNotice.evidenceSubmissionDeadline)
        lines.push(`Evidence submission deadline: ${hearingNotice.evidenceSubmissionDeadline}`);
      if (hearingNotice.submissionInstructions)
        lines.push(`Submission instructions on notice: ${hearingNotice.submissionInstructions}`);
      if (
        Array.isArray(hearingNotice.requiredDocuments) &&
        hearingNotice.requiredDocuments.length > 0
      )
        lines.push(`Required documents per notice: ${hearingNotice.requiredDocuments.join("; ")}`);
      if (hearingNotice.countyContact)
        lines.push(`County contact on notice: ${hearingNotice.countyContact}`);
      if (hearingNotice.appraiserContact)
        lines.push(`Appraiser contact on notice: ${hearingNotice.appraiserContact}`);
    }

    if (countyReference?.arbContact) {
      const c = countyReference.arbContact;
      lines.push(
        `Real county ARB contact on file: ${[c.phone, c.email, c.office].filter(Boolean).join(", ") || "none confirmed"}`,
      );
    }
    if (countyReference?.filingMethod) {
      const fm = countyReference.filingMethod;
      const methods = [
        fm.online ? `online (${fm.online.url})` : null,
        fm.mail ? `mail (${fm.mail.address})` : null,
        fm.inPerson ? `in person (${fm.inPerson.address})` : null,
        fm.email?.available && fm.email.address ? `email (${fm.email.address})` : null,
      ].filter(Boolean);
      if (methods.length > 0)
        lines.push(`Real submission channels this county confirms: ${methods.join("; ")}`);
    }

    if (Array.isArray(evidence?.fileNames) && evidence.fileNames.length > 0) {
      lines.push(`Real evidence documents uploaded: ${evidence.fileNames.join("; ")}`);
    } else {
      lines.push("No evidence documents have been uploaded to this case yet.");
    }
    if (evidence?.analysisSummary)
      lines.push(`Prior AI evidence analysis summary: ${evidence.analysisSummary}`);
    if (Array.isArray(evidence?.documentFindings) && evidence.documentFindings.length > 0) {
      lines.push(
        `Per-document findings: ${evidence.documentFindings
          .map(
            (f: { fileName?: string; status?: string; assessment?: string }) =>
              `${f.fileName ?? "?"} — ${f.status ?? "?"} — ${f.assessment ?? ""}`,
          )
          .join(" | ")}`,
      );
    }

    if (comps?.available && comps.indicated) {
      lines.push("--- Real comparable-sales data (already computed, not to be altered) ---");
      lines.push(
        `Comps-indicated value: min $${comps.indicated.min}, median $${comps.indicated.median}, max $${comps.indicated.max}` +
          (comps.valuationGapPct != null
            ? `, subject sits ${comps.valuationGapPct}% above the median`
            : ""),
      );
      if (comps.confidencePct != null)
        lines.push(`Confidence in this comps read: ${comps.confidencePct}%`);
      if (Array.isArray(comps.ranked) && comps.ranked.length > 0) {
        lines.push(
          `Top comparable properties: ${comps.ranked
            .slice(0, 5)
            .map(
              (c: {
                address?: string;
                distanceMi?: number;
                marketValue?: number | null;
                similarity?: number;
              }) =>
                `${c.address ?? "?"} (${c.distanceMi?.toFixed(2) ?? "?"} mi, $${c.marketValue ?? "?"}, ${c.similarity ?? "?"}% similar)`,
            )
            .join("; ")}`,
        );
      }
    } else {
      lines.push(
        "No comparable-sales data is available for this county from this app's real data sources — do not describe hypothetical comps.",
      );
    }

    if (attendanceType) lines.push(`Who will attend: ${attendanceType}`);

    const body = {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [
        {
          role: "user",
          parts: [{ text: `${lines.join("\n")}\n\nProduce the full JSON hearing prep guide.` }],
        },
      ],
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

    const str = (v: unknown, len = 600): string =>
      (typeof v === "string" ? v.trim() : "").slice(0, len);
    const arr = (v: unknown, itemLen = 220, max = 8): string[] =>
      Array.isArray(v)
        ? v
            .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
            .map((x) => x.slice(0, itemLen))
            .slice(0, max)
        : [];
    const obj = (v: unknown): Record<string, unknown> =>
      v && typeof v === "object" ? (v as Record<string, unknown>) : {};

    const before = obj(parsed.beforeHearing);
    const during = obj(parsed.duringHearing);

    const guide = {
      hearingSummary: str(parsed.hearingSummary),
      evidencePacketNote: str(parsed.evidencePacketNote, 400),
      beforeHearing: {
        whatToReview: arr(before.whatToReview),
        documentsToHaveReady: arr(before.documentsToHaveReady),
        valueToRequest: str(before.valueToRequest, 400),
        keyEvidence: arr(before.keyEvidence),
        howToOrganize: str(before.howToOrganize, 400),
        questionPrep: str(before.questionPrep, 400),
      },
      duringHearing: {
        openingStatement: str(during.openingStatement, 800),
        valueExplanation: str(during.valueExplanation, 800),
        comparableEvidencePresentation: str(during.comparableEvidencePresentation, 800),
        conditionArguments: str(during.conditionArguments, 800),
        requestedValue: str(during.requestedValue, 400),
        closingStatement: str(during.closingStatement, 600),
      },
      propertySpecificArguments: arr(parsed.propertySpecificArguments),
      questionsToAsk: arr(parsed.questionsToAsk),
      questionsArbMayAsk: arr(parsed.questionsArbMayAsk),
      weaknessesAndRisks: arr(parsed.weaknessesAndRisks),
      documentsToHave: arr(parsed.documentsToHave),
      submissionInstructions: str(parsed.submissionInstructions, 500),
      countyContact: str(parsed.countyContact, 300),
      hearingLogistics: str(parsed.hearingLogistics, 500),
      disclaimer: DISCLAIMER,
    };

    return new Response(JSON.stringify(guide), { status: 200, headers: corsHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "unknown error" }),
      { status: 500, headers: corsHeaders },
    );
  }
});
