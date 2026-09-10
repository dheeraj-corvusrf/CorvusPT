import { describe, it, expect } from "vitest";
import { toProtestRecord, toPropertyRecordStub, type AdminProtestRecord } from "./admin";

function adminRecord(overrides: Partial<AdminProtestRecord> = {}): AdminProtestRecord {
  return {
    id: "pr1",
    propertyId: "prop1",
    userId: "user1",
    status: "filed",
    notes: "staff note",
    requestedAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-02T00:00:00Z",
    propertyAddress: "123 Main St",
    propertyCad: "Denton Central Appraisal District",
    propertyType: "Residential",
    protestDeadline: "2024-05-01",
    totalValue: 400000,
    landValue: 100000,
    improvementValue: 300000,
    taxYear: 2024,
    accountNumber: "ACC-1",
    protestFilingYear: 2024,
    originalValue: 400000,
    settlementOfferValue: null,
    settlementOfferReceivedAt: null,
    hearingDate: null,
    arbDecision: null,
    arbDecisionDate: null,
    finalValue: null,
    escalationPath: null,
    closedAt: null,
    ...overrides,
  };
}

describe("toProtestRecord", () => {
  it("carries every case-progress field straight across, dropping only the admin-only ones", () => {
    const record = adminRecord();
    const result = toProtestRecord(record);
    expect(result).toEqual({
      id: "pr1",
      propertyId: "prop1",
      status: "filed",
      notes: "staff note",
      requestedAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-02T00:00:00Z",
      originalValue: 400000,
      settlementOfferValue: null,
      settlementOfferReceivedAt: null,
      hearingDate: null,
      hearingTime: null,
      hearingLocation: null,
      hearingMode: null,
      informalStatus: "not_requested",
      informalReviewDate: null,
      informalReviewTime: null,
      informalReviewMode: null,
      informalAppraiserCategory: null,
      attendanceType: null,
      arbDecision: null,
      arbDecisionDate: null,
      finalValue: null,
      escalationPath: null,
      closedAt: null,
      taxYear: 2024,
      corvusGuidanceAckAt: null,
    });
  });

  it("uses the protest's own filing year, not the property's current tax year", () => {
    const record = adminRecord({ taxYear: 2026, protestFilingYear: 2024 });
    const result = toProtestRecord(record);
    expect(result.taxYear).toBe(2024);
  });
});

describe("toPropertyRecordStub", () => {
  it("maps property fields and stubs the fields AdminProtestRecord never carries", () => {
    const result = toPropertyRecordStub(adminRecord());
    expect(result.id).toBe("prop1");
    expect(result.address).toBe("123 Main St");
    expect(result.cad).toBe("Denton Central Appraisal District");
    expect(result.totalValue).toBe(400000);
    expect(result.createdAt).toBe("2024-01-01T00:00:00Z"); // requestedAt used as createdAt
    // Fields AdminProtestRecord doesn't carry are stubbed, never fabricated.
    expect(result.ownerName).toBeNull();
    expect(result.paymentDueDate).toBeNull();
    expect(result.taxAmountDue).toBeNull();
    expect(result.paidAt).toBeNull();
    expect(result.estimatedSavings).toBeNull();
    expect(result.savingsBasis).toBeNull();
  });

  it("falls back to an empty address string when the property was removed", () => {
    const result = toPropertyRecordStub(adminRecord({ propertyAddress: null }));
    expect(result.address).toBe("");
  });
});
