// Deploy via CLI: `supabase functions deploy informal-review-guidance`.
// Requires the GEMINI_API_KEY secret (shared with the other AI functions).
//
// Real, grounded guidance for the informal-review step of a Texas property
// tax protest — whether it's available, who to contact, how to request it,
// what to bring, what value to ask for, what to say/not say, how to
// respond to a proposed value, and whether accepting ends the case. Every
// field is either grounded in the real property/case record given below or
// in the county's own real reference data (county-protest-info.ts, passed
// in as countyReference) — never a generic "how ARB hearings typically
// work" essay unrelated to this specific case.
//
// emailPermitted/contactEmail are NOT AI-decided — computed here from the
// real countyReference.arbContact.email the caller already has on file
// (see county-protest-info.ts), so a drafted email is only ever offered
// when addressed to a real, verified address, never one the model invents.
import { PROSE_STYLE, STRUCTURED_BULLET_STYLE } from "../_shared/prose-style.ts";
import { GEMINI_MODEL_FAST, geminiUrl } from "../_shared/gemini.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

const APPRAISER_CATEGORIES = [
  "Land Appraiser",
  "Improvement Appraiser",
  "Commercial Appraiser",
  "Retail Appraiser",
  "Office Appraiser",
  "Daycare/School Appraiser",
  "Other",
] as const;

