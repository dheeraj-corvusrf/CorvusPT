import { describe, it, expect } from "vitest";
import {
  getEffectiveTaxRate,
  classifyPropertyCategory,
  getBaseReductionPct,
  applyValueTrendAdjustment,
  getAssessmentRatioInfo,
  applyAssessmentRatioAdjustment,
  STATEWIDE_AVERAGE_EFFECTIVE_TAX_RATE,
} from "./texas-tax-rates";

describe("getEffectiveTaxRate", () => {
  it("returns the county-specific rate when one is on file", () => {
    expect(getEffectiveTaxRate("Denton Central Appraisal District")).toBe(0.018);
  });

  it("falls back to the statewide average for an unlisted county (e.g. Dallas)", () => {
    expect(getEffectiveTaxRate("Dallas Central Appraisal District")).toBe(
      STATEWIDE_AVERAGE_EFFECTIVE_TAX_RATE,
    );
  });

  it("falls back to the statewide average for null/undefined", () => {
    expect(getEffectiveTaxRate(null)).toBe(STATEWIDE_AVERAGE_EFFECTIVE_TAX_RATE);
    expect(getEffectiveTaxRate(undefined)).toBe(STATEWIDE_AVERAGE_EFFECTIVE_TAX_RATE);
  });
});

describe("classifyPropertyCategory", () => {
  it("classifies real Comptroller state codes", () => {
    expect(classifyPropertyCategory("A1")).toBe("residential");
    expect(classifyPropertyCategory("C1")).toBe("residential");
    expect(classifyPropertyCategory("F1")).toBe("commercial");
    expect(classifyPropertyCategory("B")).toBe("commercial");
    expect(classifyPropertyCategory("C3")).toBe("commercial");
  });

  it("falls back to keyword matching on free-form CAD text", () => {
    expect(classifyPropertyCategory("Real, Residential Single Family")).toBe("residential");
    expect(classifyPropertyCategory("Real, Commercial - Retail")).toBe("commercial");
  });

  it("returns unknown for empty or unrecognized input", () => {
    expect(classifyPropertyCategory(null)).toBe("unknown");
    expect(classifyPropertyCategory(undefined)).toBe("unknown");
    expect(classifyPropertyCategory("")).toBe("unknown");
    expect(classifyPropertyCategory("Some Unrecognized Wording")).toBe("unknown");
  });
});

describe("getBaseReductionPct", () => {
  it("uses the county+category-specific figure when one exists", () => {
    expect(getBaseReductionPct("Collin Central Appraisal District", "residential")).toBe(0.0475);
    expect(getBaseReductionPct("Collin Central Appraisal District", "commercial")).toBe(0.087);
  });

  it("falls back to the residential/commercial statewide average when the county has no entry for that category", () => {
    // Montgomery only has a commercial figure on file.
    expect(getBaseReductionPct("Montgomery Central Appraisal District", "residential")).toBe(0.079);
  });

  it("falls back to the unknown-category midpoint for an unrecognized county+category", () => {
    expect(getBaseReductionPct("Some Other CAD", "unknown")).toBeCloseTo((0.079 + 0.0526) / 2);
  });
});

