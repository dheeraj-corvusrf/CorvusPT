// Deploy via CLI: `supabase functions deploy ai-health-score`.
// Requires the GEMINI_API_KEY secret (shared with the other AI functions).
//
// No Supabase auth check — same known-risk pattern already accepted for the other
// guest-accessible AI functions (classify-document, ask-about-document, route-intent).
import { PROSE_STYLE } from "../_shared/prose-style.ts";
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
};

const PREAMBLE = `You are CorvusPT's AI property tax analyst for Texas commercial properties.
Given only the official CAD (county appraisal district) record below, produce a "protest
opportunity" health score for this property.

Reason only from what's given plus general knowledge of Texas commercial property appraisal
practice. Do NOT invent specific comparable sale prices, specific building square footage,
specific site defects, or facts not given below — if you don't have enough information for a
factor, say so (set dataSufficient to false and explain what's missing) rather than fabricating
a number.

${PROSE_STYLE}`;

const str = (v: unknown, len: number): string => (typeof v === "string" ? v.slice(0, len) : "");

const score100 = (v: unknown, fallback = 50): number =>
  Math.max(0, Math.min(100, Math.round(Number(v)) || fallback));

const strList = (v: unknown, max: number, len: number): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => x.slice(0, len))
        .slice(0, max)
    : [];

// Only the factor labels a CAD record (plus the real signals above) can
// actually speak to — the AI picks whichever subset genuinely applies here
// rather than always returning all 5, so a property with no real comps data
// doesn't get a fabricated "Comparable Properties" score.
const BREAKDOWN_LABELS = [
  "CAD Valuation",
  "Comparable Properties",
  "Market Data",
  "Property Condition",
  "Historical Valuation",
];

type BreakdownEntry = { label: string; score: number };

const scoreBreakdown = (v: unknown): BreakdownEntry[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
        .map((x) => ({ label: str(x.label, 40), score: score100(x.score) }))
        .filter((x) => x.label.length > 0 && BREAKDOWN_LABELS.includes(x.label))
        .slice(0, 5)
    : [];

const SCHEMA = `{"score": <integer 0-100, higher = stronger protest opportunity>,
"executiveConclusion": "<1-2 short, plain sentences, max ~35 words total — the takeaway:
does this property have a meaningful protest opportunity, and if the data is thin, what's
missing and the one next step. Lead with the fact. No hedging, no restating numbers the
gauge/chips already show>",
"scoreBreakdown": [{"label": "<one of: ${BREAKDOWN_LABELS.join(" | ")}>", "score": <integer
0-100>}, ...] (only include labels the given data can actually speak to),
"factorsIncreasing": ["<plain phrase, max ~12 words, that makes the protest STRONGER>",
...] (up to 5). Each a bare point, not a sentence — no dollar figures restated, no "warrants
a detailed review" filler, no leading "The property". Style like: "CAD value is higher than
comparable properties", "property has condition issues", "assessment jumped sharply versus
prior years", "assessment ratio above the county norm".
"factorsReducing": ["<plain phrase, max ~12 words, that makes the protest WEAKER or harder
to win>", ...] (up to 5, empty array if none apply). Same terse style. Style like: "strong
comparable assessments nearby", "recent sale supports the CAD value", "limited evidence of
overvaluation", "county ratio study shows uniform assessments".
"confidencePct": <integer 0-100, how confident this analysis is given the data actually
available>,
"confidenceReasoning": "<ONE short sentence, max ~15 words, naming what's missing — not a
list, the UI already shows what data was pulled elsewhere>",
"methodology": "<ONE short sentence, max ~18 words, on how the score was reached — not
model internals>",
"nextStep": "<ONE short sentence, max ~12 words: the single next action>",
"dataSufficient": <true|false — false if there's genuinely too little data for a responsible
score>}`;

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
        // Without this the model samples at its default temperature, so the
        // same CAD record scored 50 ("Moderate Opportunity", 30% confidence)
        // on one refresh and 85 ("Strong Opportunity", 55%) on the next.
        // Every other AI function here already pins temperature 0 — this one
        // was the outlier. Same input -> same score now.
        temperature: 0,
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

    const result = {
      score: score100(parsed.score, 0),
      // Caps tightened alongside the SCHEMA's own word-count instructions
      // above (500/300/500/200 chars was enough room for the paragraphs
      // the old "2-3 sentences" instructions produced — these are a hard
      // backstop against a single unusually long sentence, not the actual
      // enforcement, which the prompt's word counts do).
      executiveConclusion: str(parsed.executiveConclusion, 260),
      scoreBreakdown: scoreBreakdown(parsed.scoreBreakdown),
      factorsIncreasing: strList(parsed.factorsIncreasing, 5, 80),
      factorsReducing: strList(parsed.factorsReducing, 5, 80),
      confidencePct: score100(parsed.confidencePct),
      confidenceReasoning: str(parsed.confidenceReasoning, 140),
      methodology: str(parsed.methodology, 160),
      nextStep: str(parsed.nextStep, 100),
      dataSufficient: parsed.dataSufficient !== false,
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
