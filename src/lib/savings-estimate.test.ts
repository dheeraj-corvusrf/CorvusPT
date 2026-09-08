import { describe, it, expect, vi, beforeEach } from "vitest";
import { estimateSavings } from "./savings-estimate";
import { getComps } from "./cad-comps";

vi.mock("./cad-comps", () => ({
  getComps: vi.fn(),
}));

const mockedGetComps = vi.mocked(getComps);

describe("estimateSavings", () => {
  beforeEach(() => {
    mockedGetComps.mockReset();
  });

  it("returns null when there's no assessed value to estimate from", async () => {
    const result = await estimateSavings({ totalValue: null });
    expect(result).toBeNull();
    expect(mockedGetComps).not.toHaveBeenCalled();
  });

  it("uses the comps tier when qualifying nearby comps exist and the subject is overvalued", async () => {
    mockedGetComps.mockResolvedValue({
      subject: {
        pid: 1,
        address: "123 Main St",
        latitude: 33.05,
        longitude: -96.75,
        marketValue: 400000,
        ownerName: null,
        asCode: "R1",
      },
      comps: [
        {
          pid: 2,
          address: "125 Main St",
          latitude: 33.0501,
          longitude: -96.7501,
          marketValue: 350000,
          ownerName: null,
        },
        {
          pid: 3,
          address: "127 Main St",
          latitude: 33.0502,
          longitude: -96.7502,
          marketValue: 340000,
          ownerName: null,
        },
        {
          pid: 4,
          address: "129 Main St",
          latitude: 33.0503,
          longitude: -96.7503,
          marketValue: 360000,
          ownerName: null,
        },
      ],
    });

    const result = await estimateSavings({
      cad: "Denton Central Appraisal District",
      accountNumber: "ACC-1",
      totalValue: 400000,
    });

    expect(result?.basis).toBe("comps");
    if (result?.basis === "comps") {
      expect(result.compsCount).toBe(3);
      expect(result.compsMedian).toBe(350000); // median of [340k,350k,360k]
      // overvaluation = 400000 - 350000 = 50000, rate 0.018 -> 900
      expect(result.amount).toBe(900);
    }
  });

  it("falls back to the formula tier when fewer than 3 comps qualify", async () => {
    mockedGetComps.mockResolvedValue({
      subject: {
        pid: 1,
        address: "123 Main St",
        latitude: 33.05,
        longitude: -96.75,
        marketValue: 400000,
        ownerName: null,
        asCode: "R1",
      },
      comps: [
        {
          pid: 2,
          address: "125 Main St",
          latitude: 33.0501,
          longitude: -96.7501,
          marketValue: 350000,
          ownerName: null,
        },
      ],
    });

    const result = await estimateSavings({
      cad: "Denton Central Appraisal District",
      accountNumber: "ACC-1",
      totalValue: 400000,
      propertyType: "Residential",
    });

    expect(result?.basis).toBe("formula");
  });

  it("falls back to the formula tier when comps lookup throws", async () => {
    mockedGetComps.mockRejectedValue(new Error("edge function down"));

    const result = await estimateSavings({
      cad: "Denton Central Appraisal District",
      accountNumber: "ACC-1",
      totalValue: 400000,
      propertyType: "Residential",
    });

    expect(result?.basis).toBe("formula");
  });

  it("skips the comps lookup entirely when cad or accountNumber is missing", async () => {
    const result = await estimateSavings({ totalValue: 400000, propertyType: "Residential" });
    expect(mockedGetComps).not.toHaveBeenCalled();
    expect(result?.basis).toBe("formula");
  });

  it("computes the formula tier deterministically from real published rates", async () => {
    const result = await estimateSavings({
      cad: "Collin Central Appraisal District",
      totalValue: 500000,
      propertyType: "Residential",
    });
    expect(result?.basis).toBe("formula");
    if (result?.basis === "formula") {
      // Collin residential base 4.75%, no assessment-ratio nudge (COD 4.41 within
      // IAAO ceiling), no value history -> reductionPct stays 4.75%, displayed
      // rounded to 1 decimal: round(47.5)/10 = 4.8.
      expect(result.reductionPct).toBe(4.8);
      expect(result.effectiveTaxRatePct).toBe(1.4);
      expect(result.amount).toBe(Math.round(500000 * 0.0475 * 0.014));
    }
  });

  it("returns the same result for the same input (deterministic, no AI)", async () => {
    const input = {
      cad: "Travis Central Appraisal District",
      totalValue: 600000,
      propertyType: "Commercial",
    };
    const first = await estimateSavings(input);
    const second = await estimateSavings(input);
    expect(first).toEqual(second);
  });
});
