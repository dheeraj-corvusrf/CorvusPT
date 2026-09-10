import { describe, it, expect } from "vitest";
import {
  haversineMiles,
  similarityScore,
  similarityBreakdown,
  computeComparableStats,
} from "./comps-analysis";
import type { CompProperty } from "./cad-comps";

function comp(overrides: Partial<CompProperty>): CompProperty {
  return {
    pid: 1,
    address: "123 Main St",
    latitude: 33.05,
    longitude: -96.75,
    marketValue: 400000,
    ownerName: null,
    ...overrides,
  };
}

describe("haversineMiles", () => {
  it("returns ~0 for the same point", () => {
    const p = { latitude: 33.05, longitude: -96.75 };
    expect(haversineMiles(p, p)).toBeCloseTo(0, 5);
  });

  it("returns a real distance for two known points (~69 miles per degree of latitude)", () => {
    const a = { latitude: 33.0, longitude: -96.75 };
    const b = { latitude: 34.0, longitude: -96.75 };
    expect(haversineMiles(a, b)).toBeCloseTo(69, -1); // within ~10 miles
  });
});

describe("similarityScore", () => {
  const subject = comp({ pid: 1, marketValue: 400000, legalAcreage: 0.25, propType: "C" });

  it("scores an identical comp near 100", () => {
    const identical = comp({ pid: 2, marketValue: 400000, legalAcreage: 0.25, propType: "C" });
    expect(similarityScore(subject, identical)).toBeGreaterThanOrEqual(95);
  });

  it("scores a comp with a very different value and far away much lower", () => {
    const different = comp({
      pid: 3,
      marketValue: 900000,
      latitude: 34.5,
      longitude: -98.5,
      legalAcreage: 5,
      propType: "R",
    });
    expect(similarityScore(subject, different)).toBeLessThan(40);
  });

  it("treats a missing field as neutral rather than a penalty", () => {
    const noAcreage = comp({ pid: 4, marketValue: 400000, legalAcreage: null, propType: "C" });
    const score = similarityScore(subject, noAcreage);
    // Value/distance/type all match; only land size is missing (neutral 50) —
    // should still score reasonably high, not collapse toward 0.
    expect(score).toBeGreaterThan(70);
  });

  it("down-weights a stale dated sale via the recency multiplier", () => {
    const fresh = comp({ pid: 5, marketValue: 400000, legalAcreage: 0.25, propType: "C" });
    const stale = comp({
      pid: 6,
      marketValue: 400000,
      legalAcreage: 0.25,
      propType: "C",
      lastTransferDt: "2016-01-01",
    });
    expect(similarityScore(subject, stale)).toBeLessThan(similarityScore(subject, fresh));
    expect(similarityBreakdown(subject, stale).recencyMult).toBeLessThan(0.9);
    expect(similarityBreakdown(subject, fresh).recencyMult).toBe(1);
  });

  it("bumps a verified sale and penalizes an unverified typed price", () => {
    // A near — but not perfect — comp, so the base score isn't already
    // capped at 100 and the ±reliability adjustment is visible.
    const near = comp({ pid: 7, marketValue: 430000, legalAcreage: 0.3, propType: "C" });
    const neutral = similarityScore(subject, near);
    const verified = similarityScore(subject, near, { verified: true });
    const unverified = similarityScore(subject, near, { userAdded: true, verified: false });
    expect(neutral).toBeLessThan(100);
    expect(verified).toBeGreaterThan(neutral);
    expect(unverified).toBeLessThan(neutral);
  });
});

