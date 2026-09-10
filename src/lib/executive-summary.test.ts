import { describe, it, expect } from "vitest";
import { getExecutiveSummary, getDefenseReadinessScore } from "./executive-summary";
import type { ComparableStats } from "./comps-analysis";
import type { PreFilingCheckItem } from "./pre-filing-check";

function stats(overrides: Partial<ComparableStats> = {}): ComparableStats {
  return {
    indicated: { min: 4_800_000, median: 5_000_000, max: 5_200_000 },
    adjustedIndicated: null,
    perCompAdjustment: [],
    subjectValue: 5_900_000,
    valuationGapPct: 18,
    confidencePct: 80,
    limitedData: false,
    ranked: [],
    ...overrides,
  };
}

function preFilingItems(missingBlocking = false): PreFilingCheckItem[] {
  return [
    { label: "County", value: "Denton", status: "confirmed", blocking: true },
    {
      label: "Account Number",
      value: missingBlocking ? null : "12345",
      status: missingBlocking ? "missing" : "confirmed",
      blocking: true,
    },
  ];
}

describe("getExecutiveSummary", () => {
  it("returns Insufficient Data when comps are limited/null", () => {
    const s = getExecutiveSummary(null, 5000, [], null);
    expect(s.protestOpportunity).toBe("Insufficient Data");
    expect(s.currentCadValue).toBeNull();
    expect(s.indicatedValueRange).toBeNull();
  });

  it("returns Potentially Overvalued when the gap is positive, matching moduleInsight's >0 threshold", () => {
    const s = getExecutiveSummary(stats({ valuationGapPct: 1 }), 1000, [], null);
    expect(s.protestOpportunity).toBe("Potentially Overvalued");
  });

  it("returns Limited Opportunity when the gap is zero or negative", () => {
    const s = getExecutiveSummary(stats({ valuationGapPct: 0 }), 0, [], null);
    expect(s.protestOpportunity).toBe("Limited Opportunity");
  });

  it("computes potentialValueReduction as subjectValue - median, never negative", () => {
    const s = getExecutiveSummary(stats(), 12000, [], null);
    expect(s.potentialValueReduction).toBe(900_000);
    const under = getExecutiveSummary(
      stats({ subjectValue: 4_000_000, valuationGapPct: -20 }),
      0,
      [],
      null,
    );
    expect(under.potentialValueReduction).toBe(0);
  });

  it("passes the real savings figure through unchanged", () => {
    const s = getExecutiveSummary(stats(), 16200, [], null);
    expect(s.estimatedAnnualSavings).toBe(16200);
  });

  it("computes a real overvaluation dollar/percent range when subject is above the whole comps range", () => {
    // subjectValue 5.9M vs indicated 4.8M-5.2M — same numbers as the
    // reference design this was built to match ($700K-$1.1M, 12%-19%).
    const s = getExecutiveSummary(stats(), 0, [], null);
    expect(s.overvaluationRange).toEqual({
      minDollar: 700_000,
      maxDollar: 1_100_000,
      minPct: 12,
      maxPct: 19,
    });
  });

  it("returns null overvaluationRange when the subject isn't above the whole comps range", () => {
    const s = getExecutiveSummary(stats({ subjectValue: 5_100_000 }), 0, [], null);
    expect(s.overvaluationRange).toBeNull();
  });

  it("rates evidence readiness Strong with zero critical gaps, Limited with 2+", () => {
    const items = [
      { item: "A", importance: "High" as const, availability: "High" as const },
      { item: "B", importance: "Low" as const, availability: "Low" as const },
    ];
    expect(getExecutiveSummary(stats(), 0, items, null).evidenceReadiness).toBe("Strong");

    const oneGap = [
      { item: "A", importance: "High" as const, availability: "Low" as const },
      { item: "B", importance: "Low" as const, availability: "High" as const },
    ];
    expect(getExecutiveSummary(stats(), 0, oneGap, null).evidenceReadiness).toBe("Moderate");

    const twoGaps = [
      { item: "A", importance: "High" as const, availability: "Low" as const },
      { item: "B", importance: "High" as const, availability: "Low" as const },
    ];
    expect(getExecutiveSummary(stats(), 0, twoGaps, null).evidenceReadiness).toBe("Limited");

    expect(getExecutiveSummary(stats(), 0, [], null).evidenceReadiness).toBe("Limited");
  });

  it("rates protest readiness Additional Preparation Needed when pre-filing is blocked", () => {
    const s = getExecutiveSummary(stats(), 0, [], preFilingItems(true));
    expect(s.protestReadiness).toBe("Additional Preparation Needed");
  });

  it("rates protest readiness Ready only when evidence is Strong and pre-filing isn't blocked", () => {
    // A real, non-empty checklist with no critical gaps — an empty [] means
    // "no checklist generated yet" (Limited, not Strong), so this needs at
    // least one real item to actually exercise the Strong path.
    const strongEvidence = [
      { item: "A", importance: "High" as const, availability: "High" as const },
    ];
    const s = getExecutiveSummary(stats(), 0, strongEvidence, preFilingItems(false));
    expect(s.protestReadiness).toBe("Ready");
  });

  it("rates protest readiness Mostly Ready when the evidence checklist hasn't been generated yet", () => {
    // Empty evidence items is "unknown," not "nothing missing" — should
    // never read as Ready even with pre-filing unblocked.
    const s = getExecutiveSummary(stats(), 0, [], preFilingItems(false));
    expect(s.evidenceReadiness).toBe("Limited");
    expect(s.protestReadiness).toBe("Mostly Ready");
  });

  it("rates protest readiness Mostly Ready when no case exists yet (preFilingItems null)", () => {
    const s = getExecutiveSummary(stats(), 0, [], null);
    expect(s.protestReadiness).toBe("Mostly Ready");
  });

  it("blends comps confidence and evidence completeness for overall confidence", () => {
    const items = [
      { item: "A", importance: "High" as const, availability: "High" as const },
      { item: "B", importance: "High" as const, availability: "Low" as const },
    ];
    // confidencePct=80, evidence completeness = (2-1)/2*100 = 50
    // 80*0.6 + 50*0.4 = 48+20 = 68
    const s = getExecutiveSummary(stats({ confidencePct: 80 }), 0, items, null);
    expect(s.overallConfidencePct).toBe(68);
  });
});

describe("getDefenseReadinessScore", () => {
  it("returns null for an empty Q&A list", () => {
    expect(getDefenseReadinessScore([])).toBeNull();
  });

  it("weights Supported=100, Partially Supported=60, Evidence Needed=20, User Input Needed=0", () => {
    const score = getDefenseReadinessScore([
      { status: "Supported" },
      { status: "Partially Supported" },
      { status: "Evidence Needed" },
      { status: "User Input Needed" },
    ]);
    // (100+60+20+0)/4 = 45
    expect(score).toBe(45);
  });

  it("returns 100 when every question is fully supported", () => {
    expect(getDefenseReadinessScore([{ status: "Supported" }, { status: "Supported" }])).toBe(100);
  });
});
