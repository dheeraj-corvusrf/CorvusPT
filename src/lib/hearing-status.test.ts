import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getHearingUserStatus } from "./hearing-status";
import type { ProtestRecord } from "./protests";

function protest(overrides: Partial<ProtestRecord> = {}): ProtestRecord {
  return {
    id: "pr1",
    propertyId: "p1",
    status: "hearing_scheduled",
    notes: null,
    requestedAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    originalValue: null,
    settlementOfferValue: null,
    settlementOfferReceivedAt: null,
    hearingDate: null,
    hearingTime: null,
    hearingLocation: null,
    hearingMode: null,
    informalStatus: "not_requested",
    informalReviewDate: null,
    informalAppraiserCategory: null,
    attendanceType: null,
    arbDecision: null,
    arbDecisionDate: null,
    finalValue: null,
    escalationPath: null,
    closedAt: null,
    taxYear: null,
    corvusGuidanceAckAt: null,
    ...overrides,
  };
}

describe("getHearingUserStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is 'No Action Needed' when no hearing is scheduled", () => {
    expect(getHearingUserStatus(protest({ status: "filed" }), false, 0)).toBe("No Action Needed");
    expect(
      getHearingUserStatus(protest({ status: "hearing_scheduled", hearingDate: null }), false, 0),
    ).toBe("No Action Needed");
  });

  it("is 'Attend Hearing' the day of the hearing", () => {
    expect(getHearingUserStatus(protest({ hearingDate: "2024-06-01" }), true, 3)).toBe(
      "Attend Hearing",
    );
  });

  it("is 'Upload Documents' when far out but the notice or evidence is missing", () => {
    expect(getHearingUserStatus(protest({ hearingDate: "2024-06-20" }), false, 3)).toBe(
      "Upload Documents",
    );
    expect(getHearingUserStatus(protest({ hearingDate: "2024-06-20" }), true, 0)).toBe(
      "Upload Documents",
    );
  });

  it("is 'Hearing Scheduled' when far out with the notice and evidence on file", () => {
    expect(getHearingUserStatus(protest({ hearingDate: "2024-06-20" }), true, 3)).toBe(
      "Hearing Scheduled",
    );
  });
});
