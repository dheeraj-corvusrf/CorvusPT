// Deploy via CLI: `supabase functions deploy ai-health-score`.
// Requires the GEMINI_API_KEY secret (shared with the other AI functions).
//
// No Supabase auth check — same known-risk pattern already accepted for the other
// guest-accessible AI functions (classify-document, ask-about-document, route-intent).
import { PROSE_STYLE, STRUCTURED_BULLET_STYLE } from "../_shared/prose-style.ts";
import { GEMINI_MODEL_REASONING, geminiUrl } from "../_shared/gemini.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

type HealthScoreInput = {
  address?: string;
  cad?: string;
  propertyType?: string;
  landValue?: number;
  improvementValue?: number;
  totalValue?: number;
  taxYear?: number;
  // Real signals computed client-side and passed through verbatim into the
  // prompt record — same fields, same source, as the "strategy" module in
  // ai-report-modules/index.ts (buildCompsSummary/getAssessmentRatioInfo/
  // buildValueTrend in ai-report.tsx). None of this is fabricated here.
  compsSummary?: { median: number; min: number; max: number; count: number } | null;
  assessmentRatio?: { medianPct: number; cod: number; codOverCeiling: number } | null;
  valueTrend?: { jumpTriggered: boolean; jumpPct: number | null } | null;
  valueHistory?: { year: number; total: number }[];
  evidenceFileNames?: string[];
  // Property detail the app really has (from the CAD record / AI-fetched base
  // data). Present here means "known" — the prompt must not report it missing.
  legalDescription?: string | null;
  subdivision?: string | null;
  buildingSqft?: number | null;
  yearBuilt?: number | null;
  buildingClass?: string | null;
  lotSizeAcres?: number | null;
  lastTransferDate?: string | null;
  // The protest-opportunity score + analysis confidence, already computed
  // deterministically by CorvusPT from the CAD figures (see
  // src/lib/health-score.ts). This function writes the narrative AROUND them —
  // it does not produce or second-guess them.
  computedScore?: number;
  computedConfidencePct?: number;
  computedDataSufficient?: boolean;
};

const PREAMBLE = `You are CorvusPT's AI property tax analyst for Texas commercial properties.
CorvusPT has ALREADY computed this property's "protest opportunity" score and analysis
confidence deterministically from the official CAD figures below (they appear in the record).
Your job is ONLY to write the short narrative that accompanies those numbers — the takeaway
sentence, the factor lists, and the one-line reasoning/methodology/next-step. Do NOT output a
score or a confidence number, and never contradict the ones given: if the given score is 78,
write as if this is a solid opportunity, not a weak one.

Reason only from what's given plus general knowledge of Texas commercial property appraisal
practice. Do NOT invent specific comparable sale prices, specific building square footage,
specific site defects, or facts not given below.

TEXAS IS A NON-DISCLOSURE STATE. Sale prices, sale dates as prices, and sale-based cap rates
are NEVER public here and can never be obtained — a recorded transfer DATE is the most that
exists. So do NOT list "sale price", "explicit sale price", "recent sale", "market sale data",
or "purchase price" as a missing item, do NOT put it in confidenceReasoning, and do NOT lower
confidencePct because it is absent. Treat market-transaction price data as not-applicable, not
as a gap.

When building area / year built / construction class / lot size ARE given in the record below,
they are KNOWN — never call them missing or say the analysis "lacks property details". Only
name a data gap the owner could actually close by uploading something (a rent roll, an
independent appraisal, condition photos, a survey). If the record already has assessed values,
a multi-year value history, a county ratio study, and comparable properties, confidencePct
should sit in the moderate-to-strong band (roughly 55-80), not the 20s.

${PROSE_STYLE}

${STRUCTURED_BULLET_STYLE}
The word caps in the schema below still apply. These fields stay single sentences (they are one-liners, not lists): executiveConclusion, confidenceReasoning, methodology, nextStep — you may still **bold** the one key number in them. Only factorsIncreasing / factorsReducing are lists, and they are already separate array fields.`;

const str = (v: unknown, len: number): string => (typeof v === "string" ? v.slice(0, len) : "");

const strList = (v: unknown, max: number, len: number): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => x.slice(0, len))
        .slice(0, max)
    : [];

