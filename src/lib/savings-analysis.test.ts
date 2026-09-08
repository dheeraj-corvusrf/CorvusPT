import { describe, it, expect } from "vitest";
import { computeSavingsAnalysis, EMPTY_TAX_INPUTS } from "./savings-analysis";
import type { SavingsEstimate } from "./savings-estimate";

const compsEstimate: SavingsEstimate = {
  basis: "comps",
  amount: 18000,
  compsCount: 4,
  compsMedian: 5_200_000,
  effectiveTaxRatePct: 1.8,
};

const formulaEstimate: SavingsEstimate = {
  basis: "formula",
  amount: 12000,
  reductionPct: 12,
  effectiveTaxRatePct: 1.8,
  rationale: "test",
};

describe("computeSavingsAnalysis", () => {
  it("comps case: distinct Low/Base/High, ROI and multiple present", () => {
    const a = computeSavingsAnalysis({
      cadValue: 5_900_000,
      taxYear: 2026,
      cad: "Denton Central Appraisal District", // county-specific 1.8%
      estimate: compsEstimate,
      compsIndicated: { min: 4_800_000, median: 5_200_000, max: 5_600_000 },
      taxInputs: EMPTY_TAX_INPUTS,
    });
    expect(a.sufficient).toBe(true);
    expect(a.indicatedValue).toBe(5_200_000);
    expect(a.indicatedRange).toEqual({ low: 4_800_000, high: 5_600_000 });
    expect(a.reductionBase).toBe(700_000); // 5.9M - 5.2M
    // scenarios: low = 5.9-5.6 = 300k, base = 700k, high = 5.9-4.8 = 1.1M
    expect(a.scenarios.map((s) => s.valueReduction)).toEqual([300_000, 700_000, 1_100_000]);
    expect(a.scenarios[0].annualSavings).toBeLessThan(a.scenarios[2].annualSavings);
    expect(a.annualSavings).toBe(Math.round(700_000 * 0.018)); // 12,600
    expect(a.protestCostSource).toBe("contingency");
    expect(a.protestCost).toBe(Math.round(a.annualSavings * 0.25));
    expect(a.netBenefit).toBe(a.annualSavings - a.protestCost);
    expect(a.roiPct).toBe(Math.round((a.netBenefit / a.protestCost) * 100));
    expect(a.savingsToCostMultiple).toBeCloseTo(4, 1); // 1 / 0.25
    expect(a.valuationConfidence).toBe("High");
    expect(a.multiYearSavings).toBe(a.annualSavings * 3);
  });

  it("formula case: modeled band, no indicated range, Moderate valuation confidence", () => {
    const a = computeSavingsAnalysis({
      cadValue: 3_100_000,
      taxYear: 2026,
      cad: "Tarrant Appraisal District",
      estimate: formulaEstimate,
      compsIndicated: null,
      taxInputs: EMPTY_TAX_INPUTS,
    });
    expect(a.sufficient).toBe(true);
    expect(a.indicatedRange).toBeNull();
    expect(a.reductionBase).toBe(Math.round(3_100_000 * 0.12)); // 372,000
    // band: low = base*0.6, high = base*1.5
    expect(a.scenarios[0].valueReduction).toBe(Math.round(a.reductionBase * 0.6));
    expect(a.scenarios[2].valueReduction).toBe(Math.round(a.reductionBase * 1.5));
    expect(a.valuationConfidence).toBe("Moderate");
  });

  it("$0 protest cost override: multiple/ROI null, source none, financial confidence downgraded", () => {
    const a = computeSavingsAnalysis({
      cadValue: 5_900_000,
      taxYear: 2026,
      cad: "Denton Central Appraisal District",
      estimate: compsEstimate,
      compsIndicated: { min: 4_800_000, median: 5_200_000, max: 5_600_000 },
      taxInputs: { ...EMPTY_TAX_INPUTS, protestCostOverride: 0 },
    });
    expect(a.protestCost).toBe(0);
    expect(a.protestCostSource).toBe("none");
    expect(a.roiPct).toBeNull();
    expect(a.savingsToCostMultiple).toBeNull();
    expect(a.netBenefit).toBe(a.annualSavings);
    // valuation High + taxData Moderate => Moderate, then -1 for "none" => Limited
    expect(a.financialConfidence).toBe("Limited");
  });

  it("taxable value above CAD value is flagged as a conflict but still renders", () => {
    const a = computeSavingsAnalysis({
      cadValue: 3_100_000,
      taxYear: 2026,
      cad: "Tarrant Appraisal District",
      estimate: formulaEstimate,
      compsIndicated: null,
      taxInputs: { ...EMPTY_TAX_INPUTS, taxableValue: 4_000_000 },
    });
    expect(a.sufficient).toBe(true);
    expect(a.conflicts.length).toBeGreaterThan(0);
    expect(a.conflicts[0]).toMatch(/higher than the CAD appraised value/);
  });

  it("missing tax year => not sufficient, names it, no headline savings", () => {
    const a = computeSavingsAnalysis({
      cadValue: 3_100_000,
      taxYear: null,
      cad: "Tarrant Appraisal District",
      estimate: formulaEstimate,
      compsIndicated: null,
      taxInputs: EMPTY_TAX_INPUTS,
    });
    expect(a.sufficient).toBe(false);
    expect(a.missing).toContain("Tax year for the calculation");
  });

  it("statewide-average rate county => Limited tax-data confidence + assumption note", () => {
    const a = computeSavingsAnalysis({
      cadValue: 3_100_000,
      taxYear: 2026,
      cad: "Dallas Central Appraisal District", // not in COUNTY_EFFECTIVE_TAX_RATE
      estimate: formulaEstimate,
      compsIndicated: null,
      taxInputs: EMPTY_TAX_INPUTS,
    });
    expect(a.taxRate.countySpecific).toBe(false);
    expect(a.taxDataConfidence).toBe("Limited");
    expect(a.assumptions.some((s) => /statewide average/.test(s))).toBe(true);
  });
});
