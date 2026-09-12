import { describe, it, expect } from "vitest";
import { computeEvidenceStatus, evidenceScore, type EvidenceStatusInput } from "./evidence-status";

function input(over: Partial<EvidenceStatusInput> = {}): EvidenceStatusInput {
  return {
    evidenceDocCount: 0,
    criticalMissingCount: null,
    submission: null,
    ...over,
  };
}

describe("computeEvidenceStatus — readiness phase (nothing submitted to the county yet)", () => {
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
    expect(
      computeEvidenceStatus(input({ evidenceDocCount: 4, criticalMissingCount: null })),
    ).toBe("ready_to_submit");
  });

  it("stays ready_to_submit once a method is picked but not yet marked submitted", () => {
    expect(
      computeEvidenceStatus(
        input({
          evidenceDocCount: 4,
          criticalMissingCount: 0,
          submission: {
            filingMethod: "mail",
            submittedAt: null,
            filingConfirmedAt: null,
            additionalRequestedAt: null,
            rejectedAt: null,
          },
        }),
      ),
    ).toBe("ready_to_submit");
  });
});

describe("computeEvidenceStatus — once marked submitted", () => {
  it("is awaiting_confirmation once submittedAt is set, for any method", () => {
    for (const method of ["online", "mail", "in_person", "email"] as const) {
      expect(
        computeEvidenceStatus(
          input({
            submission: {
              filingMethod: method,
              submittedAt: "2026-02-01T00:00:00Z",
              filingConfirmedAt: null,
              additionalRequestedAt: null,
              rejectedAt: null,
            },
          }),
        ),
      ).toBe("awaiting_confirmation");
    }
  });

  it("is complete once confirmed and nothing critical is known to be missing", () => {
    const confirmed = {
      filingMethod: "online" as const,
      submittedAt: "2026-02-05T00:00:00Z",
      filingConfirmedAt: "2026-02-10T00:00:00Z",
      additionalRequestedAt: null,
      rejectedAt: null,
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
            submittedAt: "2026-02-05T00:00:00Z",
            filingConfirmedAt: "2026-02-10T00:00:00Z",
            additionalRequestedAt: null,
            rejectedAt: null,
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
            submittedAt: "2026-02-05T00:00:00Z",
            filingConfirmedAt: "2026-02-10T00:00:00Z",
            additionalRequestedAt: "2026-02-15T00:00:00Z",
            rejectedAt: null,
          },
        }),
      ),
    ).toBe("additional_requested");
  });

  it("is rejected once the county rejects it", () => {
    expect(
      computeEvidenceStatus(
        input({
          submission: {
            filingMethod: "mail",
            submittedAt: "2026-02-05T00:00:00Z",
            filingConfirmedAt: null,
            additionalRequestedAt: null,
            rejectedAt: "2026-02-08T00:00:00Z",
          },
        }),
      ),
    ).toBe("rejected");
  });
});

describe("evidenceScore", () => {
  it("is null when Module 8 hasn't run yet", () => {
    expect(evidenceScore(null)).toBeNull();
    expect(evidenceScore([])).toBeNull();
  });

  it("is the percentage of items that aren't Missing", () => {
    expect(
      evidenceScore([{ status: "Verified" }, { status: "Found" }, { status: "Missing" }]),
    ).toBe(67);
    expect(evidenceScore([{ status: "Missing" }, { status: "Missing" }])).toBe(0);
    expect(evidenceScore([{ status: "Verified" }, { status: "Verified" }])).toBe(100);
  });
});
