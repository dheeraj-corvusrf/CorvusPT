import { describe, it, expect } from "vitest";
import {
  getCaseRecord,
  caseRecordStage,
  outstandingProofPrompts,
  caseRecordCompletion,
} from "./case-record";
import type { ProtestRecord } from "./protests";
import type { DocumentRecord } from "./documents";
import { CONFIRMATION_DOCUMENT_TYPE, ARB_ORDER_DOCUMENT_TYPE } from "./documents";

function protestWith(overrides: Partial<ProtestRecord>): ProtestRecord {
  return {
    id: "p1",
    propertyId: "prop1",
    status: "filed",
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
    ...overrides,
  };
}

const noOpts = {
  documents: [] as DocumentRecord[],
  hearingNoticeOnFile: false,
  countyCommunicationLogged: false,
};

function doc(documentType: string): DocumentRecord {
  return {
    id: `d-${documentType}`,
    propertyId: "prop1",
    fileName: `${documentType}.pdf`,
    storagePath: `x/${documentType}.pdf`,
    documentType,
    uploadedAt: "2026-02-01T00:00:00Z",
    deletedAt: null,
  };
}

describe("caseRecordStage", () => {
  it("maps protest status to a record stage", () => {
    expect(caseRecordStage(protestWith({ status: "requested" }))).toBe("filing");
    expect(caseRecordStage(protestWith({ status: "offer_received" }))).toBe("informal");
    expect(caseRecordStage(protestWith({ status: "hearing_scheduled" }))).toBe("hearing");
    expect(caseRecordStage(protestWith({ status: "decision_received" }))).toBe("decision");
    expect(caseRecordStage(protestWith({ status: "arbitrating" }))).toBe("escalation");
    expect(caseRecordStage(protestWith({ status: "resolved" }))).toBe("resolved");
  });
});

describe("getCaseRecord", () => {
  it("marks the filing confirmation number outstanding once filed, on_file once entered", () => {
    const before = getCaseRecord(protestWith({}), noOpts).find(
      (i) => i.id === "filing_confirmation_number",
    )!;
    expect(before.status).toBe("outstanding");
    const after = getCaseRecord(
      protestWith({ filingConfirmationNumber: "PR-2026-99" }),
      noOpts,
    ).find((i) => i.id === "filing_confirmation_number")!;
    expect(after.status).toBe("on_file");
    expect(after.detail).toBe("PR-2026-99");
  });

  it("treats a Filing Confirmation OR a Filing Proof document as satisfying the confirmation doc item", () => {
    const withConf = getCaseRecord(protestWith({}), {
      ...noOpts,
      documents: [doc(CONFIRMATION_DOCUMENT_TYPE)],
    }).find((i) => i.id === "filing_confirmation_doc")!;
    expect(withConf.status).toBe("on_file");
  });

  it("only asks for certified mail when the filing channel is mail or unknown", () => {
    const mailed = getCaseRecord(protestWith({ filingChannel: "mail" }), noOpts).find(
      (i) => i.id === "certified_mail",
    )!;
    expect(mailed.status).toBe("outstanding");
    const online = getCaseRecord(protestWith({ filingChannel: "online" }), noOpts).find(
      (i) => i.id === "certified_mail",
    )!;
    expect(online.status).toBe("not_applicable");
  });

  it("marks the ARB order doc outstanding only once a decision is recorded", () => {
    const noDecision = getCaseRecord(protestWith({}), noOpts).find(
      (i) => i.id === "arb_order_doc",
    )!;
    expect(noDecision.status).toBe("not_applicable");
    const decided = getCaseRecord(
      protestWith({
        status: "decision_received",
        arbDecision: "denied",
        arbDecisionDate: "2026-07-01",
      }),
      noOpts,
    ).find((i) => i.id === "arb_order_doc")!;
    expect(decided.status).toBe("outstanding");
    const withDoc = getCaseRecord(
      protestWith({ status: "decision_received", arbDecision: "denied" }),
      { ...noOpts, documents: [doc(ARB_ORDER_DOCUMENT_TYPE)] },
    ).find((i) => i.id === "arb_order_doc")!;
    expect(withDoc.status).toBe("on_file");
  });

  it("confirms evidence submission from either the field or a transmittal document", () => {
    const confirmed = getCaseRecord(
      protestWith({ evidenceSubmittedConfirmedAt: "2026-06-15T00:00:00Z" }),
      noOpts,
    ).find((i) => i.id === "evidence_submission")!;
    expect(confirmed.status).toBe("on_file");
  });
});

describe("outstandingProofPrompts", () => {
  it("nags only for stages the case has already reached", () => {
    const protest = protestWith({ status: "filed" });
    const items = getCaseRecord(protest, noOpts);
    const prompts = outstandingProofPrompts(items, caseRecordStage(protest));
    // filing-stage items can be prompted…
    expect(prompts.some((p) => p.id === "filing_confirmation_number")).toBe(true);
    // …but nothing from a later stage (hearing/decision/escalation).
    expect(prompts.every((p) => ["filing"].includes(p.stage))).toBe(true);
  });

  it("includes informal-stage prompts once the case is at the informal stage", () => {
    const protest = protestWith({ status: "offer_received", settlementOfferValue: 480000 });
    const items = getCaseRecord(protest, noOpts);
    const prompts = outstandingProofPrompts(items, caseRecordStage(protest));
    expect(prompts.some((p) => p.stage === "informal")).toBe(true);
  });

  it("only prompts items that have a way to fulfil them", () => {
    const protest = protestWith({ status: "decision_received", arbDecision: "denied" });
    const items = getCaseRecord(protest, noOpts);
    const prompts = outstandingProofPrompts(items, caseRecordStage(protest));
    expect(prompts.every((p) => p.fulfil != null)).toBe(true);
  });
});

describe("caseRecordCompletion", () => {
  it("counts on-file over applicable, ignoring not-applicable items", () => {
    const items = getCaseRecord(protestWith({ filingChannel: "online" }), noOpts);
    const { onFile, applicable } = caseRecordCompletion(items);
    expect(onFile).toBeGreaterThanOrEqual(1); // notice_filed
    expect(applicable).toBeLessThan(items.length); // certified_mail is n/a for online
  });
});
