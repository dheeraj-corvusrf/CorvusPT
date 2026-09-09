// End-to-end "internal scenarios" coverage for the View Case flow: walk one
// synthetic case through every ProtestStatus and run all the deterministic
// engines the CaseDetailModal + Module 10 + Module 9 sections depend on
// (guidance, case record, escalation evaluation, consolidated case report,
// final case summary). Asserts they stay coherent and never throw at any
// stage — the failure mode that a status-by-status render walk would catch.
import { describe, it, expect } from "vitest";
import type { PropertyRecord } from "./properties";
import type { ProtestRecord, ProtestStatus, InformalStatus } from "./protests";
import { getCaseGuidance } from "./case-guidance";
import { getCaseRecord, caseRecordStage, outstandingProofPrompts } from "./case-record";
import { evaluateEscalation } from "./escalation-eval";
import { buildCaseReport } from "./case-report";
import { buildFinalCaseSummary } from "./final-case-summary";
import { getCountyProtestInfo } from "./county-protest-info";

const property: PropertyRecord = {
  id: "prop-1",
  address: "3330 Eastpark Blvd, Denton, TX 76208",
  cad: "Denton Central Appraisal District",
  accountNumber: "R123456",
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

const BASE: ProtestRecord = {
  id: "p1",
  propertyId: "prop-1",
  status: "requested",
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
};

// One representative record per status, shaped the way that status really
// occurs (an offer_received row has an offer; a decision_received row has an
// ARB decision + date; a resolved row has a final value + close date).
const SCENARIOS: { status: ProtestStatus; patch: Partial<ProtestRecord> }[] = [
  { status: "requested", patch: {} },
  { status: "filed", patch: { filingConfirmationNumber: "PR-1", filingChannel: "online" } },
  { status: "under_review", patch: { informalStatus: "requested" } },
  {
    status: "offer_received",
    patch: {
      informalStatus: "proposed_value_received",
      settlementOfferValue: 11_900_000,
      settlementOfferReceivedAt: "2026-06-01",
    },
  },
  {
    status: "hearing_scheduled",
    patch: {
      informalStatus: "rejected",
      hearingDate: "2026-08-01",
      hearingTime: "10:00 AM",
      hearingLocation: "Denton CAD",
      hearingMode: "In Person",
    },
  },
  {
    status: "decision_received",
    patch: {
      informalStatus: "rejected",
      hearingDate: "2026-08-01",
      arbDecision: "partial",
      arbDecisionDate: "2026-08-05",
      finalValue: 12_000_000,
    },
  },
  {
    status: "appealing",
    patch: {
      informalStatus: "rejected",
      arbDecision: "denied",
      arbDecisionDate: "2026-08-05",
      escalationPath: "appeal",
    },
  },
  {
    status: "arbitrating",
    patch: {
      informalStatus: "rejected",
      arbDecision: "partial",
      arbDecisionDate: "2026-08-05",
      finalValue: 12_000_000,
      escalationPath: "arbitration",
    },
  },
  {
    status: "resolved",
    patch: {
      informalStatus: "rejected",
      arbDecision: "partial",
      arbDecisionDate: "2026-08-05",
      finalValue: 11_400_000,
      escalationPath: "accept",
      closedAt: "2026-08-10T00:00:00Z",
    },
  },
];

const county = getCountyProtestInfo(property.cad);

function run(protest: ProtestRecord) {
  const guidance = getCaseGuidance(property, protest, 2, county, null);
  const recordItems = getCaseRecord(protest, {
    documents: [],
    hearingNoticeOnFile: !!(protest.hearingLocation || protest.hearingTime),
    countyCommunicationLogged: false,
  });
  const escalation = evaluateEscalation(property, protest, 3, 11_000_000);
  const report = buildCaseReport({
    property,
    protest,
    countyInfo: county,
    guidance,
    caseRecordItems: recordItems,
    preFilingItems: null,
    documents: [],
    evidenceChecklist: [{ item: "Recent appraisal", importance: "High", availability: "Low" }],
    topStrategy: { name: "Equity", whySelected: "1.07 ratio" },
    executive: {
      recommendedAction: "Proceed with Protest",
      recommendedProtestValue: 11_000_000,
      recommendedProtestValueBasis: "From the comparable-sales range.",
    },
    comps: {
      indicated: { min: 10_000_000, median: 11_000_000, max: 12_000_000 },
      valuationGapPct: 12,
      ranked: [],
    },
    savings: { amount: 30_000, reductionPct: 12 },
    hearingGuide: null,
    noticeSignedAt: null,
  });
  const finalSummary = buildFinalCaseSummary(property, protest, {
    recommendedNextStep: guidance.nextSteps[0]?.label ?? null,
  });
  return { guidance, recordItems, escalation, report, finalSummary };
}

describe("View Case — every stage runs the case engines without error", () => {
  for (const { status, patch } of SCENARIOS) {
    it(`status "${status}" produces coherent guidance / record / escalation / report / summary`, () => {
      const protest: ProtestRecord = { ...BASE, status, ...patch };
      const out = run(protest);

      // Guidance always resolves to a labelled stage.
      expect(out.guidance.stage).toBeTruthy();
      expect(out.guidance.stageLabel).toBeTruthy();
      expect(out.guidance.summary.length).toBeGreaterThan(0);

      // Case record is non-empty and every item has a valid status.
      expect(out.recordItems.length).toBeGreaterThan(5);
      for (const it of out.recordItems)
        expect(["on_file", "outstanding", "not_applicable"]).toContain(it.status);
      expect(["filing", "informal", "hearing", "decision", "escalation", "resolved"]).toContain(
        caseRecordStage(protest),
      );
      // Prompts only ever point at fulfillable, already-reached-stage items.
      for (const p of outstandingProofPrompts(out.recordItems, caseRecordStage(protest)))
        expect(p.fulfil).not.toBeNull();

      // Escalation panel is available ONLY after informal + ARB both closed
      // unfavourably.
      const shouldOffer =
        (protest.informalStatus === "rejected" ||
          protest.informalStatus === "no_informal_available") &&
        (protest.arbDecision === "denied" || protest.arbDecision === "partial");
      expect(out.escalation.available).toBe(shouldOffer);
      expect(out.escalation.options.length).toBeGreaterThan(0);
      expect(out.escalation.disclaimer).toMatch(/not a prediction or guarantee/i);

      // Consolidated report always has all eight sections + next actions.
      expect(out.report.propertyInfo.length).toBe(6);
      expect(out.report.protestInfo.length).toBe(6);
      expect(out.report.countyInstructions.length).toBeGreaterThan(4);
      expect(out.report.keyDocuments.length).toBeGreaterThan(3);
      expect(out.report.nextActions.length).toBeGreaterThan(0);
      // A not-yet-resolved case always surfaces exactly one prioritised action.
      if (protest.status !== "resolved") expect(out.report.primaryAction).not.toBeNull();

      // Final summary availability tracks "process concluded".
      const concluded =
        protest.status === "resolved" ||
        protest.arbDecision != null ||
        protest.informalStatus === "accepted";
      expect(out.finalSummary.available).toBe(concluded);
      if (out.finalSummary.available) {
        if (protest.status === "resolved" && !out.finalSummary.remainingEscalationDeadline) {
          expect(out.finalSummary.status.kind).toBe("closed");
          expect(out.finalSummary.status.label).toBe("Case Closed");
        } else {
          expect(out.finalSummary.status.kind).toBe("action_required");
        }
      }
    });
  }
});

describe("View Case — informal-accepted branch closes without a hearing", () => {
  it("an accepted informal offer yields a final summary and no escalation", () => {
    const protest: ProtestRecord = {
      ...BASE,
      status: "resolved",
      informalStatus: "accepted",
      settlementOfferValue: 11_600_000,
      settlementOfferReceivedAt: "2026-06-01",
      finalValue: 11_600_000,
      escalationPath: "accept",
      closedAt: "2026-06-05T00:00:00Z",
    };
    const out = run(protest);
    expect(out.escalation.available).toBe(false);
    expect(out.finalSummary.available).toBe(true);
    expect(out.finalSummary.status.label).toBe("Case Closed");
    expect(out.finalSummary.informalOutcome).toMatch(/Accepted/i);
    expect(out.finalSummary.hearingOutcome).toMatch(/No formal hearing/i);
  });
});

describe("View Case — no protest yet (Module 10 preview path)", () => {
  it("buildFinalCaseSummary + buildCaseReport tolerate a null protest", () => {
    const guidance = getCaseGuidance(property, { ...BASE }, 0, county, null);
    const report = buildCaseReport({
      property,
      protest: null,
      countyInfo: county,
      guidance,
      caseRecordItems: [],
      preFilingItems: null,
      documents: [],
      evidenceChecklist: [],
      topStrategy: null,
      executive: null,
      comps: null,
      savings: null,
      hearingGuide: null,
      noticeSignedAt: null,
    });
    expect(report.propertyInfo.length).toBe(6);
    expect(report.protestInfo.find((r) => r.label === "Filing status")!.value).toBe("Not started");
    expect(buildFinalCaseSummary(property, null).available).toBe(false);
  });
});
