// Deterministic "complete case record" model — what proof/record items a
// fully-documented protest case should hold, which are on file, and which are
// still outstanding *for a stage the case has already reached* (the staged
// "upload this now" prompt). Same discipline as case-guidance.ts: every
// status here is a straight function of real fields already on the case, its
// real uploaded documents, or its audit trail. No AI.
import type { ProtestRecord } from "./protests";
import type { DocumentRecord } from "./documents";
import {
  FILING_PROOF_DOCUMENT_TYPE,
  CONFIRMATION_DOCUMENT_TYPE,
  CORRESPONDENCE_DOCUMENT_TYPE,
  EVIDENCE_SUBMISSION_DOCUMENT_TYPE,
  ARB_ORDER_DOCUMENT_TYPE,
  ESCALATION_DOCUMENT_TYPE,
  DECISION_DOCUMENT_TYPE,
} from "./documents";

export type CaseRecordStage =
  "filing" | "informal" | "hearing" | "decision" | "escalation" | "resolved";

const STAGE_ORDER: CaseRecordStage[] = [
  "filing",
  "informal",
  "hearing",
  "decision",
  "escalation",
  "resolved",
];

// Which record stage the case has reached, from its real status.
export function caseRecordStage(protest: ProtestRecord): CaseRecordStage {
  switch (protest.status) {
    case "requested":
    case "filed":
    case "under_review":
      return "filing";
    case "offer_received":
      return "informal";
    case "hearing_scheduled":
      return "hearing";
    case "decision_received":
      return "decision";
    case "appealing":
    case "arbitrating":
      return "escalation";
    case "resolved":
      return "resolved";
    default:
      return "filing";
  }
}

export type CaseRecordItemStatus = "on_file" | "outstanding" | "not_applicable";

export type CaseRecordItem = {
  id: string;
  label: string;
  stage: CaseRecordStage;
  status: CaseRecordItemStatus;
  // A short rendering of what's on file (a value, a date, a filename) when
  // status is on_file; a nudge of what to add when outstanding.
  detail: string;
  // How the user satisfies this item, if it isn't automatic:
  //  - "document": upload a file tagged `docType`
  //  - "field": fill a text/date field (handled by CaseRecordSection)
  //  - null: derived from other actions, nothing to do here
  fulfil: "document" | "field" | null;
  docType?: string;
};

type Opts = {
  documents: DocumentRecord[];
  hearingNoticeOnFile: boolean;
  countyCommunicationLogged: boolean;
};

const has = (docs: DocumentRecord[], type: string) =>
  docs.some((d) => d.documentType === type && d.deletedAt == null);

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

