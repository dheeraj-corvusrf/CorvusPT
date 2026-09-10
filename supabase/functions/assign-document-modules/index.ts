// Deploy via CLI: `supabase functions deploy assign-document-modules`.
// Requires the GEMINI_API_KEY secret (shared with the other AI functions).
//
// The user uploads a document once (Documents tab, or a shortcut button in
// an AI Report module). This reads the file's REAL content and returns every
// module / case section it genuinely feeds — one document can serve several
// (a rent roll feeds Income AND Executive Summary; a survey feeds Site AND
// Zoning). The client stores the result in documents.modules (a text[]), and
// every module then reads the shared repository by membership instead of a
// per-module upload. Never invents a module id outside the catalog it's
// given, and returns [] for a file that doesn't clearly feed any of them.
import { GEMINI_MODEL_FAST, geminiUrl } from "../_shared/gemini.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

const MAX_DOCS = 8;

const SYSTEM = `You are CorvusPT's Texas property tax protest assistant. The user uploaded one or more documents to a single central repository. You are given a catalog of "modules" (analyses and case sections), each with a short description of what kind of document it uses. For EACH uploaded document, decide which modules its real content genuinely feeds.

Rules:
- "modules" for a document is an array of catalog ids (the "id" field, copied verbatim). Include every module the document genuinely supports — a single document often feeds several. Include none (empty array) when the document doesn't clearly feed any of them; never force a weak fit.
- Base the decision only on what is actually legible/visible in the document, not on its filename or on what the user might have intended.
- Never invent an id that isn't in the catalog. Never paraphrase an id.
- "evidence" applies to any document the owner would plausibly submit as protest evidence; "executive" applies only when the document would materially move the headline value / savings / recommendation.
- rationale: ONE short sentence naming what the document is and why those modules — e.g. "Rent roll with 2025 actuals; feeds the income approach and the executive summary."
- findings must have exactly one entry per document provided, in the same order, using the exact fileName given for each.
- Return ONLY a JSON object matching this exact shape: {"findings":[{"fileName":"...","modules":["<catalog id>", ...],"rationale":"..."}]}`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { documents, catalog } = await req.json();
    if (!Array.isArray(catalog) || catalog.length === 0) {
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

    const validIds = new Set(
      catalog
        .map((c: { id?: unknown }) => (typeof c.id === "string" ? c.id : null))
        .filter((x: string | null): x is string => !!x),
    );
    const catalogText = catalog
      .filter((c: { id?: unknown }) => typeof c.id === "string")
      .map(
        (c: { id: string; label?: string; needs?: string }) =>
          `- ${c.id}${c.label ? ` (${c.label})` : ""}: ${c.needs ?? ""}`,
      )
      .join("\n");

    const usableDocs = documents
      .slice(0, MAX_DOCS)
      .filter((doc: { dataUrl?: string }) => String(doc.dataUrl ?? "").includes(","));
    if (usableDocs.length === 0) {
      return new Response(JSON.stringify({ error: "Could not read the uploaded file(s)." }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const fileList = usableDocs
      .map(
        (doc: { fileName?: string }, i: number) =>
          `${i + 1}. ${doc.fileName ?? `Document ${i + 1}`}`,
      )
      .join("\n");

    const parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> = [
      {
        text:
          `Module catalog:\n${catalogText}\n\n` +
          `Documents provided, in order:\n${fileList}\n\n` +
          `Analyze each document below (in the same order listed above) and produce the full JSON response.`,
      },
    ];
    for (const doc of usableDocs) {
      const base64 = String(doc.dataUrl ?? "").split(",", 2)[1] ?? "";
      if (!base64) continue;
      parts.push({
        inline_data: { mime_type: doc.mimeType ?? "application/octet-stream", data: base64 },
      });
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
      findings?: Array<{ fileName?: string; modules?: unknown; rationale?: unknown }>;
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : {};
    }

    // Hard-verified against the catalog this call was given — a module id the
    // model returns that isn't a real catalog id is dropped, not stored.
    const findings = Array.isArray(parsed.findings)
      ? parsed.findings.map((f, i) => ({
          fileName: f.fileName ?? usableDocs[i]?.fileName ?? `Document ${i + 1}`,
          modules: Array.isArray(f.modules)
            ? Array.from(
                new Set(
                  f.modules.filter((m): m is string => typeof m === "string" && validIds.has(m)),
                ),
              ).slice(0, catalog.length)
            : [],
          rationale: typeof f.rationale === "string" ? f.rationale.slice(0, 240) : "",
        }))
      : [];

    return new Response(JSON.stringify({ findings }), { status: 200, headers: corsHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "unknown error" }),
      { status: 500, headers: corsHeaders },
    );
  }
});
