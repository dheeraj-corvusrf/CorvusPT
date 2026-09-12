import { describe, it, expect } from "vitest";
import { filingSubmissionStatus, hasFilingReferenceNumber } from "./filing-submission-status";

describe("filingSubmissionStatus", () => {
  it("is unstarted when there's no submission row at all", () => {
    expect(filingSubmissionStatus(null)).toBe("unstarted");
  });

  it("is unstarted when a row exists but no method has been picked yet", () => {
    expect(
      filingSubmissionStatus({ filingMethod: null, emailSentAt: null, filingConfirmedAt: null }),
    ).toBe("unstarted");
  });

  it("is method_chosen once a non-email method is picked, before confirming", () => {
    for (const method of ["online", "mail", "in_person"] as const) {
      expect(
        filingSubmissionStatus({
          filingMethod: method,
          emailSentAt: null,
          filingConfirmedAt: null,
        }),
      ).toBe("method_chosen");
    }
  });

  it("is method_chosen for email before it's been marked sent", () => {
    expect(
      filingSubmissionStatus({ filingMethod: "email", emailSentAt: null, filingConfirmedAt: null }),
    ).toBe("method_chosen");
  });

  it("is awaiting_confirmation once email is marked sent but not yet confirmed", () => {
    expect(
      filingSubmissionStatus({
        filingMethod: "email",
        emailSentAt: "2026-02-01T00:00:00Z",
        filingConfirmedAt: null,
      }),
    ).toBe("awaiting_confirmation");
  });

  it("never reports awaiting_confirmation for a non-email method", () => {
    expect(
      filingSubmissionStatus({
        filingMethod: "mail",
        emailSentAt: null,
        filingConfirmedAt: null,
      }),
    ).not.toBe("awaiting_confirmation");
  });

  it("is confirmed once filingConfirmedAt is set, regardless of method or email state", () => {
    expect(
      filingSubmissionStatus({
        filingMethod: "email",
        emailSentAt: "2026-02-01T00:00:00Z",
        filingConfirmedAt: "2026-02-10T00:00:00Z",
      }),
    ).toBe("confirmed");
    expect(
      filingSubmissionStatus({
        filingMethod: "online",
        emailSentAt: null,
        filingConfirmedAt: "2026-02-10T00:00:00Z",
      }),
    ).toBe("confirmed");
  });
});

describe("hasFilingReferenceNumber", () => {
  it("is false for null or an empty submission", () => {
    expect(hasFilingReferenceNumber(null)).toBe(false);
    expect(
      hasFilingReferenceNumber({ filingConfirmationNumber: null, mailTrackingNumber: null }),
    ).toBe(false);
    expect(
      hasFilingReferenceNumber({ filingConfirmationNumber: "  ", mailTrackingNumber: "" }),
    ).toBe(false);
  });

  it("is true when either a confirmation number or a tracking number is set", () => {
    expect(
      hasFilingReferenceNumber({ filingConfirmationNumber: "ABC123", mailTrackingNumber: null }),
    ).toBe(true);
    expect(
      hasFilingReferenceNumber({ filingConfirmationNumber: null, mailTrackingNumber: "9400 1000" }),
    ).toBe(true);
  });
});
