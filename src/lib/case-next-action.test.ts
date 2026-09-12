import { describe, it, expect } from "vitest";
import { computeCaseNextAction, type CaseNextActionInputs } from "./case-next-action";
import type { PropertyRecord } from "./properties";
import type { ProtestRecord } from "./protests";
import type { CountyProtestInfo } from "./county-protest-info";

// Same "derive from now" discipline as pre-filing-check.test.ts — the
// Pre-Filing Check's own deadline-consistency rules would otherwise flag a
// hard-coded date once the suite outlives it.
const NOW_YEAR = new Date().getFullYear();
const FUTURE_DEADLINE = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);

const property: PropertyRecord = {
  id: "prop-1",
  address: "123 Main St, Plano, TX 75023",
  cad: "Collin Central Appraisal District",
  accountNumber: "12345",
  ownerName: "Test Owner LLC",
  propertyType: "Commercial",
  landValue: 100000,
  improvementValue: 400000,
  totalValue: 500000,
  taxYear: NOW_YEAR,
  protestDeadline: FUTURE_DEADLINE,
  paymentDueDate: null,
  taxAmountDue: null,
  paidAt: null,
  estimatedSavings: null,
  savingsBasis: null,
  createdAt: "2026-01-01T00:00:00Z",
  valueHistory: null,
};

const baseProtest: ProtestRecord = {
  id: "protest-1",
  propertyId: "prop-1",
  status: "requested",
  notes: null,
  requestedAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  originalValue: 500000,
  settlementOfferValue: null,
  settlementOfferReceivedAt: null,
  hearingDate: null,
  hearingTime: null,
  hearingLocation: null,
  hearingMode: null,
  informalStatus: "not_requested",
  informalReviewDate: null,
  informalAppraiserCategory: null,
  attendanceType: "Property Owner",
  arbDecision: null,
  arbDecisionDate: null,
  finalValue: null,
  escalationPath: null,
  closedAt: null,
  taxYear: NOW_YEAR,
  corvusGuidanceAckAt: "2026-01-01T00:00:00Z",
};

const countyInfoWithOnline: CountyProtestInfo = {
  cad: "Collin Central Appraisal District",
  filingMethod: {
    online: { url: "https://onlineportal.collincad.org/", notes: null },
    mail: null,
    inPerson: null,
    email: { available: false, address: null, notes: null },
  },
  arbContact: null,
  informalReview: null,
  sourceUrl: "https://www.collincad.org/",
  verifiedAt: "2026-01-01",
};

function inputs(overrides: Partial<CaseNextActionInputs> = {}): CaseNextActionInputs {
  return {
    property,
    protest: baseProtest,
    evidenceCount: 3,
    countyInfo: countyInfoWithOnline,
    noticeSignedAt: null,
    noticeHearingAppearance: null,
    agentFormSignedAt: null,
    evidenceDeclarationSignedAt: null,
    ...overrides,
  };
}

describe("computeCaseNextAction — simplest case (owner in person, no agent/affidavit)", () => {
  it("highlights File Protest before the Notice is signed", () => {
    const result = computeCaseNextAction(inputs());
    expect(result.action?.label).toBe("File Protest");
    expect(result.action?.kind).toBe("internal");
    const fileEntry = result.timeline.find((t) => t.id === "file");
    expect(fileEntry?.status).toBe("current");
  });

  it("moves to Go to County CAD once the Notice is signed, using the real portal URL", () => {
    const result = computeCaseNextAction(inputs({ noticeSignedAt: "2026-02-01T00:00:00Z" }));
    expect(result.action).toEqual({
      label: "Go to County CAD",
      kind: "external",
      href: "https://onlineportal.collincad.org/",
    });
    // File still reads "current" (not done) — signing isn't the same as
    // actually filing with the county.
    expect(result.timeline.find((t) => t.id === "file")?.status).toBe("current");
  });

  it("falls back to an internal action when the county has no online portal on file", () => {
    const result = computeCaseNextAction(
      inputs({ noticeSignedAt: "2026-02-01T00:00:00Z", countyInfo: null }),
    );
    expect(result.action).toEqual({
      label: "How to File",
      kind: "internal",
      href: "/dashboard/case",
    });
  });

  it("shows a final confirm action once every required step, including Evidence, is done", () => {
    const result = computeCaseNextAction(
      inputs({
        noticeSignedAt: "2026-02-01T00:00:00Z",
        protest: { ...baseProtest, evidenceSubmittedConfirmedAt: "2026-02-05T00:00:00Z" },
      }),
    );
    expect(result.action?.label).toBe("Go to County CAD");
    const evidenceEntry = result.timeline.find((t) => t.id === "evidence");
    expect(evidenceEntry?.status).toBe("done");
    expect(result.timeline.find((t) => t.id === "file")?.status).toBe("current");
  });
});

