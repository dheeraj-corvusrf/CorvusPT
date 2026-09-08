// Deterministic, no-AI financial-opportunity analysis for Module 9
// (Estimated Savings). Consumes the existing estimateSavings() output plus
// Module 3's comparable-sales range plus optional owner-supplied tax inputs,
// and produces the full picture: value → reduction → annual savings, three
// scenarios, ROI / net benefit / savings-to-cost multiple, a labelled
// multi-year estimate, three confidence readings, stated assumptions, and
// data-validation flags. NOTHING here is an AI value — the same inputs
// always produce the same output, including across a page refresh.
import type { SavingsEstimate } from "./savings-estimate";
import { getTaxRateMeta } from "./texas-tax-rates";

// CorvusPT's real fee — a 25% contingency of first-year savings, from the
// Service Agreement (ProtestAuthorizationFlow's AGREEMENT). Mirrors
// CONTINGENCY_FEE_PCT in ai-report.tsx.
const CONTINGENCY_PCT = 0.25;

export type SavingsTaxInputs = {
  taxableValue: number | null;
  exemptionsTotal: number | null;
  // null => use the contingency estimate; 0 => explicitly "no direct cost"
  // (owner-managed / DIY); > 0 => a flat cost the owner entered.
  protestCostOverride: number | null;
  projectionYears: number | null;
};

export const EMPTY_TAX_INPUTS: SavingsTaxInputs = {
  taxableValue: null,
  exemptionsTotal: null,
  protestCostOverride: null,
  projectionYears: null,
};

export type SavingsConfidence = "High" | "Moderate" | "Limited";

export type SavingsScenario = {
  key: "low" | "base" | "high";
  label: string;
  reductionPct: number;
  valueReduction: number;
  annualSavings: number;
};

export type SavingsAnalysis = {
  sufficient: boolean;
  missing: string[];
  conflicts: string[];

  cadValue: number;
  taxYear: number | null;
  indicatedValue: number;
  indicatedRange: { low: number; high: number } | null;
  valueBasisLabel: string;

  taxRate: {
    pct: number;
    unit: "decimal";
    source: string;
    effectiveYear: number;
    countySpecific: boolean;
  };
  taxableValueUsed: number;
  taxableValueAssumed: boolean;
  exemptionsApplied: number;

  reductionBase: number;
  reductionPct: number;
  annualSavings: number;
  scenarios: SavingsScenario[];

  protestCost: number;
  protestCostSource: "contingency" | "override" | "none";
  netBenefit: number;
  savingsToCostMultiple: number | null;
  roiPct: number | null;

  projectionYears: number;
  multiYearSavings: number | null;

  valuationConfidence: SavingsConfidence;
  taxDataConfidence: SavingsConfidence;
  financialConfidence: SavingsConfidence;

  assumptions: string[];
};

const RANK: Record<SavingsConfidence, number> = { Limited: 0, Moderate: 1, High: 2 };
const FROM_RANK: SavingsConfidence[] = ["Limited", "Moderate", "High"];
const num = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const money = (v: number) => `$${Math.round(v).toLocaleString()}`;
const round1 = (v: number) => Math.round(v * 10) / 10;

