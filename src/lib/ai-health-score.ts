import { invokeEdgeFunction } from "./edge-functions";

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

export async function getHealthScore(input: HealthScoreInput): Promise<HealthScoreResult> {
  return invokeEdgeFunction<HealthScoreResult>("ai-health-score", input);
}
