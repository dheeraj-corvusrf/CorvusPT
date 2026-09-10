import { describe, it, expect } from "vitest";
import { computeHealthScore, type HealthScoreSignals } from "./health-score";

function signals(over: Partial<HealthScoreSignals> = {}): HealthScoreSignals {
  return {
    totalValue: 3_000_000,
    landValue: 800_000,
    improvementValue: 2_200_000,
    valueHistory: [
      { year: 2024, total: 2_400_000 },
      { year: 2025, total: 2_700_000 },
      { year: 2026, total: 3_000_000 },
    ],
    assessmentRatio: { medianPct: 1, cod: 17.9, codOverCeiling: 3.6 },
    comps: { count: 5, gapPct: 12 },
    buildingSqft: 6_997,
    evidenceCount: 0,
    ...over,
  };
}

describe("computeHealthScore", () => {
  it("is fully deterministic — same input, same output every call", () => {
    const s = signals();
    const a = computeHealthScore(s);
    const b = computeHealthScore(s);
    const c = computeHealthScore(signals());
    expect(a).toEqual(b);
    expect(a).toEqual(c);
  });

  it("returns an empty low-confidence result when there is no CAD value", () => {
    const r = computeHealthScore(signals({ totalValue: null }));
    expect(r.score).toBe(0);
    expect(r.confidencePct).toBe(25);
    expect(r.dataSufficient).toBe(false);
    expect(r.scoreBreakdown).toEqual([]);
  });

  it("clamps the score to 15..90", () => {
    const high = computeHealthScore(
      signals({
        comps: { count: 8, gapPct: 60 },
        assessmentRatio: { medianPct: 1, cod: 40, codOverCeiling: 30 },
      }),
    );
    expect(high.score).toBeLessThanOrEqual(90);
    const low = computeHealthScore(
      signals({ comps: { count: 5, gapPct: -40 }, assessmentRatio: null, valueHistory: [] }),
    );
    expect(low.score).toBeGreaterThanOrEqual(15);
  });

  it("a bigger comps overvaluation gap raises the score, a negative gap lowers it", () => {
    const base = computeHealthScore(signals({ comps: { count: 5, gapPct: 0 } })).score;
    const over = computeHealthScore(signals({ comps: { count: 5, gapPct: 20 } })).score;
    const under = computeHealthScore(signals({ comps: { count: 5, gapPct: -15 } })).score;
    expect(over).toBeGreaterThan(base);
    expect(under).toBeLessThan(base);
  });

  it("a single input change moves the score only a bounded amount, never drastically", () => {
    const before = computeHealthScore(signals({ comps: { count: 5, gapPct: 10 } })).score;
    const after = computeHealthScore(signals({ comps: { count: 5, gapPct: 12 } })).score;
    expect(Math.abs(after - before)).toBeLessThanOrEqual(4);
  });

  it("confidence is a data-completeness tally — more real data, higher confidence", () => {
    const thin = computeHealthScore(
      signals({
        landValue: null,
        improvementValue: null,
        valueHistory: [],
        assessmentRatio: null,
        comps: null,
        buildingSqft: null,
      }),
    );
    const full = computeHealthScore(signals({ evidenceCount: 2 }));
    expect(thin.confidencePct).toBeLessThan(full.confidencePct);
    expect(thin.confidencePct).toBeGreaterThanOrEqual(25);
    expect(full.confidencePct).toBeLessThanOrEqual(92);
  });

  it("only includes breakdown labels the data can speak to", () => {
    const withComps = computeHealthScore(signals());
    expect(withComps.scoreBreakdown.map((b) => b.label)).toContain("Comparable Properties");

    const noComps = computeHealthScore(signals({ comps: null }));
    expect(noComps.scoreBreakdown.map((b) => b.label)).not.toContain("Comparable Properties");
    expect(noComps.scoreBreakdown.map((b) => b.label)).toContain("CAD Valuation");
  });
});
