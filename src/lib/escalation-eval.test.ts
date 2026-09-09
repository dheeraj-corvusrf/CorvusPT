import { describe, it, expect } from "vitest";
import { evaluateEscalation } from "./escalation-eval";
import type { PropertyRecord } from "./properties";
import type { ProtestRecord } from "./protests";

const baseProperty: PropertyRecord = {
  id: "prop-1",
  address: "3330 Eastpark Blvd, Denton, TX 76208",
  cad: "Denton Central Appraisal District",
  accountNumber: "12345",
  ownerName: "Test Owner LLC",
  propertyType: "Commercial",
  landValue: 2_000_000,
  improvementValue: 10_500_000,
  totalValue: 12_500_000,
  taxYear: 2026,
  protestDeadline: "2099-05-15",
  paymentDueDate: null,
  taxAmountDue: null,
  paidAt: null,
  estimatedSavings: null,
  savingsBasis: null,
  createdAt: "2026-01-01T00:00:00Z",
  valueHistory: null,
};

function protestWith(overrides: Partial<ProtestRecord>): ProtestRecord {
  return {
    id: "protest-1",
    propertyId: "prop-1",
    status: "decision_received",
    notes: null,
    requestedAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    originalValue: 12_500_000,
    settlementOfferValue: null,
    settlementOfferReceivedAt: null,
    hearingDate: null,
    hearingTime: null,
    hearingLocation: null,
    hearingMode: null,
    informalStatus: "rejected",
    informalReviewDate: null,
    informalAppraiserCategory: null,
    attendanceType: null,
    arbDecision: "denied",
    arbDecisionDate: "2026-07-01",
    finalValue: 12_500_000,
    escalationPath: null,
    closedAt: null,
    taxYear: 2026,
    corvusGuidanceAckAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("evaluateEscalation — availability gate", () => {
  it("is not available until both informal and formal tracks closed unfavourably", () => {
    expect(
      evaluateEscalation(baseProperty, protestWith({ informalStatus: "accepted" }), 0).available,
    ).toBe(false);
    expect(
      evaluateEscalation(baseProperty, protestWith({ arbDecision: "approved" }), 0).available,
    ).toBe(false);
    expect(evaluateEscalation(baseProperty, protestWith({ arbDecision: null }), 0).available).toBe(
      false,
    );
  });

  it("is available on informal rejected + ARB denied, and on partial", () => {
    expect(evaluateEscalation(baseProperty, protestWith({}), 0).available).toBe(true);
    expect(
      evaluateEscalation(
        baseProperty,
        protestWith({ arbDecision: "partial", informalStatus: "no_informal_available" }),
        0,
      ).available,
    ).toBe(true);
  });
});

describe("evaluateEscalation — deadlines", () => {
  it("counts binding arbitration + district court 60 days, SOAH 30 days, from the ARB order date", () => {
    const evalr = evaluateEscalation(
      baseProperty,
      protestWith({ arbDecisionDate: "2026-07-01" }),
      3,
    );
    const byId = Object.fromEntries(evalr.options.map((o) => [o.id, o]));
    expect(byId.binding_arbitration.deadline.date).toBe("2026-08-30");
    expect(byId.district_court.deadline.date).toBe("2026-08-30");
    expect(byId.soah.deadline.date).toBe("2026-07-31");
  });

  it("returns null deadline dates (not a guess) when no ARB order date is recorded", () => {
    const evalr = evaluateEscalation(baseProperty, protestWith({ arbDecisionDate: null }), 3);
    const arb = evalr.options.find((o) => o.id === "binding_arbitration")!;
    expect(arb.deadline.date).toBeNull();
    expect(arb.deadline.basis).toMatch(/60 days/);
  });
});

describe("evaluateEscalation — eligibility", () => {
  it("excludes regular binding arbitration for a non-homestead property over the $5M cap", () => {
    const arb = evaluateEscalation(baseProperty, protestWith({}), 0).options.find(
      (o) => o.id === "binding_arbitration",
    )!;
    expect(arb.eligible).toBe(false);
    expect(arb.eligibilityBasis).toMatch(/\$5,000,000/);
  });

  it("allows regular binding arbitration for a homestead at any value", () => {
    const arb = evaluateEscalation(
      { ...baseProperty, propertyType: "Single Family Residence" },
      protestWith({}),
      0,
    ).options.find((o) => o.id === "binding_arbitration")!;
    expect(arb.eligible).toBe(true);
    expect(arb.estimatedCost?.min).toBe(500); // homestead > $500k
  });

  it("allows regular binding arbitration for a non-homestead under $5M and prices the deposit tier", () => {
    const arb = evaluateEscalation(
      { ...baseProperty, totalValue: 2_500_000 },
      protestWith({ originalValue: 2_500_000, finalValue: 2_500_000 }),
      0,
    ).options.find((o) => o.id === "binding_arbitration")!;
    expect(arb.eligible).toBe(true);
    expect(arb.estimatedCost?.min).toBe(1_550); // > $2M and ≤ $3M
  });

  it("blocks binding arbitration once a district-court petition is filed", () => {
    const arb = evaluateEscalation(
      { ...baseProperty, propertyType: "Residence Homestead" },
      protestWith({ escalationPath: "appeal" }),
      0,
    ).options.find((o) => o.id === "binding_arbitration")!;
    expect(arb.eligible).toBe(false);
    expect(arb.eligibilityBasis).toMatch(/district-court petition/);
  });

  it("offers SOAH only above $1M", () => {
    const big = evaluateEscalation(baseProperty, protestWith({}), 0).options.find(
      (o) => o.id === "soah",
    )!;
    expect(big.eligible).toBe(true);
    const small = evaluateEscalation(
      { ...baseProperty, totalValue: 400_000 },
      protestWith({ originalValue: 400_000, finalValue: 400_000 }),
      0,
    ).options.find((o) => o.id === "soah")!;
    expect(small.eligible).toBe(false);
  });

  it("always offers district court and no-further-action", () => {
    const opts = evaluateEscalation(baseProperty, protestWith({}), 0).options;
    expect(opts.find((o) => o.id === "district_court")!.eligible).toBe(true);
    expect(opts.find((o) => o.id === "no_further_action")!.eligible).toBe(true);
  });
});

describe("evaluateEscalation — savings, ROI, recommendation", () => {
  it("cannot state additional savings or ROI without an opinion of value", () => {
    const evalr = evaluateEscalation(baseProperty, protestWith({}), 3);
    const court = evalr.options.find((o) => o.id === "district_court")!;
    expect(court.potentialAdditionalSavings.amount).toBeNull();
    expect(court.estimatedRoi.ratio).toBeNull();
    // With nothing to score, the recommendation falls back to closing.
    expect(evalr.options.find((o) => o.recommended)!.id).toBe("no_further_action");
  });

  it("computes additional savings from the value gap and the county effective rate", () => {
    // Denton effective rate is ~2.1%; gap = 12.5M − 11M = 1.5M → ~$31.5k.
    const evalr = evaluateEscalation(baseProperty, protestWith({}), 4, 11_000_000);
    const court = evalr.options.find((o) => o.id === "district_court")!;
    expect(court.potentialAdditionalSavings.amount).toBeGreaterThan(25_000);
    expect(court.potentialAdditionalSavings.amount).toBeLessThan(40_000);
    expect(court.estimatedRoi.ratio).not.toBeNull();
  });

  it("recommends a value remedy when a strong-evidence case has a large gap and good ROI", () => {
    const evalr = evaluateEscalation(baseProperty, protestWith({}), 5, 10_000_000);
    const rec = evalr.options.find((o) => o.recommended)!;
    expect(["binding_arbitration", "district_court", "soah"]).toContain(rec.id);
    expect(evalr.headline).toMatch(/worth a closer look/i);
  });

  it("still recommends closing when the ARB gave a partial and evidence is thin", () => {
    const evalr = evaluateEscalation(
      baseProperty,
      protestWith({ arbDecision: "partial", finalValue: 11_000_000 }),
      0,
      10_800_000,
    );
    expect(evalr.options.find((o) => o.recommended)!.id).toBe("no_further_action");
  });

  it("every option carries the non-guarantee framing", () => {
    const evalr = evaluateEscalation(baseProperty, protestWith({}), 3, 11_000_000);
    expect(evalr.disclaimer).toMatch(/not a prediction or guarantee/i);
  });
});
