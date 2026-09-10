// Deterministic Executive Summary + Defense Readiness Score for Module 10 —
// real inputs already computed elsewhere on the page (Module 3's comps
// stats, Module 9's savings estimate, Module 8's evidence checklist, the
// Pre-Filing Check), never a second guess at a number the AI could get
// wrong. Same convention as comps-analysis.ts/pre-filing-check.ts: pure
// functions, real math, documented formula, no AI call.
import type { ComparableStats } from "./comps-analysis";
import { isBlockingUnresolved, type PreFilingCheckItem } from "./pre-filing-check";

export type ProtestOpportunity =
  "Potentially Overvalued" | "Limited Opportunity" | "Insufficient Data";
export type ReadinessLevel = "Strong" | "Moderate" | "Limited";
export type ProtestReadiness = "Ready" | "Mostly Ready" | "Additional Preparation Needed";

export type ExecutiveSummary = {
  protestOpportunity: ProtestOpportunity;
  currentCadValue: number | null;
  // Real comps-derived range (Module 3's own "Market Value Range") — kept
  // under that same name here rather than the more common "AI value range"
  // phrasing, since it's genuinely comps math, not an AI guess.
  indicatedValueRange: { min: number; max: number } | null;
  potentialValueReduction: number | null;
  // Real best-case/worst-case overvaluation band — subject value minus the
  // top of the comps range (least overvalued) to subject value minus the
  // bottom (most overvalued). Only populated when the subject genuinely
  // sits above the whole comps range (not just the median); null — not a
  // fabricated range — otherwise.
  overvaluationRange: {
    minDollar: number;
    maxDollar: number;
    minPct: number;
    maxPct: number;
  } | null;
  estimatedAnnualSavings: number | null;
  overallConfidencePct: number | null;
  evidenceReadiness: ReadinessLevel;
  protestReadiness: ProtestReadiness;
};

export function getExecutiveSummary(
  stats: ComparableStats | null,
  estimatedSavings: number | null,
  evidenceItems: { item: string; importance: "High" | "Low"; availability: "High" | "Low" }[],
  preFilingItems: PreFilingCheckItem[] | null,
): ExecutiveSummary {
  const currentCadValue = stats?.subjectValue ?? null;
  const indicatedValueRange = stats?.indicated
    ? { min: stats.indicated.min, max: stats.indicated.max }
    : null;
  const potentialValueReduction =
    stats?.indicated && stats.subjectValue != null
      ? Math.max(0, Math.round(stats.subjectValue - stats.indicated.median))
      : null;
  const overvaluationRange =
    stats?.indicated && stats.subjectValue != null && stats.subjectValue > stats.indicated.max
      ? {
          minDollar: Math.round(stats.subjectValue - stats.indicated.max),
          maxDollar: Math.round(stats.subjectValue - stats.indicated.min),
          minPct: Math.round(
            ((stats.subjectValue - stats.indicated.max) / stats.subjectValue) * 100,
          ),
          maxPct: Math.round(
            ((stats.subjectValue - stats.indicated.min) / stats.subjectValue) * 100,
          ),
        }
      : null;

  // Same >0 threshold moduleInsight()'s own "comps" case already uses for
  // the "Potential Overvaluation" banner (src/routes/ai-report.tsx) — this
  // reads consistently with what Module 3's own card already tells the user,
  // not a different cutoff invented for this summary alone.
  const protestOpportunity: ProtestOpportunity =
    !stats || stats.limitedData || stats.valuationGapPct == null
      ? "Insufficient Data"
      : stats.valuationGapPct > 0
        ? "Potentially Overvalued"
        : "Limited Opportunity";

  const criticalGaps = evidenceItems.filter(
    (i) => i.importance === "High" && i.availability === "Low",
  ).length;
  const evidenceReadiness: ReadinessLevel =
    evidenceItems.length === 0
      ? "Limited"
      : criticalGaps === 0
        ? "Strong"
        : criticalGaps <= 1
          ? "Moderate"
          : "Limited";

  const preFilingBlocked = preFilingItems ? preFilingItems.some(isBlockingUnresolved) : null;
  const protestReadiness: ProtestReadiness =
    preFilingBlocked === true
      ? "Additional Preparation Needed"
      : evidenceReadiness === "Strong" && preFilingBlocked === false
        ? "Ready"
        : "Mostly Ready";

  // Blends real comps confidence with real evidence completeness — same
  // bounded-35-95-style real-signal blend computeComparableStats() already
  // uses for its own confidencePct, so this reads on the same scale rather
  // than a differently-calibrated number.
  const evidenceCompletenessPct =
    evidenceItems.length > 0
      ? Math.round(((evidenceItems.length - criticalGaps) / evidenceItems.length) * 100)
      : null;
  const overallConfidencePct =
    stats?.confidencePct != null && evidenceCompletenessPct != null
      ? Math.round(stats.confidencePct * 0.6 + evidenceCompletenessPct * 0.4)
      : (stats?.confidencePct ?? evidenceCompletenessPct ?? null);

  return {
    protestOpportunity,
    currentCadValue,
    indicatedValueRange,
    potentialValueReduction,
    overvaluationRange,
    estimatedAnnualSavings: estimatedSavings,
    overallConfidencePct,
    evidenceReadiness,
    protestReadiness,
  };
}

// Weighted average over the AI's OWN per-question status classifications —
// this score itself is never AI-generated (matches the spec's "preparedness
// score, not a probability of winning" framing, and this app's established
// pattern of computing scores from real signals rather than asking a model
// to grade its own work).
const STATUS_WEIGHT: Record<string, number> = {
  Supported: 100,
  "Partially Supported": 60,
  "Evidence Needed": 20,
  "User Input Needed": 0,
};

export function getDefenseReadinessScore(defenseQA: { status: string }[]): number | null {
  if (defenseQA.length === 0) return null;
  const total = defenseQA.reduce((sum, qa) => sum + (STATUS_WEIGHT[qa.status] ?? 0), 0);
  return Math.round(total / defenseQA.length);
}