export function computeSavingsAnalysis(args: {
  cadValue: number | null;
  taxYear: number | null;
  cad: string | null;
  estimate: SavingsEstimate;
  compsIndicated: { min: number; median: number; max: number } | null;
  taxInputs: SavingsTaxInputs;
}): SavingsAnalysis {
  const { taxYear, cad, estimate, compsIndicated, taxInputs } = args;
  const cadValue = num(args.cadValue) ?? 0;
  const rateMeta = getTaxRateMeta(cad);
  const rate = rateMeta.rate;

  // ── validation ────────────────────────────────────────────────────────
  const missing: string[] = [];
  if (cadValue <= 0) missing.push("Current CAD appraised value");
  if (!estimate) {
    missing.push("A valid valuation indication (comparable sales or protest-outcome model)");
  }
  if (taxYear == null) missing.push("Tax year for the calculation");

  const exemptionsApplied = num(taxInputs.exemptionsTotal) ?? 0;
  const providedTaxable = num(taxInputs.taxableValue);
  const overrideRaw = num(taxInputs.protestCostOverride);
  const projectionYears = Math.max(
    1,
    Math.min(10, Math.round(num(taxInputs.projectionYears) ?? 3)),
  );

  const conflicts: string[] = [];
  if (providedTaxable != null && cadValue > 0 && providedTaxable > cadValue) {
    conflicts.push(
      `Taxable value entered (${money(providedTaxable)}) is higher than the CAD appraised value (${money(cadValue)}).`,
    );
  }
  if (overrideRaw != null && overrideRaw < 0) {
    conflicts.push("Protest cost override is negative.");
  }
  if (exemptionsApplied > 0 && cadValue > 0 && exemptionsApplied >= cadValue) {
    conflicts.push(
      `Exemptions entered (${money(exemptionsApplied)}) meet or exceed the appraised value.`,
    );
  }

  // ── base indication ──────────────────────────────────────────────────
  const valueBasisLabel = !estimate
    ? "unavailable"
    : estimate.basis === "comps"
      ? "comparable sales"
      : "county / category protest-outcome model";

  let indicatedValue = cadValue;
  if (estimate?.basis === "comps") {
    indicatedValue = Math.max(0, Math.round(estimate.compsMedian));
  } else if (estimate?.basis === "formula") {
    indicatedValue = Math.max(0, Math.round(cadValue * (1 - estimate.reductionPct / 100)));
  }

  const clampRed = (r: number) => Math.max(0, Math.min(cadValue, Math.round(r)));
  const reductionBase = clampRed(cadValue - indicatedValue);
  const reductionPct = cadValue > 0 ? round1((reductionBase / cadValue) * 100) : 0;

  const taxableValueUsed = Math.max(0, providedTaxable ?? cadValue - exemptionsApplied);
  const taxableValueAssumed = providedTaxable == null;

  const savingsFor = (valueReduction: number) =>
    Math.round(Math.min(valueReduction, taxableValueUsed) * rate);

  // ── scenarios ───────────────────────────────────────────────────────
  let lowRed: number, highRed: number;
  let indicatedRange: { low: number; high: number } | null = null;
  if (compsIndicated) {
    lowRed = clampRed(cadValue - compsIndicated.max); // highest comp value -> smallest reduction
    highRed = clampRed(cadValue - compsIndicated.min); // lowest comp value -> biggest reduction
    indicatedRange = {
      low: Math.max(0, Math.round(compsIndicated.min)),
      high: Math.max(0, Math.round(compsIndicated.max)),
    };
  } else {
    lowRed = clampRed(reductionBase * 0.6);
    highRed = clampRed(reductionBase * 1.5);
  }
  const scenarioRow = (
    key: SavingsScenario["key"],
    label: string,
    valueReduction: number,
  ): SavingsScenario => ({
    key,
    label,
    valueReduction,
    reductionPct: cadValue > 0 ? round1((valueReduction / cadValue) * 100) : 0,
    annualSavings: savingsFor(valueReduction),
  });
  const scenarios: SavingsScenario[] = [
    scenarioRow("low", "Low", Math.min(lowRed, reductionBase, highRed)),
    scenarioRow("base", "Base", reductionBase),
    scenarioRow("high", "High", Math.max(highRed, reductionBase, lowRed)),
  ];
  const annualSavings = scenarios[1].annualSavings;

  // ── protest economics ───────────────────────────────────────────────
  let protestCost: number;
  let protestCostSource: SavingsAnalysis["protestCostSource"];
  if (overrideRaw != null) {
    protestCost = Math.max(0, Math.round(overrideRaw));
    protestCostSource = protestCost === 0 ? "none" : "override";
  } else {
    protestCost = Math.round(annualSavings * CONTINGENCY_PCT);
    protestCostSource = "contingency";
  }
  const netBenefit = annualSavings - protestCost;
  const savingsToCostMultiple = protestCost > 0 ? round1(annualSavings / protestCost) : null;
  const roiPct = protestCost > 0 ? Math.round((netBenefit / protestCost) * 100) : null;
  const multiYearSavings = annualSavings > 0 ? annualSavings * projectionYears : null;

  // ── confidence ──────────────────────────────────────────────────────
  const valuationConfidence: SavingsConfidence = !estimate
    ? "Limited"
    : compsIndicated
      ? "High"
      : rateMeta.countySpecific
        ? "Moderate"
        : "Limited";
  const taxDataConfidence: SavingsConfidence =
    providedTaxable != null ? "High" : rateMeta.countySpecific ? "Moderate" : "Limited";
  let financialRank = Math.min(RANK[valuationConfidence], RANK[taxDataConfidence]);
  if (protestCostSource === "none") financialRank = Math.max(0, financialRank - 1);
  const financialConfidence = FROM_RANK[financialRank];

  // ── assumptions ─────────────────────────────────────────────────────
  const assumptions: string[] = [
    `Value reduction basis: ${valueBasisLabel}.`,
    taxableValueAssumed
      ? `Taxable value assumed equal to the appraised value (${money(taxableValueUsed)})${
          exemptionsApplied > 0
            ? `, less ${money(exemptionsApplied)} in exemptions you entered`
            : "; no exemptions or caps on file"
        }.`
      : `Taxable value ${money(taxableValueUsed)} as you provided.`,
    `Combined property tax rate ${rateMeta.pct}% (${rateMeta.source}, effective ${rateMeta.effectiveYear})${
      rateMeta.countySpecific ? "" : " — a statewide average, not this county's specific rate"
    }.`,
    protestCostSource === "contingency"
      ? "Protest cost estimated at 25% of first-year savings (CorvusPT's contingency fee)."
      : protestCostSource === "override"
        ? `Protest cost ${money(protestCost)} as you entered.`
        : "Protest cost not entered — owner-managed / DIY assumed ($0).",
  ];
  if (multiYearSavings != null) {
    assumptions.push(
      `Multi-year figure = annual savings x ${projectionYears} years; assumes the reduced value holds as the base. Actual carry-over depends on the county's re-appraisal.`,
    );
  }

  return {
    sufficient: missing.length === 0,
    missing,
    conflicts,
    cadValue,
    taxYear,
    indicatedValue,
    indicatedRange,
    valueBasisLabel,
    taxRate: {
      pct: rateMeta.pct,
      unit: "decimal",
      source: rateMeta.source,
      effectiveYear: rateMeta.effectiveYear,
      countySpecific: rateMeta.countySpecific,
    },
    taxableValueUsed,
    taxableValueAssumed,
    exemptionsApplied,
    reductionBase,
    reductionPct,
    annualSavings,
    scenarios,
    protestCost,
    protestCostSource,
    netBenefit,
    savingsToCostMultiple,
    roiPct,
    projectionYears,
    multiYearSavings,
    valuationConfidence,
    taxDataConfidence,
    financialConfidence,
    assumptions,
  };
}
