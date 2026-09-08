import { describe, it, expect } from "vitest";
import { computeIncomeApproach, incomeSupportsCad, type IncomeFigures } from "./income-approach";

function figures(overrides: Partial<IncomeFigures>): IncomeFigures {
  return {
    grossPotentialIncome: null,
    otherIncome: null,
    vacancyPct: null,
    operatingExpenses: null,
    noiStated: null,
    rentableSqft: null,
    capRatePct: null,
    capRateSource: null,
    documentKinds: [],
    ...overrides,
  };
}

describe("computeIncomeApproach", () => {
  it("runs the full ladder: GPI 1.2M, 10% vacancy, 35% opex, 6.75% cap => ~$10.4M", () => {
    const a = computeIncomeApproach(
      figures({
        grossPotentialIncome: 1_200_000,
        otherIncome: 0,
        vacancyPct: 10,
        operatingExpenses: 378_000,
        capRatePct: 6.75,
        capRateSource: "owner",
        documentKinds: ["P&L"],
      }),
      5_900_000,
    );
    expect(a.vacancyLoss).toBe(120_000);
    expect(a.egi).toBe(1_080_000);
    expect(a.noi).toBe(702_000);
    expect(a.opexRatioPct).toBe(35);
    expect(a.indicatedValue).toBe(Math.round(702_000 / 0.0675)); // 10,400,000
    expect(a.indicatedValue).toBe(10_400_000);
    expect(a.dataComplete).toBe(true);
    expect(a.complete).toBe(true);
    expect(a.gapVsCad).toBe(5_900_000 - 10_400_000);
    expect(a.gapPct).toBeCloseTo(-76.3, 0);
  });

  it("is incomplete with no cap rate: indicatedValue null, complete false", () => {
    const a = computeIncomeApproach(
      figures({
        grossPotentialIncome: 1_200_000,
        vacancyPct: 10,
        operatingExpenses: 378_000,
      }),
      5_900_000,
    );
    expect(a.dataComplete).toBe(true);
    expect(a.hasCapRate).toBe(false);
    expect(a.indicatedValue).toBeNull();
    expect(a.complete).toBe(false);
    expect(a.reliability).toBe("Insufficient");
    expect(a.confidencePct).toBe(0);
  });

  it("is incomplete when a core figure is missing", () => {
    const a = computeIncomeApproach(
      figures({ grossPotentialIncome: 1_000_000, capRatePct: 7 }),
      5_000_000,
    );
    expect(a.dataComplete).toBe(false);
    expect(a.complete).toBe(false);
    expect(a.noi).toBeNull();
  });

  it("falls back to a stated NOI when the expense line is absent, and flags a match", () => {
    const a = computeIncomeApproach(
      figures({
        grossPotentialIncome: 1_000_000,
        vacancyPct: 5,
        operatingExpenses: 300_000,
        noiStated: 640_000,
        capRatePct: 8,
        capRateSource: "appraisal",
        documentKinds: ["P&L", "Appraisal"],
      }),
      7_000_000,
    );
    // computed NOI = (1,000,000 - 50,000) - 300,000 = 650,000; stated 640,000 -> within 5%
    expect(a.noiComputed).toBe(650_000);
    expect(a.noiStated).toBe(640_000);
    expect(a.noiMatchesStated).toBe(true);
    expect(a.noi).toBe(650_000); // ladder wins; stated only cross-checks
    expect(a.indicatedValue).toBe(Math.round(650_000 / 0.08));
    expect(a.confidencePct).toBeGreaterThanOrEqual(85); // 40 +20 P&L +15 appraisal +10 match
  });

  it("uses a stated NOI when the ladder can't be built", () => {
    const a = computeIncomeApproach(
      figures({ noiStated: 500_000, capRatePct: 6.25, capRateSource: "appraisal" }),
      9_000_000,
    );
    expect(a.dataComplete).toBe(false);
    expect(a.noi).toBe(500_000);
    expect(a.indicatedValue).toBe(Math.round(500_000 / 0.0625));
    // dataComplete is false, so complete is false even though NOI/cap exist
    expect(a.complete).toBe(false);
  });
});

describe("incomeSupportsCad", () => {
  it("says does-not-support when CAD is materially above the income indication", () => {
    expect(incomeSupportsCad({ complete: true, indicatedValue: 4_900_000, gapPct: 16.9 })).toBe(
      "does-not-support",
    );
  });
  it("says supports when the gap is within 5%", () => {
    expect(incomeSupportsCad({ complete: true, indicatedValue: 5_800_000, gapPct: 1.7 })).toBe(
      "supports",
    );
  });
  it("says inconclusive when incomplete", () => {
    expect(incomeSupportsCad({ complete: false, indicatedValue: null, gapPct: null })).toBe(
      "inconclusive",
    );
  });
});
