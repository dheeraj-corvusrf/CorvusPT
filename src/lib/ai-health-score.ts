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
