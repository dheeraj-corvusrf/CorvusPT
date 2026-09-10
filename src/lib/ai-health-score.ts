import { invokeEdgeFunction } from "./edge-functions";
import { computeHealthScore } from "./health-score";

export type HealthScoreInput = {
  address?: string;
  cad?: string;
  propertyType?: string;
  landValue?: number;
  improvementValue?: number;
  totalValue?: number;
  taxYear?: number;
  // Real signals fed into the score — same fields, same real sources, as the
  // Strategy module's input (see buildCompsSummary/getAssessmentRatioInfo/
  // buildValueTrend in ai-report.tsx). Never fabricated.
  compsSummary?: { median: number; min: number; max: number; count: number } | null;
  assessmentRatio?: { medianPct: number; cod: number; codOverCeiling: number } | null;
  valueTrend?: { jumpTriggered: boolean; jumpPct: number | null } | null;
  // The actual year-by-year CAD value history (not just the jump flag in
  // valueTrend) so the score can speak to real historical trends instead of
  // reporting them as missing.
  valueHistory?: { year: number; total: number }[];
  evidenceFileNames?: string[];
  // The % gap between the CAD value and the comps' (adjusted) indicated value,
  // straight from computeComparableStats — fed to the deterministic score
  // formula (see computeHealthScore). Null / absent when there are no comps.
  compsGapPct?: number | null;
  // Property detail the app really does have — from the CAD record / the
  // property's AI-fetched base data. Passed so the score stops reporting these
  // as "missing" for the counties whose parcel data carries them. Any field the
  // source didn't provide is simply omitted (never guessed).
  legalDescription?: string | null;
  subdivision?: string | null;
  buildingSqft?: number | null;
  yearBuilt?: number | null;
  buildingClass?: string | null;
  lotSizeAcres?: number | null;
  // Most recent recorded deed/transfer date — NOT a sale price (Texas does not
  // disclose those). Lets the score note recency of ownership change.
  lastTransferDate?: string | null;
};

export type HealthScoreBreakdownEntry = { label: string; score: number };

export type HealthScoreResult = {
  score: number;
  executiveConclusion: string;
  scoreBreakdown: HealthScoreBreakdownEntry[];
  factorsIncreasing: string[];
  factorsReducing: string[];
  confidencePct: number;
  confidenceReasoning: string;
  methodology: string;
  nextStep: string;
  dataSufficient: boolean;
};

// The AI now returns narrative only — score / confidencePct / scoreBreakdown /
// dataSufficient are computed deterministically here (computeHealthScore), so
// they never drift on a refresh.
type HealthScoreProse = Pick<
  HealthScoreResult,
  | "executiveConclusion"
  | "factorsIncreasing"
  | "factorsReducing"
  | "confidenceReasoning"
  | "methodology"
  | "nextStep"
>;

export async function getHealthScore(input: HealthScoreInput): Promise<HealthScoreResult> {
  const computed = computeHealthScore({
    totalValue: input.totalValue ?? null,
    landValue: input.landValue ?? null,
    improvementValue: input.improvementValue ?? null,
    valueHistory: input.valueHistory ?? [],
    assessmentRatio: input.assessmentRatio ?? null,
    comps:
      input.compsSummary != null
        ? { count: input.compsSummary.count, gapPct: input.compsGapPct ?? null }
        : null,
    buildingSqft: input.buildingSqft ?? null,
    evidenceCount: input.evidenceFileNames?.length ?? 0,
  });

  const prose = await invokeEdgeFunction<HealthScoreProse>("ai-health-score", {
    ...input,
    // So the narrative is written to match the gauge, not derive its own.
    computedScore: computed.score,
    computedConfidencePct: computed.confidencePct,
    computedDataSufficient: computed.dataSufficient,
  });

  return { ...computed, ...prose };
}