export function getCaseRecord(protest: ProtestRecord, opts: Opts): CaseRecordItem[] {
  const { documents: docs } = opts;
  const filed = protest.status !== "requested";
  const mailFiling = protest.filingChannel === "mail" || protest.filingChannel == null;

  const items: CaseRecordItem[] = [
    {
      id: "notice_filed",
      label: "Notice of Protest filed with the county",
      stage: "filing",
      status: filed ? "on_file" : "outstanding",
      detail: filed
        ? "Recorded as filed."
        : "Sign and deliver your Notice of Protest, then mark it filed below.",
      fulfil: null,
    },
    {
      id: "filing_confirmation_number",
      label: "Filing confirmation number",
      stage: "filing",
      status: protest.filingConfirmationNumber
        ? "on_file"
        : filed
          ? "outstanding"
          : "not_applicable",
      detail: protest.filingConfirmationNumber
        ? protest.filingConfirmationNumber
        : "The confirmation/case number the portal, email, or clerk gave you.",
      fulfil: "field",
    },
    {
      id: "filing_confirmation_doc",
      label: "Filing confirmation — portal screenshot or email",
      stage: "filing",
      status:
        has(docs, CONFIRMATION_DOCUMENT_TYPE) || has(docs, FILING_PROOF_DOCUMENT_TYPE)
          ? "on_file"
          : filed
            ? "outstanding"
            : "not_applicable",
      detail:
        has(docs, CONFIRMATION_DOCUMENT_TYPE) || has(docs, FILING_PROOF_DOCUMENT_TYPE)
          ? "On file."
          : "A screenshot of the portal confirmation page, or the confirmation email.",
      fulfil: "document",
      docType: CONFIRMATION_DOCUMENT_TYPE,
    },
    {
      id: "certified_mail",
      label: "Certified-mail receipt & tracking number",
      stage: "filing",
      status: !mailFiling
        ? "not_applicable"
        : protest.certifiedMailTracking || has(docs, CONFIRMATION_DOCUMENT_TYPE)
          ? "on_file"
          : filed
            ? "outstanding"
            : "not_applicable",
      detail: !mailFiling
        ? "Not filed by mail."
        : protest.certifiedMailTracking
          ? `Tracking ${protest.certifiedMailTracking}`
          : "The green certified-mail receipt and its tracking number prove timely mailing.",
      fulfil: "field",
    },
    {
      id: "county_correspondence",
      label: "Informal correspondence & county staff notes",
      stage: "informal",
      status:
        has(docs, CORRESPONDENCE_DOCUMENT_TYPE) || opts.countyCommunicationLogged
          ? "on_file"
          : "outstanding",
      detail:
        has(docs, CORRESPONDENCE_DOCUMENT_TYPE) || opts.countyCommunicationLogged
          ? "On file."
          : "Log calls/emails with the appraisal district, and upload any letters they send.",
      fulfil: "document",
      docType: CORRESPONDENCE_DOCUMENT_TYPE,
    },
    {
      id: "informal_proposed_value",
      label: "Informal proposed value",
      stage: "informal",
      status:
        protest.settlementOfferValue != null
          ? "on_file"
          : protest.informalStatus === "no_informal_available"
            ? "not_applicable"
            : "outstanding",
      detail:
        protest.settlementOfferValue != null
          ? fmtMoney(protest.settlementOfferValue)
          : "Record the value the appraiser offered at the informal review.",
      fulfil: null,
    },
    {
      id: "informal_result",
      label: "Informal result — accepted or rejected",
      stage: "informal",
      status: ["accepted", "rejected", "no_informal_available"].includes(protest.informalStatus)
        ? "on_file"
        : "outstanding",
      detail: `Informal status: ${protest.informalStatus}.`,
      fulfil: null,
    },
    {
      id: "hearing_notice",
      label: "Formal hearing notice",
      stage: "hearing",
      status: opts.hearingNoticeOnFile || protest.hearingDate ? "on_file" : "outstanding",
      detail: opts.hearingNoticeOnFile
        ? "Hearing notice uploaded."
        : protest.hearingDate
          ? `Hearing date ${protest.hearingDate} recorded.`
          : "Upload the hearing notice the ARB mailed you.",
      fulfil: null,
    },
    {
      id: "evidence_submission",
      label: "Evidence submission to the ARB — confirmed",
      stage: "hearing",
      status:
        protest.evidenceSubmittedConfirmedAt || has(docs, EVIDENCE_SUBMISSION_DOCUMENT_TYPE)
          ? "on_file"
          : "outstanding",
      detail:
        protest.evidenceSubmittedConfirmedAt || has(docs, EVIDENCE_SUBMISSION_DOCUMENT_TYPE)
          ? "Confirmed."
          : "Texas law requires your evidence to reach the ARB before the hearing. Confirm you sent it, or upload the transmittal receipt.",
      fulfil: "field",
    },
    {
      id: "arb_decision",
      label: "Hearing result — ARB decision recorded",
      stage: "decision",
      status: protest.arbDecision ? "on_file" : "outstanding",
      detail: protest.arbDecision
        ? `ARB decision: ${protest.arbDecision}${
            protest.arbDecisionDate ? ` on ${protest.arbDecisionDate}` : ""
          }.`
        : "Record the ARB's decision in Case Progress.",
      fulfil: null,
    },
    {
      id: "arb_order_doc",
      label: "ARB order document",
      stage: "decision",
      status:
        has(docs, ARB_ORDER_DOCUMENT_TYPE) || has(docs, DECISION_DOCUMENT_TYPE)
          ? "on_file"
          : protest.arbDecision
            ? "outstanding"
            : "not_applicable",
      detail:
        has(docs, ARB_ORDER_DOCUMENT_TYPE) || has(docs, DECISION_DOCUMENT_TYPE)
          ? "On file."
          : "Upload the written ARB order (Form 50-230) the board issued.",
      fulfil: "document",
      docType: ARB_ORDER_DOCUMENT_TYPE,
    },
    {
      id: "final_value",
      label: "Final value",
      stage: "decision",
      status: protest.finalValue != null ? "on_file" : "outstanding",
      detail:
        protest.finalValue != null
          ? fmtMoney(protest.finalValue)
          : "The determined value once the case resolves.",
      fulfil: null,
    },
    {
      id: "escalation_docs",
      label: "Escalation documents",
      stage: "escalation",
      status: has(docs, ESCALATION_DOCUMENT_TYPE)
        ? "on_file"
        : protest.escalationPath === "appeal" || protest.escalationPath === "arbitration"
          ? "outstanding"
          : "not_applicable",
      detail: has(docs, ESCALATION_DOCUMENT_TYPE)
        ? "On file."
        : "Upload the arbitration request / court petition and any filing receipts.",
      fulfil: "document",
      docType: ESCALATION_DOCUMENT_TYPE,
    },
    {
      id: "final_status",
      label: "Final case status",
      stage: "resolved",
      status: protest.status === "resolved" ? "on_file" : "outstanding",
      detail:
        protest.status === "resolved"
          ? `Resolved${protest.closedAt ? ` on ${protest.closedAt.slice(0, 10)}` : ""}.`
          : "Set once the case is closed.",
      fulfil: null,
    },
  ];

  return items;
}

// The staged prompt: outstanding items whose stage the case has ALREADY
// reached (or passed) — "you should have this on file by now." Items for
// future stages are intentionally not nagged yet.
export function outstandingProofPrompts(
  items: CaseRecordItem[],
  stage: CaseRecordStage,
): CaseRecordItem[] {
  const reached = STAGE_ORDER.indexOf(stage);
  return items.filter(
    (i) =>
      i.status === "outstanding" && STAGE_ORDER.indexOf(i.stage) <= reached && i.fulfil != null,
  );
}

export function caseRecordCompletion(items: CaseRecordItem[]): {
  onFile: number;
  applicable: number;
} {
  const applicable = items.filter((i) => i.status !== "not_applicable");
  return {
    onFile: applicable.filter((i) => i.status === "on_file").length,
    applicable: applicable.length,
  };
}
