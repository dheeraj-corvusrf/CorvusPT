// Deploy via CLI: `supabase functions deploy verify-case-readiness`.
// Requires the GEMINI_API_KEY secret (shared with the other AI functions).
//
// A light AI review of an assembled protest case against the county's real
// filing requirements, shown in the "AI Guidance & Filing Notice" step before
// the user continues. Grounded ONLY in facts the caller passes — the case's
// own identity fields plus the hand-verified county-protest-info block. It
// NEVER invents a county rule; when nothing looks off it returns an empty
// list. Advisory only — the deterministic Pre-Filing Check (pre-filing-check.ts)
// is what actually blocks filing. Same "no auth check, rate-limited AI helper"
// pattern as hearing-prep-guide.
import { GEMINI_MODEL_FAST, geminiUrl } from "../_shared/gemini.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

const SYSTEM = `You are CorvusPT's Texas property-tax-protest assistant. You are given a property owner's assembled protest case (its real identity fields) and, when available, the hand-verified filing facts for that county. Your job: check whether anything in the case is INCONSISTENT with the county's requirements or with itself, so the owner can fix it before filing.

Rules:
- Reason ONLY from the facts given. NEVER invent or assume a county rule, form number, deadline, or procedure that is not stated in the input.
- Flag things that genuinely don't line up: a protest deadline in the past or in the wrong year for the tax year, a tax year that looks wrong, a missing/blank property classification, a filing method the county doesn't confirm, an owner/entity that looks incomplete for a signature, a form that isn't the right one for this protest.
- Do NOT flag something as a concern just because a field is "not confirmed" for the county — the standard Comptroller Form 50-132 process is always a valid fallback. Only flag a real contradiction or a real gap that would stop a filing from being accepted.
- severity "high" = would likely cause the filing to be rejected or missed (past deadline, wrong tax year, no owner name). severity "medium" = worth confirming but not disqualifying.
- If nothing is off, return an empty concerns array. Prefer few, specific concerns over many vague ones (max 5).
- Return ONLY a JSON object: {"concerns":[{"field":"<short label, e.g. 'Protest Deadline'>","concern":"<one plain sentence: what's wrong and what to do>","severity":"high"|"medium"},...]}`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { caseFacts, countyReference } = await req.json();

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

    const lines: string[] = [];
    lines.push(`Today's date: ${new Date().toISOString().slice(0, 10)}`);
    lines.push("--- Assembled protest case ---");
    lines.push(`County (CAD): ${caseFacts?.cad ?? "MISSING"}`);
    lines.push(`Property address: ${caseFacts?.address ?? "MISSING"}`);
    lines.push(`Account / parcel number: ${caseFacts?.accountNumber ?? "MISSING"}`);
    lines.push(`Tax year on the protest: ${caseFacts?.protestTaxYear ?? "MISSING"}`);
    lines.push(`Tax year on the property record: ${caseFacts?.propertyTaxYear ?? "not on file"}`);
    lines.push(`Owner / entity of record: ${caseFacts?.ownerName ?? "MISSING"}`);
    lines.push(`CAD property classification: ${caseFacts?.propertyType ?? "MISSING"}`);
    lines.push(`Protest deadline on file: ${caseFacts?.protestDeadline ?? "MISSING"}`);
    lines.push(`Applicable form: ${caseFacts?.applicableForm ?? "Comptroller Form 50-132"}`);
    lines.push(
      `Filing method the app will use: ${caseFacts?.filingMethod ?? "standard download-and-deliver"}`,
    );
    lines.push(`Supporting documents uploaded: ${caseFacts?.evidenceCount ?? 0}`);

    if (countyReference) {
      lines.push("--- Hand-verified county filing facts ---");
      lines.push(`Verified as of: ${countyReference.verifiedAt ?? "unknown"}`);
      lines.push(`Source: ${countyReference.sourceUrl ?? "n/a"}`);
      const fm = countyReference.filingMethod;
      if (fm) {
        const methods = [
          fm.online ? `online (${fm.online.url})` : null,
          fm.mail ? `mail (${fm.mail.address})` : null,
          fm.inPerson ? `in person (${fm.inPerson.address})` : null,
          fm.email?.available ? `email${fm.email.address ? ` (${fm.email.address})` : ""}` : null,
        ].filter(Boolean);
        lines.push(
          `Filing channels this county confirms: ${methods.length > 0 ? methods.join("; ") : "none specifically confirmed — the standard process applies"}`,
        );
      }
      if (countyReference.arbContact) {
        const c = countyReference.arbContact;
        lines.push(
          `County ARB contact: ${[c.phone, c.email, c.office].filter(Boolean).join(", ") || "none confirmed"}`,
        );
      }
    } else {
      lines.push(
        "--- No hand-verified county record on file — the standard Texas Comptroller Form 50-132 process applies. Do NOT flag this as a concern by itself. ---",
      );
    }

    const body = {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [
        {
          role: "user",
          parts: [{ text: `${lines.join("\n")}\n\nReturn the concerns JSON.` }],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0,
        topK: 1,
        topP: 0,
        seed: 7,
      },
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

    const concerns = Array.isArray(parsed.concerns)
      ? (parsed.concerns as Record<string, unknown>[])
          .filter((c) => c && typeof c === "object")
          .map((c) => ({
            field: (typeof c.field === "string" ? c.field : "Case").slice(0, 60),
            concern: (typeof c.concern === "string" ? c.concern : "").slice(0, 300),
            severity: c.severity === "high" ? "high" : "medium",
          }))
          .filter((c) => c.concern.length > 0)
          .slice(0, 5)
      : [];

    return new Response(JSON.stringify({ concerns }), { status: 200, headers: corsHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "unknown error" }),
      { status: 500, headers: corsHeaders },
    );
  }
});
