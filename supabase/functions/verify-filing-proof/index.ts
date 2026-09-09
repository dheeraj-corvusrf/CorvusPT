// Deploy via CLI: `supabase functions deploy verify-filing-proof`.
// Requires the GEMINI_API_KEY secret (shared with the other AI functions).
//
// Reads the user's own uploaded "proof of filing" documents (a confirmation
// screenshot/email, a stamped/dated copy, a certified-mail receipt, etc.)
// and gives an honest, real read of what's actually visible — whether a
// signature is present, whose name it looks like, and what date/year is
// shown. This is advisory only: it NEVER blocks or auto-confirms anything.
// The one honest source of "this protest was actually filed" is still the
// customer's own explicit "Yes" (see markFiled() in protest-case.ts and
// CaseDetailModal.tsx's filing-confirmation flow) — this just flags a
// concrete mismatch (no signature visible, a stale-looking year) for the
// customer to notice before they confirm, same "AI advises, human decides"
// discipline as every other AI feature in this app.
import { GEMINI_MODEL_FAST, geminiUrl } from "../_shared/gemini.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

const MAX_DOCS = 5;

const SYSTEM = `You are CorvusPT's property tax protest assistant. The user has uploaded documents as proof that they filed/submitted a property tax protest (this could be a confirmation screenshot or email from an online portal, a stamped/dated copy from the appraisal district, a certified-mail receipt, or the signed Notice of Protest itself). Look at each document's REAL, actual content and report what you actually see — never guess or infer something that isn't visible.

Rules:
- hasVisibleSignature: true only if you can actually see a handwritten or typed signature mark on the document. False if there is none, or if the document isn't the kind of document that would carry one (e.g. a plain confirmation email/screenshot).
- signatureNameObserved: the name as it actually appears next to/under the signature, verbatim, or null if none is visible or none is legible.
- dateObserved: the most relevant date actually printed/written on the document (e.g. a signature date, a postmark date, a confirmation timestamp), in whatever format it's actually shown, or null if no date is visible.
- dateYearPlausible: compare the year in dateObserved (if any) against the case's expected tax year and today's real-world date context — true if it's a sensible, current/recent year for this filing, false if it looks stale (an old prior year) or otherwise implausible, null if there's no date to judge.
- notes: 1-2 plain sentences on anything a property owner should double-check about this specific document — or "Looks consistent with a filed protest." if nothing looks off. Never invent a concern that isn't grounded in what's actually visible.
- findings must have exactly one entry per document provided, in the same order, using the exact fileName given for each.
- overallAssessment: 1-2 sentences summarizing across all documents together — plain prose, no markdown.
- This is advisory information for the property owner to review themselves — never claim certainty beyond what's actually visible, and never state that the protest "was" or "was not" filed; that determination belongs to the owner alone.
- Return ONLY a JSON object matching this exact shape: {"findings":[{"fileName":"...","hasVisibleSignature":<true|false>,"signatureNameObserved":<string|null>,"dateObserved":<string|null>,"dateYearPlausible":<true|false|null>,"notes":"..."}],"overallAssessment":"..."}`;

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
      property?.taxYear ? `Tax year this protest is for: ${property.taxYear}` : null,
      property?.ownerName ? `Property owner on file: ${property.ownerName}` : null,
      `Today's real-world date: ${new Date().toISOString().slice(0, 10)}`,
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
        text: `Case context:\n${contextLines.join("\n")}\n\nDocuments provided, in order:\n${fileList}\n\nAnalyze each document below (in the same order listed above) and produce the full JSON response.`,
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
    let parsed: {
      findings?: Array<{
        fileName?: string;
        hasVisibleSignature?: boolean;
        signatureNameObserved?: string | null;
        dateObserved?: string | null;
        dateYearPlausible?: boolean | null;
        notes?: string;
      }>;
      overallAssessment?: string;
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : {};
    }

    const result = {
      findings: Array.isArray(parsed.findings)
        ? parsed.findings.map((f, i) => ({
            fileName: f.fileName ?? usableDocs[i]?.fileName ?? `Document ${i + 1}`,
            hasVisibleSignature: f.hasVisibleSignature === true,
            signatureNameObserved:
              typeof f.signatureNameObserved === "string"
                ? f.signatureNameObserved.slice(0, 120)
                : null,
            dateObserved: typeof f.dateObserved === "string" ? f.dateObserved.slice(0, 60) : null,
            dateYearPlausible:
              typeof f.dateYearPlausible === "boolean" ? f.dateYearPlausible : null,
            notes: typeof f.notes === "string" ? f.notes.slice(0, 300) : "",
          }))
        : [],
      overallAssessment:
        typeof parsed.overallAssessment === "string" ? parsed.overallAssessment.slice(0, 500) : "",
    };

    return new Response(JSON.stringify(result), { status: 200, headers: corsHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "unknown error" }),
      { status: 500, headers: corsHeaders },
    );
  }
});