describe("computeComparableStats", () => {
  const subject = comp({ pid: 1, marketValue: 500000, legalAcreage: 0.3 });

  it("flags limitedData when fewer than 3 comps have a usable market value", () => {
    const stats = computeComparableStats(subject, [comp({ pid: 2, marketValue: 480000 })], 500000);
    expect(stats.limitedData).toBe(true);
    expect(stats.confidencePct).toBeNull();
  });

  it("ranks comps by similarity, strongest first", () => {
    const closeMatch = comp({ pid: 2, marketValue: 495000, legalAcreage: 0.3 });
    const farValue = comp({ pid: 3, marketValue: 950000, latitude: 34.5, longitude: -98.5 });
    const midMatch = comp({ pid: 4, marketValue: 520000, legalAcreage: 0.32 });
    const stats = computeComparableStats(subject, [farValue, closeMatch, midMatch], 500000);
    expect(stats.ranked.map((r) => r.pid)).toEqual([2, 4, 3]);
  });

  it("computes a real indicated range and valuation gap from real comp values", () => {
    const comps = [
      comp({ pid: 2, marketValue: 480000, legalAcreage: 0.3 }),
      comp({ pid: 3, marketValue: 470000, legalAcreage: 0.3 }),
      comp({ pid: 4, marketValue: 460000, legalAcreage: 0.3 }),
    ];
    const stats = computeComparableStats(subject, comps, 500000);
    expect(stats.limitedData).toBe(false);
    expect(stats.indicated).toEqual({ min: 460000, median: 470000, max: 480000 });
    // Subject (500000) is above the comps' median (470000) -> positive gap.
    expect(stats.valuationGapPct).toBeGreaterThan(0);
    expect(stats.confidencePct).not.toBeNull();
  });

  it("returns nulls with no subject", () => {
    const stats = computeComparableStats(null, [comp({ pid: 2 })], 500000);
    expect(stats.ranked).toEqual([]);
    expect(stats.indicated).toBeNull();
  });

  it("gives every ranked comp a stable key", () => {
    const stats = computeComparableStats(
      subject,
      [comp({ pid: 2, marketValue: 480000 }), comp({ pid: 3, marketValue: 470000 })],
      500000,
    );
    expect(stats.ranked.map((r) => r.key).sort()).toEqual(["2", "3"]);
  });

  it("drops an excluded comp from the indicated value but keeps it in ranked (flagged)", () => {
    const comps = [
      comp({ pid: 2, marketValue: 480000, legalAcreage: 0.3 }),
      comp({ pid: 3, marketValue: 470000, legalAcreage: 0.3 }),
      comp({ pid: 4, marketValue: 460000, legalAcreage: 0.3 }),
      comp({ pid: 5, marketValue: 200000, legalAcreage: 0.3 }),
    ];
    const withOutlier = computeComparableStats(subject, comps, 500000);
    const withoutOutlier = computeComparableStats(subject, comps, 500000, {
      excludedKeys: new Set(["5"]),
    });
    expect(withoutOutlier.indicated?.min).toBeGreaterThan(withOutlier.indicated!.min);
    // still present in ranked, marked excluded, and out of `usable`-driven math
    const excludedRow = withoutOutlier.ranked.find((r) => r.key === "5");
    expect(excludedRow?.excluded).toBe(true);
  });

  it("flags a CAD comp as 'Not a market sale', a type mismatch, and a stale transfer", () => {
    const s = comp({ pid: 1, marketValue: 500000, legalAcreage: 0.3, propType: "C" });
    const stats = computeComparableStats(
      s,
      [
        comp({ pid: 2, marketValue: 490000, legalAcreage: 0.3, propType: "C" }),
        comp({
          pid: 3,
          marketValue: 480000,
          legalAcreage: 0.3,
          propType: "R",
          lastTransferDt: "2015-06-01",
        }),
        comp({ pid: 4, marketValue: 470000, legalAcreage: 0.3, propType: "C" }),
      ],
      500000,
    );
    const c3 = stats.ranked.find((r) => r.key === "3")!;
    expect(c3.flags).toContain("Not a market sale");
    expect(c3.flags).toContain("Type mismatch");
    expect(c3.flags).toContain("Stale");
    const c2 = stats.ranked.find((r) => r.key === "2")!;
    expect(c2.flags).toContain("Not a market sale");
    expect(c2.flags).not.toContain("Type mismatch");
  });

  it("normalizes comps to $/acre and reconciles a similarity-weighted adjusted value", () => {
    const s = comp({ pid: 1, marketValue: 500000, legalAcreage: 0.3 });
    const stats = computeComparableStats(
      s,
      [
        comp({ pid: 2, marketValue: 480000, legalAcreage: 0.24 }), // $2.0M/acre
        comp({ pid: 3, marketValue: 470000, legalAcreage: 0.235 }),
        comp({ pid: 4, marketValue: 460000, legalAcreage: 0.23 }),
      ],
      500000,
    );
    expect(stats.perCompAdjustment.every((a) => a.unitBasis === "acre")).toBe(true);
    // ~$2.0M/acre × 0.3 acre ≈ $600k per comp
    expect(stats.perCompAdjustment[0].sizeAdjValue).toBeGreaterThan(580000);
    expect(stats.perCompAdjustment[0].timeAdjPct).toBe(0); // CAD comps get no time adjustment
    expect(stats.adjustedIndicated).not.toBeNull();
    expect(stats.adjustedIndicated!.value).toBeGreaterThan(560000);
    // subject 500k is now BELOW the size-adjusted indicated ≈ 600k → negative gap
    expect(stats.valuationGapPct).toBeLessThan(0);
  });

  it("merges a user-added comp into the pool and ranks it", () => {
    const stats = computeComparableStats(
      subject,
      [comp({ pid: 2, marketValue: 480000, legalAcreage: 0.3 })],
      500000,
      {
        extraComps: [
          {
            key: "user:abc",
            address: "9 Added Ln",
            latitude: 33.05,
            longitude: -96.75,
            salePrice: 490000,
            saleDate: "2026-01-01",
            landSqft: 13068, // ~0.3 acre
            buildingSqft: 2000,
            source: "Closing statement",
            saleVerified: true,
          },
        ],
      },
    );
    const added = stats.ranked.find((r) => r.key === "user:abc");
    expect(added).toBeDefined();
    expect(added?.userAdded).toBe(true);
    expect(added?.pricePerSqft).toBe(245); // 490000 / 2000
    // the added comp counts toward the usable pool (2 of 3 needed here)
    expect(stats.ranked.filter((r) => r.marketValue != null && !r.excluded)).toHaveLength(2);
  });
});
