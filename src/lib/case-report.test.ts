import { describe, it, expect } from "vitest";
import { buildCaseReport, type CaseReportInputs } from "./case-report";
import type { PropertyRecord } from "./properties";
import type { ProtestRecord } from "./protests";
import type { CaseGuidance } from "./case-guidance";
import { getCaseRecord } from "./case-record";

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
  estimatedSavings: null,
  savingsBasis: null,
  createdAt: "2026-01-01T00:00:00Z",
  valueHistory: null,
};

function protestWith(o: Partial<ProtestRecord>): ProtestRecord {
  return {
    id: "p1",
    propertyId: "prop-1",
    status: "filed",
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
    ...o,
  };
}

const guidance: CaseGuidance = {
  stage: "filed",
  stageLabel: "Filed — Under Review",
  summary: "s",
  nextSteps: [{ label: "Wait for the county", detail: "d" }],
  countyInfo: null,
};

function inputs(o: Partial<CaseReportInputs>): CaseReportInputs {
  const protest = o.protest ?? protestWith({});
  return {
    property,
    protest,
    countyInfo: null,
    guidance,
    caseRecordItems: getCaseRecord(protest, {
      documents: [],
      hearingNoticeOnFile: false,
      countyCommunicationLogged: false,
    }),
    preFilingItems: null,
    documents: [],
    evidenceChecklist: [],
    topStrategy: null,
    executive: null,
    comps: null,
    savings: null,
    hearingGuide: null,
    noticeSignedAt: null,
    ...o,
  };
}

describe("buildCaseReport — sections", () => {
  it("assembles property + protest info from real fields", () => {
    const r = buildCaseReport(inputs({}));
    expect(r.propertyInfo.find((x) => x.label === "Account number")!.value).toBe("R123456");
    expect(r.propertyInfo.find((x) => x.label === "Owner / entity")!.value).toBe(
      "Eastpark Holdings LLC",
    );
    expect(r.protestInfo.find((x) => x.label === "Filing status")!.value).toMatch(/Filed/);
  });

  it("takes the target value from the executive recommendation, then comps median", () => {
    const withExec = buildCaseReport(
      inputs({
        executive: {
          recommendedAction: "Proceed with Protest",
          recommendedProtestValue: 10_800_000,
          recommendedProtestValueBasis: "Based on the comparable-sales range.",
        },
      }),
    );
    expect(withExec.valueAnalysis.targetValue).toMatch(/10,800,000/);
    expect(withExec.valueAnalysis.estimatedReduction).toMatch(/1,700,000/);

    const withComps = buildCaseReport(
      inputs({
        comps: {
          indicated: { min: 10_000_000, median: 11_000_000, max: 12_000_000 },
          valuationGapPct: 12,
          ranked: [],
        },
      }),
    );
    expect(withComps.valueAnalysis.targetValue).toMatch(/11,000,000/);
  });

  it("lists missing evidence from the Module 8 checklist, high priority flagged", () => {
    const r = buildCaseReport(
      inputs({
        evidenceChecklist: [
          { item: "Recent appraisal", importance: "High", availability: "Low" },
          { item: "Photos", importance: "Low", availability: "High" },
        ],
      }),
    );
    expect(r.evidence.missing).toEqual(["Recent appraisal (high priority)"]);
  });

  it("reuses the hearing-prep guide for the hearing section when present", () => {
    const r = buildCaseReport(
      inputs({
        protest: protestWith({
          status: "hearing_scheduled",
          hearingDate: "2099-08-01",
          hearingTime: "10:00 AM",
        }),
        hearingGuide: {
          hearingSummary: "",
          evidencePacketNote: "",
          beforeHearing: {
            whatToReview: [],
            documentsToHaveReady: ["Comp grid"],
            valueToRequest: "",
            keyEvidence: [],
            howToOrganize: "",
            questionPrep: "",
          },
          duringHearing: {
            openingStatement: "Good morning. I am protesting the value.",
            valueExplanation: "",
            comparableEvidencePresentation: "",
            conditionArguments: "",
            requestedValue: "",
            closingStatement: "I respectfully request the value be reduced.",
          },
          propertySpecificArguments: ["The CAD value exceeds market by 12%"],
          questionsToAsk: ["What comps did you use?"],
          questionsArbMayAsk: ["Have you had an appraisal?"],
          weaknessesAndRisks: ["No recent sale of the subject"],
          documentsToHave: ["Comp grid", "Photos"],
          submissionInstructions: "Email evidence to the ARB 14 days before.",
          countyContact: "",
          hearingLogistics: "",
          disclaimer: "General guidance, not legal advice.",
        },
      }),
    );
    expect(r.hearingGuide.scheduled).toBe(true);
    expect(r.hearingGuide.openingStatement).toMatch(/Good morning/);
    expect(r.hearingGuide.keyArguments).toContain("The CAD value exceeds market by 12%");
    expect(r.hearingGuide.questionsToExpect).toContain("Have you had an appraisal?");
  });
});

describe("buildCaseReport — next actions & priority", () => {
  it("prioritises filing when not yet filed and the deadline is ahead", () => {
    const r = buildCaseReport(inputs({ protest: protestWith({ status: "requested" }) }));
    expect(r.primaryAction?.label).toMatch(/file your Notice of Protest/i);
    expect(r.nextActions[0]).toBe(r.primaryAction);
  });

  it("prioritises evidence submission once a hearing is scheduled", () => {
    const r = buildCaseReport(
      inputs({ protest: protestWith({ status: "hearing_scheduled", hearingDate: "2099-08-01" }) }),
    );
    expect(r.primaryAction?.label).toMatch(/evidence packet to the ARB/i);
    expect(
      r.nextActions.some(
        (a) => a.category === "upcoming_deadline" && /Evidence to the ARB/.test(a.label),
      ),
    ).toBe(true);
    expect(r.nextActions.some((a) => a.category === "waiting_on_county")).toBe(true);
  });

  it("marks filed / offer / decision milestones completed", () => {
    const r = buildCaseReport(
      inputs({
        protest: protestWith({
          status: "decision_received",
          settlementOfferValue: 480000,
          arbDecision: "partial",
          finalValue: 11_800_000,
        }),
      }),
    );
    const completed = r.nextActions.filter((a) => a.category === "completed").map((a) => a.label);
    expect(completed.some((l) => /filed/i.test(l))).toBe(true);
    expect(completed.some((l) => /Informal offer received/i.test(l))).toBe(true);
    expect(completed.some((l) => /ARB decision recorded/i.test(l))).toBe(true);
  });

  it("always states an evidence deadline of 14 days before the hearing", () => {
    const r = buildCaseReport(inputs({}));
    expect(r.countyInstructions.find((x) => x.label === "Evidence deadline")!.value).toMatch(
      /14 days/,
    );
  });
});
