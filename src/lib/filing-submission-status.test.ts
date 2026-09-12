import { describe, it, expect } from "vitest";
import {
  filingSubmissionStatus,
  hasFilingReferenceNumber,
  confirmationMethodDescription,
} from "./filing-submission-status";

function sub(
  over: Partial<{
    filingMethod: "online" | "mail" | "in_person" | "email" | null;
    submittedAt: string | null;
    filingConfirmedAt: string | null;
    additionalRequestedAt: string | null;
    rejectedAt: string | null;
  }> = {},
) {
  return {
    filingMethod: null,
    submittedAt: null,
    filingConfirmedAt: null,
    additionalRequestedAt: null,
    rejectedAt: null,
    ...over,
  };
}

describe("filingSubmissionStatus", () => {
  it("is unstarted when there's no submission row at all", () => {
    expect(filingSubmissionStatus(null)).toBe("unstarted");
  });

  it("is unstarted when a row exists but no method has been picked yet", () => {
    expect(filingSubmissionStatus(sub())).toBe("unstarted");
  });

  it("is method_chosen once any method is picked, before marking submitted", () => {
    for (const method of ["online", "mail", "in_person", "email"] as const) {
      expect(filingSubmissionStatus(sub({ filingMethod: method }))).toBe("method_chosen");
    }
  });

  it("is awaiting_confirmation once marked submitted, for every method uniformly", () => {
    for (const method of ["online", "mail", "in_person", "email"] as const) {
      expect(
        filingSubmissionStatus(
          sub({ filingMethod: method, submittedAt: "2026-02-01T00:00:00Z" }),
        ),
      ).toBe("awaiting_confirmation");
    }
  });

  it("is confirmed once filingConfirmedAt is set, regardless of method", () => {
    expect(
      filingSubmissionStatus(
        sub({
          filingMethod: "email",
          submittedAt: "2026-02-01T00:00:00Z",
          filingConfirmedAt: "2026-02-10T00:00:00Z",
        }),
      ),
    ).toBe("confirmed");
    expect(
      filingSubmissionStatus(sub({ filingMethod: "online", filingConfirmedAt: "2026-02-10T00:00:00Z" })),
    ).toBe("confirmed");
  });

  it("is additional_requested once the county asks for more after a confirmation", () => {
    expect(
      filingSubmissionStatus(
        sub({
          filingConfirmedAt: "2026-02-10T00:00:00Z",
          additionalRequestedAt: "2026-02-15T00:00:00Z",
        }),
      ),
    ).toBe("additional_requested");
  });

  it("is rejected once the county rejects it, taking precedence over an older confirmation", () => {
    expect(
      filingSubmissionStatus(
        sub({
          filingConfirmedAt: "2026-02-10T00:00:00Z",
          rejectedAt: "2026-02-12T00:00:00Z",
        }),
      ),
    ).toBe("rejected");
  });

  it("resolves to whichever real event is newest, in any order", () => {
    expect(
      filingSubmissionStatus(
        sub({
          rejectedAt: "2026-02-12T00:00:00Z",
          additionalRequestedAt: "2026-02-13T00:00:00Z",
          filingConfirmedAt: "2026-02-05T00:00:00Z",
        }),
      ),
    ).toBe("additional_requested");
  });

  it("reverts to confirmed once a fresh confirmation supersedes an old rejection", () => {
    expect(
      filingSubmissionStatus(
        sub({
          rejectedAt: "2026-02-12T00:00:00Z",
          filingConfirmedAt: "2026-03-01T00:00:00Z",
        }),
      ),
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

describe("confirmationMethodDescription", () => {
  it("returns null when no method has been chosen", () => {
    expect(confirmationMethodDescription(null)).toBeNull();
  });

  it("describes the real proof each method's own confirmation looks like", () => {
    expect(confirmationMethodDescription("online")).toMatch(/portal confirmation/i);
    expect(confirmationMethodDescription("email")).toMatch(/acknowledgement or response/i);
    expect(confirmationMethodDescription("mail")).toMatch(/mailing receipt/i);
    expect(confirmationMethodDescription("in_person")).toMatch(/stamped copy/i);
  });
});