describe("computeCaseNextAction — Agent/Representative required", () => {
  const agentProtest: ProtestRecord = { ...baseProtest, attendanceType: "Authorized Agent" };

  it("highlights Agent / Representative right after the Notice is signed, not County CAD", () => {
    const result = computeCaseNextAction(
      inputs({ protest: agentProtest, noticeSignedAt: "2026-02-01T00:00:00Z" }),
    );
    expect(result.action?.label).toBe("Agent / Representative");
    expect(result.timeline.find((t) => t.id === "file")?.status).toBe("done");
    expect(result.timeline.find((t) => t.id === "agent")?.status).toBe("current");
  });

  it("moves to Evidence once Agent is signed (no affidavit needed)", () => {
    const result = computeCaseNextAction(
      inputs({
        protest: agentProtest,
        noticeSignedAt: "2026-02-01T00:00:00Z",
        agentFormSignedAt: "2026-02-02T00:00:00Z",
      }),
    );
    expect(result.action?.label).toBe("Evidence");
    expect(result.timeline.find((t) => t.id === "agent")?.status).toBe("done");
  });
});

describe("computeCaseNextAction — Evidence Affidavit required", () => {
  it("highlights Evidence Affidavit while the owner won't appear in person", () => {
    const result = computeCaseNextAction(
      inputs({ noticeSignedAt: "2026-02-01T00:00:00Z", noticeHearingAppearance: "Phone" }),
    );
    expect(result.action?.label).toBe("Evidence Affidavit");
  });

  it("moves to Evidence once the affidavit is signed", () => {
    const result = computeCaseNextAction(
      inputs({
        noticeSignedAt: "2026-02-01T00:00:00Z",
        noticeHearingAppearance: "Phone",
        evidenceDeclarationSignedAt: "2026-02-03T00:00:00Z",
      }),
    );
    expect(result.action?.label).toBe("Evidence");
  });
});

describe("computeCaseNextAction — Pre-Filing Check blocked", () => {
  it("points at View Case instead of any filing step", () => {
    const result = computeCaseNextAction(inputs({ property: { ...property, ownerName: null } }));
    expect(result.action).toEqual({
      label: "Resolve in View Case",
      kind: "internal",
      href: "/dashboard/case",
    });
  });
});

describe("computeCaseNextAction — filed or beyond", () => {
  it("marks File Protest done and reads the current phase from getCaseGuidance", () => {
    const result = computeCaseNextAction(inputs({ protest: { ...baseProtest, status: "filed" } }));
    expect(result.timeline.find((t) => t.id === "file")?.status).toBe("done");
    expect(result.action).not.toBeNull();
  });

  it("marks every phase done and returns no action once resolved", () => {
    const result = computeCaseNextAction(
      inputs({
        protest: { ...baseProtest, status: "resolved", finalValue: 480000, closedAt: "2026-06-01" },
      }),
    );
    expect(result.action).toBeNull();
    expect(result.timeline.every((t) => t.status === "done")).toBe(true);
  });

  it("highlights Formal Hearing when a hearing date is on record", () => {
    const result = computeCaseNextAction(
      inputs({
        protest: {
          ...baseProtest,
          status: "hearing_scheduled",
          hearingDate: "2026-08-01",
        },
      }),
    );
    expect(result.timeline.find((t) => t.id === "hearing")?.status).toBe("current");
    expect(result.timeline.find((t) => t.id === "informal")?.status).toBe("done");
    expect(result.timeline.find((t) => t.id === "decision")?.status).toBe("upcoming");
  });
});
