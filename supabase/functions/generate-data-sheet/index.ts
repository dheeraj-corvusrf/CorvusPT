// Deploy via CLI: `supabase functions deploy generate-data-sheet`.
// Requires the GEMINI_API_KEY secret (shared with the other AI functions).
//
// A report module flags certain inputs as missing ("Additional Data Needed",
// "not provided", dataSufficient: false). This drafts a STARTER DATA SHEET
// for those inputs: for each one, a typical / assumed value, the basis for
// it, and how the owner can confirm the real figure. The output is a
// reference document the owner reviews and edits — it is explicitly NOT
// verified data and is never fed back into a module as a real input.
import { PROSE_STYLE } from "../_shared/prose-style.ts";
import { GEMINI_MODEL_FAST, geminiUrl } from "../_shared/gemini.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

const BANNER =
  "AI-GENERATED ASSUMPTIONS — NOT VERIFIED DATA. Every value below is a typical or estimated figure, not a fact about this property. Confirm each one from the real source before relying on it in a protest.";

const SYSTEM = `You are CorvusPT's Texas commercial property tax analyst. A report module could not complete part of its analysis because specific inputs are missing. Draft a "starter data sheet" the owner can use to gather or estimate those inputs.

Rules:
- Work only from the module analysis and property record given below. Identify the specific inputs the module is missing (it marks them as "Additional Data Needed", "not provided", "inconclusive", or dataSufficient: false).
- For EACH missing input, give: (a) a typical / assumed value or range for a property of this type and area, clearly stated as an assumption; (b) the one-line basis for that assumption; (c) exactly where the owner gets the real figure (which document, office, or measurement).
- Never state an assumption as a known fact about this property. Never invent a document, a comparable sale price, or a measured dimension and present it as real.
- markdown: start with a "# <title>" line, then the fixed banner line verbatim, then one "## <input name>" section per missing input with "- " bullets for the value / basis / how to confirm. No preamble before the title, no closing summary.
- If nothing is actually missing, return a markdown body that says so in one line.
- Return ONLY a JSON object: {"title": "<short title>", "markdown": "<the sheet>"}

${PROSE_STYLE}`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { moduleId, moduleLabel, moduleResult, caseContext } = await req.json();
    if (!moduleLabel) {
      return new Response(JSON.stringify({ error: "moduleLabel is required" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

    const contextLines = [
      caseContext?.address ? `Property address: ${caseContext.address}` : null,
      caseContext?.cad ? `Appraisal district: ${caseContext.cad}` : null,
      caseContext?.propertyType ? `Property type: ${caseContext.propertyType}` : null,
      caseContext?.totalValue ? `Assessed value: $${caseContext.totalValue}` : null,
      caseContext?.taxYear ? `Tax year: ${caseContext.taxYear}` : null,
    ].filter(Boolean);

    const userText =
      `Module: ${moduleLabel} (${moduleId ?? "unknown id"})\n\n` +
      `Property record:\n${contextLines.length ? contextLines.join("\n") : "(minimal)"}\n\n` +
      `The module's current analysis (find the inputs it says are missing):\n${JSON.stringify(
        moduleResult ?? {},
      ).slice(0, 6000)}\n\n` +
      `Use exactly this banner line verbatim after the title:\n${BANNER}\n\n` +
      `Produce the full JSON response.`;

    const body = {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
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
    let parsed: { title?: unknown; markdown?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : {};
    }

    const title =
      typeof parsed.title === "string" && parsed.title.trim()
        ? parsed.title.trim().slice(0, 120)
        : `${moduleLabel} — Starter Data Sheet`;
    let markdown = typeof parsed.markdown === "string" ? parsed.markdown.slice(0, 8000) : "";
    // Enforce the banner even if the model dropped it.
    if (!markdown.includes(BANNER)) {
      markdown = `# ${title}\n\n${BANNER}\n\n${markdown}`;
    }

    return new Response(JSON.stringify({ title, markdown }), { status: 200, headers: corsHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "unknown error" }),
      { status: 500, headers: corsHeaders },
    );
  }
});