const SCHEMA = `{
"executiveConclusion": "<1-2 short, plain sentences, max ~35 words total — the takeaway:
does this property have a meaningful protest opportunity, and if the data is thin, what's
missing and the one next step. Lead with the fact. Consistent with the given score. No
hedging, no restating numbers the gauge/chips already show>",
"factorsIncreasing": ["<plain phrase, max ~12 words, that makes the protest STRONGER>",
...] (up to 5). Each a bare point, not a sentence — no dollar figures restated, no "warrants
a detailed review" filler, no leading "The property". Style like: "CAD value is higher than
comparable properties", "property has condition issues", "assessment jumped sharply versus
prior years", "assessment ratio above the county norm".
"factorsReducing": ["<plain phrase, max ~12 words, that makes the protest WEAKER or harder
to win>", ...] (up to 5, empty array if none apply). Same terse style. Style like: "strong
comparable assessments nearby", "limited evidence of overvaluation", "county ratio study
shows uniform assessments". Never "no sale price / no recent sale" — that is not obtainable
in Texas and is not a weakness.
"confidenceReasoning": "<ONE short sentence, max ~15 words, naming only a gap the OWNER could
close by uploading (rent roll, appraisal, condition photos, survey). Never mention sale price
or building details that are already given above. Consistent with the given confidence
number.>",
"methodology": "<ONE short sentence, max ~18 words, on how the analysis reads the CAD figures
— e.g. 'compares the CAD value against nearby equity comps and the county ratio study'. Not
model internals.>",
"nextStep": "<ONE short sentence, max ~12 words: the single next action>"
}`;

// Gemini call had no timeout at all before this — a slow/hung response on
// Gemini's end just hung the edge function indefinitely, which is what
// actually surfaced as "the module keeps spinning and I never get results"
// (confirmed live: a plain "reply OK" ping ranged from ~2s to 30s+ with
// nothing on our side to explain the difference — this is external
// congestion, not something a prompt/config change here can fix outright).
// Bounds the worst case to something the client can retry against instead of
// waiting forever; on abort this throws a TimeoutError the catch block below
// turns into a 504 the client already knows to retry (see the 429-retry loop
// in src/lib/edge-functions.ts, extended to also cover 504). Set to 75s to
// match ai-report-modules — gemini-3.1-pro-preview runs slower than flash and
// 45s was clipping calls mid-generation into client-side retry spin.
const GEMINI_TIMEOUT_MS = 75_000;

class TimeoutError extends Error {}