const SYSTEM = `You are CorvusPT's Texas property tax protest assistant, giving real, practical guidance for the INFORMAL review step (a conversation with the county appraiser before any formal ARB hearing) for one specific real property and case.

Rules:
- Ground every answer in the real case record and real county reference data given below — never invent a specific fact (a dollar figure, a deadline, a contact name) that isn't actually in what you were given.
- available: "Yes" if the county reference data confirms an informal review process exists for this county; "No" if it confirms one doesn't; "Unclear" if the reference data doesn't actually say either way.
- appraiserCategory: your best real read of which specialty would handle this property's informal review, from property type and strategy context — one of: Land Appraiser | Improvement Appraiser | Commercial Appraiser | Retail Appraiser | Office Appraiser | Daycare/School Appraiser | Other. Pick "Other" rather than guessing when genuinely unclear.
- whoToContact/howToRequest: use the REAL contact/process from the county reference data given below — never invent a name, email, or phone number not actually provided.
- requestedValueGuidance: a real, case-specific suggestion grounded in the actual assessed value, strategy, and estimated reduction given below — not generic "ask for a lower value" filler.
- evidenceToUse: 2-5 real, specific evidence types relevant to THIS case's actual strategy/property type, not a generic checklist.
- whatToSay/whatNotToSay: 2-3 concrete, practical sentences each, specific to informal conversations with a county appraiser (facts and comps, not procedural arguments — those belong at the formal hearing).
- respondingToProposedValue: how to evaluate whether a proposed value is a reasonable outcome vs. worth continuing to a formal hearing.
- acceptingEndsCase: state plainly whether accepting an informal proposed value ends the case (in Texas, accepting an informal settlement typically withdraws the formal protest) or requires an additional step.
- steps: the ordered, concrete actions THIS owner takes to get their informal review scheduled and done — request it, schedule it, where/how, who to confirm with, what to bring on the day. 3-7 items, each a single imperative action grounded in the real notice or county reference; no generic "prepare your evidence" filler.
- whereToSchedule: the actual place/channel to schedule it — a portal URL, an office address, a phone number, or an email — taken from the real notice or county reference. Empty string if genuinely not stated anywhere in what you were given.
- applicableDeadlines: real, dated deadlines that apply to this informal review, copied from the notice or county reference (evidence-submission cutoff, informal-request cutoff, appeal/escalation deadline). Each item is "<label>: <date or timeframe>". Empty array if none are actually stated.
- missingInfo: things the owner needs in order to act but that the notice and case record given below do NOT provide (e.g. no informal-review contact stated, no scheduling channel, no evidence deadline). For each, say what to do to get it (which office/number to call). Empty array if nothing important is missing.
- nextSteps: 1-3 imperative actions the owner should take right now, most important first.
- Each free-text field is rendered as markdown — keep it terse: one or two short sentences, or "- " bullets when the field holds several parallel points. Prefer the dedicated array fields (steps, documentsToProvide, evidenceToUse, applicableDeadlines, missingInfo, nextSteps) for lists; keep the array items themselves to one concrete point each.
- Return ONLY a JSON object matching this exact shape: {"available":"<Yes|No|Unclear>","appraiserCategory":"<one of: Land Appraiser | Improvement Appraiser | Commercial Appraiser | Retail Appraiser | Office Appraiser | Daycare/School Appraiser | Other>","whoToContact":"<string>","howToRequest":"<string>","documentsToProvide":[<string>, ...],"requestedValueGuidance":"<string>","evidenceToUse":[<string>, ...],"whatToSay":"<string>","whatNotToSay":"<string>","respondingToProposedValue":"<string>","acceptingEndsCase":"<string>","steps":[<string>, ...],"whereToSchedule":"<string>","applicableDeadlines":[<string>, ...],"missingInfo":[<string>, ...],"nextSteps":[<string>, ...],"draftEmailSubject":"<string, only if an email address was given below — otherwise empty string>","draftEmailBody":"<string, only if an email address was given below — otherwise empty string, written in the property owner's own voice, referencing the real address/account number/tax year/requested value given below>"}

${PROSE_STYLE}

${STRUCTURED_BULLET_STYLE}`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { caseContext, countyReference, noticeContext } = await req.json();

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

    // The real, verified contact email this drafted request would actually
    // go to — never the model's own invention. No email address on file
    // means no draft email is offered at all (the prompt is told this
    // explicitly via contextLines below).
    const contactEmail: string | null = countyReference?.arbContact?.email || null;

    const contextLines = [
      caseContext?.address ? `Property address: ${caseContext.address}` : null,
      caseContext?.cad ? `Appraisal district: ${caseContext.cad}` : null,
      caseContext?.accountNumber ? `Account number: ${caseContext.accountNumber}` : null,
      caseContext?.taxYear ? `Tax year: ${caseContext.taxYear}` : null,
      caseContext?.propertyType ? `Property type: ${caseContext.propertyType}` : null,
      caseContext?.totalValue ? `Current assessed value: $${caseContext.totalValue}` : null,
      caseContext?.strategyRecommendation
        ? `Case strategy on file: ${caseContext.strategyRecommendation}`
        : null,
      caseContext?.estimatedReduction
        ? `Estimated real value reduction from this case's own analysis: $${caseContext.estimatedReduction}`
        : null,
      caseContext?.evidenceFileNames?.length
        ? `Evidence already uploaded: ${caseContext.evidenceFileNames.join(", ")}`
        : null,
      countyReference?.informalReview?.howToRequest
        ? `Real county reference — how to request an informal review: ${countyReference.informalReview.howToRequest}`
        : "Real county reference — no confirmed informal review process on file for this county.",
      countyReference?.informalReview?.notes
        ? `Real county reference — informal review notes: ${countyReference.informalReview.notes}`
        : null,
      countyReference?.arbContact?.phone || countyReference?.arbContact?.email
        ? `Real county reference — ARB/appraiser contact: ${[
            countyReference.arbContact.phone,
            countyReference.arbContact.email,
          ]
            .filter(Boolean)
            .join(", ")}`
        : null,
      contactEmail
        ? `A real, verified contact email IS on file (${contactEmail}) — draftEmailSubject/draftEmailBody should be filled in.`
        : "No real, verified contact email is on file for this county — leave draftEmailSubject/draftEmailBody as empty strings rather than inventing an address.",
      // Real fields the user's actual uploaded hearing/county notice, if any
      // (see extract-hearing-notice) — ground steps / whereToSchedule /
      // applicableDeadlines / missingInfo in these, not just the county
      // reference. A null field here means the notice didn't state it (or no
      // notice was uploaded) — that's exactly what missingInfo is for.
      noticeContext
        ? "A hearing/county notice HAS been uploaded and read for this case. Its extracted fields:"
        : "No county notice has been uploaded for this case yet — say so in missingInfo and nextSteps (the owner should upload the notice they received).",
      noticeContext?.informalReviewAvailable
        ? `Notice — informal review available: ${noticeContext.informalReviewAvailable}`
        : null,
      noticeContext?.hearingDate
        ? `Notice — hearing date stated: ${noticeContext.hearingDate}`
        : null,
      noticeContext?.evidenceSubmissionDeadline
        ? `Notice — evidence submission deadline: ${noticeContext.evidenceSubmissionDeadline}`
        : null,
      noticeContext?.appealDeadline
        ? `Notice — appeal/escalation deadline: ${noticeContext.appealDeadline}`
        : null,
      noticeContext?.countyContact
        ? `Notice — county contact: ${noticeContext.countyContact}`
        : null,
      noticeContext?.appraiserContact
        ? `Notice — appraiser contact: ${noticeContext.appraiserContact}`
        : null,
      noticeContext?.submissionInstructions
        ? `Notice — submission instructions (verbatim): ${noticeContext.submissionInstructions}`
        : null,
      noticeContext?.requiredDocuments?.length
        ? `Notice — required documents: ${noticeContext.requiredDocuments.join("; ")}`
        : null,
      noticeContext?.proceduralDifferences
        ? `Notice — procedural notes on informal review: ${noticeContext.proceduralDifferences}`
        : null,
    ].filter(Boolean);

    const body = {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Case record:\n${contextLines.join("\n")}\n\nProduce the full JSON response.`,
            },
          ],
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

    const str = (v: unknown, len: number): string => (typeof v === "string" ? v.slice(0, len) : "");
    const arr = (v: unknown, max: number, len: number): string[] =>
      Array.isArray(v)
        ? v
            .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
            .map((x) => x.slice(0, len))
            .slice(0, max)
        : [];
    const available = (["Yes", "No", "Unclear"] as const).includes(
      parsed.available as "Yes" | "No" | "Unclear",
    )
      ? (parsed.available as "Yes" | "No" | "Unclear")
      : "Unclear";
    const appraiserCategory = APPRAISER_CATEGORIES.includes(
      parsed.appraiserCategory as (typeof APPRAISER_CATEGORIES)[number],
    )
      ? (parsed.appraiserCategory as (typeof APPRAISER_CATEGORIES)[number])
      : "Other";

    const result = {
      available,
      appraiserCategory,
      whoToContact: str(parsed.whoToContact, 300),
      howToRequest: str(parsed.howToRequest, 400),
      documentsToProvide: arr(parsed.documentsToProvide, 8, 120),
      requestedValueGuidance: str(parsed.requestedValueGuidance, 400),
      evidenceToUse: arr(parsed.evidenceToUse, 6, 120),
      whatToSay: str(parsed.whatToSay, 400),
      whatNotToSay: str(parsed.whatNotToSay, 400),
      respondingToProposedValue: str(parsed.respondingToProposedValue, 400),
      acceptingEndsCase: str(parsed.acceptingEndsCase, 400),
      steps: arr(parsed.steps, 8, 240),
      whereToSchedule: str(parsed.whereToSchedule, 300),
      applicableDeadlines: arr(parsed.applicableDeadlines, 6, 160),
      missingInfo: arr(parsed.missingInfo, 6, 240),
      nextSteps: arr(parsed.nextSteps, 4, 240),
      // Hard gate — the model is told not to fill these in without a real
      // email on file, but this is enforced here too, not just trusted.
      draftEmailSubject: contactEmail ? str(parsed.draftEmailSubject, 150) : "",
      draftEmailBody: contactEmail ? str(parsed.draftEmailBody, 1500) : "",
      contactEmail,
    };

    return new Response(JSON.stringify(result), { status: 200, headers: corsHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "unknown error" }),
      { status: 500, headers: corsHeaders },
    );
  }
});