describe("applyValueTrendAdjustment", () => {
  it("returns the base rate unchanged with no history", () => {
    const result = applyValueTrendAdjustment(0.05, null);
    expect(result).toEqual({
      reductionPct: 0.05,
      jumpTriggered: false,
      jumpPct: null,
      trailingCagrPct: null,
    });
  });

  it("returns the base rate unchanged with fewer than 2 valid years", () => {
    const result = applyValueTrendAdjustment(0.05, [{ year: 2024, value: 100000 }]);
    expect(result.jumpTriggered).toBe(false);
  });

  it("boosts the reduction when a 2-year jump exceeds the flat 10% threshold", () => {
    const result = applyValueTrendAdjustment(0.05, [
      { year: 2023, value: 100000 },
      { year: 2024, value: 115000 }, // +15%
    ]);
    expect(result.jumpTriggered).toBe(true);
    expect(result.jumpPct).toBeCloseTo(0.15);
    // boosted = min(0.15, max(0.10, 0.05 + 0.03)) = 0.10 (floor applies)
    expect(result.reductionPct).toBeCloseTo(0.1);
  });

  it("does not trigger when the jump is within the flat threshold (2-year history)", () => {
    const result = applyValueTrendAdjustment(0.05, [
      { year: 2023, value: 100000 },
      { year: 2024, value: 105000 }, // +5%
    ]);
    expect(result.jumpTriggered).toBe(false);
    expect(result.reductionPct).toBe(0.05);
  });

  it("compares against the property's own trailing CAGR with 3+ years of history", () => {
    // Trailing (2020->2023) grows steadily ~5%/year; the latest jump to 2024
    // is +20%, well above trailing+10%, so it should trigger.
    const result = applyValueTrendAdjustment(0.04, [
      { year: 2020, value: 100000 },
      { year: 2021, value: 105000 },
      { year: 2022, value: 110250 },
      { year: 2023, value: 115763 },
      { year: 2024, value: 138915 }, // +20% over 2023
    ]);
    expect(result.trailingCagrPct).not.toBeNull();
    expect(result.jumpTriggered).toBe(true);
    expect(result.reductionPct).toBeGreaterThanOrEqual(0.1);
    expect(result.reductionPct).toBeLessThanOrEqual(0.15);
  });

  it("does not trigger when the latest jump merely matches the property's own historical trend", () => {
    // Consistent ~10%/year growth every year, including the latest — this is
    // "normal for this property," not an anomaly.
    const result = applyValueTrendAdjustment(0.04, [
      { year: 2020, value: 100000 },
      { year: 2021, value: 110000 },
      { year: 2022, value: 121000 },
      { year: 2023, value: 133100 },
      { year: 2024, value: 146410 },
    ]);
    expect(result.jumpTriggered).toBe(false);
    expect(result.reductionPct).toBe(0.04);
  });

  it("ignores years with null/zero values and sorts out of order input", () => {
    const result = applyValueTrendAdjustment(0.05, [
      { year: 2024, value: 115000 },
      { year: 2023, value: 100000 },
      { year: 2022, value: null },
    ]);
    expect(result.jumpPct).toBeCloseTo(0.15);
  });

  it("caps the boosted reduction at the ceiling even for an extreme jump", () => {
    const result = applyValueTrendAdjustment(0.2, [
      { year: 2023, value: 100000 },
      { year: 2024, value: 200000 }, // +100%
    ]);
    expect(result.reductionPct).toBe(0.15);
  });
});

describe("getAssessmentRatioInfo / applyAssessmentRatioAdjustment", () => {
  it("returns null for an unknown category or missing cad", () => {
    expect(getAssessmentRatioInfo("Collin Central Appraisal District", "unknown")).toBeNull();
    expect(getAssessmentRatioInfo(null, "residential")).toBeNull();
  });

  it("returns null for a county/category with no published ratio study", () => {
    expect(getAssessmentRatioInfo("Some Other CAD", "residential")).toBeNull();
  });

  it("computes codOverCeiling above the IAAO ceiling, zero when within it", () => {
    // Collin residential COD 4.41, ceiling 15.0 -> well within, codOverCeiling 0
    const withinStandard = getAssessmentRatioInfo(
      "Collin Central Appraisal District",
      "residential",
    );
    expect(withinStandard).toEqual({ medianPct: 1.0, cod: 4.41, codOverCeiling: 0 });

    // Denton commercial COD 17.96, ceiling 20.0 -> still within, 0
    const denton = getAssessmentRatioInfo("Denton Central Appraisal District", "commercial");
    expect(denton?.codOverCeiling).toBe(0);

    // Tarrant residential COD 10.14, ceiling 15.0 -> within, 0
    const tarrant = getAssessmentRatioInfo("Tarrant Appraisal District", "residential");
    expect(tarrant?.codOverCeiling).toBe(0);
  });

  it("applyAssessmentRatioAdjustment adds nothing when there's no ratio info or the county is within standard", () => {
    expect(applyAssessmentRatioAdjustment(0.05, null)).toBe(0.05);
    const within = getAssessmentRatioInfo("Collin Central Appraisal District", "residential");
    expect(applyAssessmentRatioAdjustment(0.05, within)).toBe(0.05);
  });

  it("applyAssessmentRatioAdjustment adds a bounded nudge when COD exceeds the ceiling, capped", () => {
    const overCeiling = { medianPct: 1.0, cod: 50, codOverCeiling: 35 };
    // 35 * 0.0015 = 0.0525, capped at 0.02
    expect(applyAssessmentRatioAdjustment(0.05, overCeiling)).toBeCloseTo(0.07);
  });
});