async function fetchWithTimeout(url: string, body: unknown): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new TimeoutError("AI response timed out. Please try again.");
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const input = (await req.json()) as HealthScoreInput;
    if (!input.totalValue) {
      return new Response(JSON.stringify({ error: "totalValue is required" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

    const lines: Array<string | false | undefined> = [
      input.address && `Address: ${input.address}`,
      input.cad && `Appraisal district: ${input.cad}`,
      input.propertyType && `Property type: ${input.propertyType}`,
      input.taxYear && `Tax year: ${input.taxYear}`,
      input.landValue != null && `Land value: $${input.landValue.toLocaleString()}`,
      input.improvementValue != null &&
        `Improvement value: $${input.improvementValue.toLocaleString()}`,
      `Total assessed value: $${input.totalValue.toLocaleString()}`,
      input.legalDescription && `Legal description: ${input.legalDescription}`,
      input.subdivision && `Subdivision: ${input.subdivision}`,
      input.buildingSqft != null &&
        `Building area (per CAD): ${Math.round(input.buildingSqft).toLocaleString()} SF — this IS known, do not report it missing`,
      input.yearBuilt != null &&
        `Year built (per CAD): ${input.yearBuilt} — this IS known, do not report it missing`,
      input.buildingClass &&
        `Construction class (per CAD): ${input.buildingClass} — this IS known, do not report it missing`,
      input.lotSizeAcres != null &&
        `Lot size (per CAD): ${input.lotSizeAcres.toFixed(3).replace(/\.?0+$/, "")} acres`,
      input.lastTransferDate &&
        `Most recent recorded transfer: ${input.lastTransferDate} (a deed date only — Texas does not disclose sale prices, so there is no price to be missing)`,
    ];
    if (input.compsSummary) {
      const c = input.compsSummary;
      lines.push(
        `Real comparable properties found nearby: ${c.count} (market value range ` +
          `$${c.min.toLocaleString()}-$${c.max.toLocaleString()}, median $${c.median.toLocaleString()})`,
      );
    }
    if (input.assessmentRatio) {
      const r = input.assessmentRatio;
      lines.push(
        `County Comptroller ratio study for this property type: median assessment ratio ` +
          `${r.medianPct}%, coefficient of dispersion ${r.cod.toFixed(1)}` +
          (r.codOverCeiling > 0
            ? ` (${r.codOverCeiling.toFixed(1)} points above the IAAO standard)`
            : " (within the IAAO standard)"),
      );
    }
    if (input.valueHistory && input.valueHistory.length > 0) {
      const hist = [...input.valueHistory]
        .filter((h) => h && typeof h.year === "number" && typeof h.total === "number")
        .sort((a, b) => a.year - b.year);
      if (hist.length > 0) {
        lines.push(
          `Assessed value history (from the CAD): ${hist
            .map((h) => `${h.year} $${h.total.toLocaleString()}`)
            .join("; ")}.`,
        );
      }
    }
    if (input.valueTrend?.jumpTriggered) {
      lines.push(
        `This property's assessed value jumped ${
          input.valueTrend.jumpPct != null
            ? `${Math.round(input.valueTrend.jumpPct * 100)}%`
            : "significantly"
        } beyond its own historical trend this year.`,
      );
    }
    if (input.evidenceFileNames && input.evidenceFileNames.length > 0) {
      lines.push(
        `Evidence documents already uploaded by the owner: ${input.evidenceFileNames.join(", ")}`,
      );
    }
    if (input.computedScore != null) {
      lines.push(
        `\nCorvusPT's deterministic protest-opportunity score for this property: ` +
          `${input.computedScore}/100. Analysis confidence: ${input.computedConfidencePct ?? "n/a"}/100. ` +
          `Data ${input.computedDataSufficient === false ? "is thin — say so" : "is sufficient for a responsible read"}. ` +
          `Write your narrative to match these — do not restate them as numbers, and never imply a different level of opportunity or confidence.`,
      );
    }
    const record = lines.filter((l): l is string => typeof l === "string").join("\n");

    const system = `${PREAMBLE}\n\nReturn ONLY a JSON object with exactly this shape:\n${SCHEMA}`;

    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: record }] }],
      // Bounded (not dynamic/unset, and not 0 — this model rejects a budget of
      // exactly 0 with a 400) thinking budget. Investigated live: this task's
      // real-world latency turned out to be dominated by variable congestion on
      // Gemini's own serving infrastructure (a trivial "reply OK" ping ranged
      // from ~2s to a 30s+ timeout with no change on our end) rather than by
      // thinking-token spend itself — but a bounded budget still removes one
      // source of worst-case blowup (an unset/dynamic budget lets the model
      // choose its own, unpredictable spend) and costs nothing when Gemini is
      // responsive normally. See fetchWithTimeout below for the fix that
      // actually addresses the "spins forever" symptom.
      generationConfig: {
        responseMimeType: "application/json",
        // Greedy, seeded decode — the score/confidence numbers are now computed
        // deterministically upstream (src/lib/health-score.ts), but the prose
        // should be steady too: with temperature 0 + topK 1 + topP 0 + a fixed
        // seed, the same record yields the same narrative on a re-run instead
        // of a reworded (occasionally differently-slanted) one.
        temperature: 0,
        topK: 1,
        topP: 0,
        seed: 7,
        thinkingConfig: { thinkingBudget: 2048 },
      },
    };

    const res = await fetchWithTimeout(geminiUrl(GEMINI_MODEL_REASONING, apiKey), body);

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

    // Narrative only — score / confidencePct / scoreBreakdown / dataSufficient
    // are computed deterministically in src/lib/health-score.ts and merged in
    // by getHealthScore(). The char caps are a hard backstop against a single
    // unusually long sentence; the prompt's word counts do the real enforcing.
    const result = {
      executiveConclusion: str(parsed.executiveConclusion, 260),
      factorsIncreasing: strList(parsed.factorsIncreasing, 5, 80),
      factorsReducing: strList(parsed.factorsReducing, 5, 80),
      confidenceReasoning: str(parsed.confidenceReasoning, 140),
      methodology: str(parsed.methodology, 160),
      nextStep: str(parsed.nextStep, 100),
    };

    return new Response(JSON.stringify(result), { status: 200, headers: corsHeaders });
  } catch (err) {
    if (err instanceof TimeoutError) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 504,
        headers: corsHeaders,
      });
    }
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "unknown error" }),
      { status: 500, headers: corsHeaders },
    );
  }
});
