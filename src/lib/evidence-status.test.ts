import { describe, it, expect } from "vitest";
import { computeEvidenceStatus, type EvidenceStatusInput } from "./evidence-status";

function input(over: Partial<EvidenceStatusInput> = {}): EvidenceStatusInput {
  return {
    evidenceDocCount: 0,
    criticalMissingCount: null,
    submission: null,
    ...over,
  };
}

describe("computeEvidenceStatus — readiness phase (no method chosen yet)", () => {
  it("is not_started when there's no evidence and Module 8 has never run", () => {
    expect(computeEvidenceStatus(input())).toBe("not_started");
  });

  it("is evidence_required once Module 8 has run but nothing's uploaded", () => {
    expect(computeEvidenceStatus(input({ criticalMissingCount: 3 }))).toBe("evidence_required");
  });

  it("is being_prepared once evidence exists but real critical gaps remain", () => {
    expect(computeEvidenceStatus(input({ evidenceDocCount: 2, criticalMissingCount: 1 }))).toBe(
      "being_prepared",
    );
  });

  it("is ready_to_submit once evidence exists and no critical gaps remain", () => {
    expect(computeEvidenceStatus(input({ evidenceDocCount: 4, criticalMissingCount: 0 }))).toBe(
      "ready_to_submit",
    );
    // Module 8 never run but the user already has documents — still fine to
    // move forward, not blocked on an AI check that hasn't happened.
    expect(computeEvidenceStatus(input({ evidenceDocCount: 4, criticalMissingCount: null }))).toBe(
      "ready_to_submit",
    );
  });
});

describe("computeEvidenceStatus — once a method is chosen", () => {
  it("is submitted once a method is picked, before confirming", () => {
    expect(
      computeEvidenceStatus(
        input({
          evidenceDocCount: 4,
          criticalMissingCount: 0,
          submission: {
            filingMethod: "mail",
            emailSentAt: null,
            filingConfirmedAt: null,
            additionalRequestedAt: null,
          },
        }),
      ),
    ).toBe("submitted");
  });

  it("is awaiting_confirmation for email once marked sent", () => {
    expect(
      computeEvidenceStatus(
        input({
          submission: {
            filingMethod: "email",
            emailSentAt: "2026-02-01T00:00:00Z",
            filingConfirmedAt: null,
            additionalRequestedAt: null,
          },
        }),
      ),
    ).toBe("awaiting_confirmation");
  });

  it("is complete once confirmed and nothing critical is known to be missing", () => {
    const confirmed = {
      filingMethod: "online" as const,
      emailSentAt: null,
      filingConfirmedAt: "2026-02-10T00:00:00Z",
      additionalRequestedAt: null,
    };
    expect(computeEvidenceStatus(input({ criticalMissingCount: 0, submission: confirmed }))).toBe(
      "complete",
    );
    expect(
      computeEvidenceStatus(input({ criticalMissingCount: null, submission: confirmed })),
    ).toBe("complete");
  });

  it("is confirmed (not complete) when confirmed but Module 8 still flags a real gap", () => {
    expect(
      computeEvidenceStatus(
        input({
          criticalMissingCount: 2,
          submission: {
            filingMethod: "online",
            emailSentAt: null,
            filingConfirmedAt: "2026-02-10T00:00:00Z",
            additionalRequestedAt: null,
          },
        }),
      ),
    ).toBe("confirmed");
  });

  it("is additional_requested once the county asks for more after confirming", () => {
    expect(
      computeEvidenceStatus(
        input({
          criticalMissingCount: 0,
          submission: {
            filingMethod: "online",
            emailSentAt: null,
            filingConfirmedAt: "2026-02-10T00:00:00Z",
            additionalRequestedAt: "2026-02-15T00:00:00Z",
          },
        }),
      ),
    ).toBe("additional_requested");
  });
});
