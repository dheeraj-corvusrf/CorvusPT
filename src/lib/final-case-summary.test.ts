import { describe, it, expect } from "vitest";
import { buildFinalCaseSummary } from "./final-case-summary";
import { getEffectiveTaxRate } from "./texas-tax-rates";
import type { PropertyRecord } from "./properties";
import type { ProtestRecord } from "./protests";

const property: PropertyRecord = {
  id: "prop-1",
  address: "3330 Eastpark Blvd, Denton, TX 76208",
  cad: "Denton Central Appraisal District",
  accountNumber: "R1",
  ownerName: "Eastpark Holdings LLC",
  propertyType: "Commercial",
  landValue: 2_000_000,
  improvementValue: 10_500_000,
  totalValue: 12_500_000,
  taxYear: 2026,
  protestDeadline: "2099-05-15",
  paymentDueDate: null,
  taxAmountDue: null,
  paidAt: null,
  estimatedSavings: 40_000,
  savingsBasis: "comps",
  createdAt: "2026-01-01T00:00:00Z",
  valueHistory: null,
};

function protestWith(o: Partial<ProtestRecord>): ProtestRecord {
  return {
    id: "p1",
    propertyId: "prop-1",
    status: "decision_received",
    notes: null,
    requestedAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    originalValue: 12_500_000,
    settlementOfferValue: null,
    settlementOfferReceivedAt: null,
    hearingDate: "2026-07-01",
    hearingTime: null,
    hearingLocation: null,
    hearingMode: null,
    informalStatus: "rejected",
    informalReviewDate: null,
    informalAppraiserCategory: null,
    attendanceType: null,
    arbDecision: null,
    arbDecisionDate: null,
    finalValue: null,
    escalationPath: null,
    closedAt: null,
    taxYear: 2026,
    corvusGuidanceAckAt: "2026-01-01T00:00:00Z",
    filingConfirmationNumber: null,
    filingChannel: null,
    certifiedMailTracking: null,
    evidenceSubmittedConfirmedAt: null,
    ...o,
  };
}

describe("buildFinalCaseSummary — availability", () => {
  it("is unavailable while the case is still in progress", () => {
    expect(buildFinalCaseSummary(property, protestWith({ status: "filed" })).available).toBe(false);
    expect(buildFinalCaseSummary(property, null).available).toBe(false);
  });

  it("is available once an ARB decision, an accepted informal, or a resolved status exists", () => {
    expect(
      buildFinalCaseSummary(
        property,
        protestWith({ arbDecision: "partial", arbDecisionDate: "2026-07-15" }),
      ).available,
    ).toBe(true);
    expect(
      buildFinalCaseSummary(
        property,
        protestWith({ informalStatus: "accepted", settlementOfferValue: 11_800_000 }),
      ).available,
    ).toBe(true);
    expect(
      buildFinalCaseSummary(property, protestWith({ status: "resolved", finalValue: 11_000_000 }))
        .available,
    ).toBe(true);
  });
});

describe("buildFinalCaseSummary — numbers & outcomes", () => {
  it("computes reduction and ACTUAL tax savings for a resolved case", () => {
    const s = buildFinalCaseSummary(
      property,
      protestWith({
        status: "resolved",
        finalValue: 11_000_000,
        arbDecision: "partial",
        arbDecisionDate: "2026-07-15",
        closedAt: "2026-08-01T00:00:00Z",
      }),
    );
    expect(s.valueReduction).toMatch(/1,500,000/);
    expect(s.taxSavings.basis).toBe("actual");
    const expected = Math.round(
      1_500_000 * getEffectiveTaxRate("Denton Central Appraisal District"),
    );
    expect(s.taxSavings.value).toBe(
      expected.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      }),
    );
    expect(s.protestOutcome).toMatch(/value reduced/i);
    expect(s.caseCloseDate).toMatch(/August 1, 2026/);
  });

  it("falls back to the ESTIMATED savings when the case is decided but not resolved", () => {
    const s = buildFinalCaseSummary(
      property,
      protestWith({ arbDecision: "denied", arbDecisionDate: "2026-07-15" }),
    );
    expect(s.taxSavings.basis).toBe("estimated");
    expect(s.taxSavings.value).toMatch(/40,000/);
  });

  it("surfaces the informal and hearing outcomes", () => {
    const s = buildFinalCaseSummary(
      property,
      protestWith({
        arbDecision: "denied",
        arbDecisionDate: "2026-07-15",
        informalStatus: "rejected",
      }),
    );
    expect(s.hearingOutcome).toMatch(/ARB denied on July 15, 2026/);
    expect(s.informalOutcome).toBeTruthy();
    expect(s.decisionDate).toMatch(/July 15, 2026/);
  });
});

describe("buildFinalCaseSummary — status line", () => {
  it("shows 'Case Closed' for a resolved case with no open deadline", () => {
    const s = buildFinalCaseSummary(
      property,
      protestWith({ status: "resolved", finalValue: 11_000_000 }),
    );
    expect(s.status.kind).toBe("closed");
    expect(s.status.label).toBe("Case Closed");
  });

  it("shows 'Action Required — Deadline: <date>' when an ARB decision leaves an open escalation window", () => {
    // A near-future ARB date so the 60-day window is still open.
    const near = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    const s = buildFinalCaseSummary(
      property,
      protestWith({ arbDecision: "partial", arbDecisionDate: near, finalValue: 12_000_000 }),
    );
    expect(s.status.kind).toBe("action_required");
    expect(s.status.label).toMatch(/^Action Required — Deadline: /);
    expect(s.remainingEscalationDeadline).not.toBeNull();
  });

  it("has no open deadline once the user has escalated", () => {
    const near = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    const s = buildFinalCaseSummary(
      property,
      protestWith({ arbDecision: "partial", arbDecisionDate: near, escalationPath: "arbitration" }),
    );
    expect(s.remainingEscalationDeadline).toBeNull();
  });

  it("lets the caller override the recommended next action (e.g. from case-guidance)", () => {
    const s = buildFinalCaseSummary(
      property,
      protestWith({ status: "resolved", finalValue: 11_000_000 }),
      { recommendedNextStep: "Pay the reduced tax bill by January 31." },
    );
    expect(s.recommendedNextAction).toBe("Pay the reduced tax bill by January 31.");
  });
});
