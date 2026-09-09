// Deterministic assembler for Module 10's "Full Case Report" — the
// consolidated protest playbook. It does NOT call the AI: it composes real
// case/property/county data with the outputs the other modules already
// generated (strategy, comps, evidence, executive) and the existing
// hearing-prep guide. Same discipline as case-guidance.ts / case-record.ts:
// every value is a straight function of state this app already holds.
import type { PropertyRecord } from "./properties";
import type { ProtestRecord } from "./protests";
import type { CountyProtestInfo } from "./county-protest-info";
import type { CaseGuidance } from "./case-guidance";
import type { CaseRecordItem } from "./case-record";
import type { PreFilingCheckItem } from "./pre-filing-check";
import type { DocumentRecord } from "./documents";
import type { HearingPrepGuide } from "./hearing-prep";
import { INFORMAL_STATUS_LABEL } from "./protests";
import {
  FILING_PROOF_DOCUMENT_TYPE,
  CONFIRMATION_DOCUMENT_TYPE,
  DECISION_DOCUMENT_TYPE,
  ARB_ORDER_DOCUMENT_TYPE,
  PROTEST_EVIDENCE_DOCUMENT_TYPE,
} from "./documents";

const money = (n: number | null | undefined): string =>
  n == null
    ? "—"
    : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const fmtDate = (iso: string | null | undefined): string =>
  iso
    ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : "—";

export type LabelValue = { label: string; value: string };

export type NextActionCategory =
  "completed" | "waiting_on_user" | "waiting_on_county" | "upcoming_deadline" | "next_step";

export type NextAction = {
  category: NextActionCategory;
  label: string;
  detail?: string;
  // The single most urgent item — exactly one action across the whole list.
  primary?: boolean;
};

export type ProtestCaseReport = {
  propertyInfo: LabelValue[];
  protestInfo: LabelValue[];
  valueAnalysis: {
    currentValue: string;
    targetValue: string;
    estimatedReduction: string;
    estimatedSavings: string;
    rationale: string[];
  };
  evidence: {
    uploaded: string[];
    accepted: string[];
    missing: string[];
    packetStatus: string;
    submissionStatus: string;
  };
  keyDocuments: {
    label: string;
    status: "on_file" | "missing" | "not_applicable";
    fileName?: string;
  }[];
  hearingGuide: {
    scheduled: boolean;
    dateTime: string;
    locationMode: string;
    whatToBring: string[];
    whatToSubmit: string[];
    whatToSayFirst: string;
    openingStatement: string;
    keyArguments: string[];
    comparableEvidence: string[];
    questionsToAsk: string[];
    questionsToExpect: string[];
    risks: string[];
    closingStatement: string;
    note: string;
  };
  countyInstructions: LabelValue[];
  nextActions: NextAction[];
  primaryAction: NextAction | null;
};

export type CaseReportComps = {
  indicated: { min: number; median: number; max: number } | null;
  valuationGapPct: number | null;
  ranked: { address: string; distanceMi: number; marketValue: number | null }[];
};

export type CaseReportInputs = {
  property: PropertyRecord;
  protest: ProtestRecord | null;
  countyInfo: CountyProtestInfo | null;
  guidance: CaseGuidance;
  caseRecordItems: CaseRecordItem[];
  preFilingItems: PreFilingCheckItem[] | null;
  documents: DocumentRecord[];
  // Module 8 (evidence) output — the checklist items with importance/availability.
  evidenceChecklist: { item: string; importance: "High" | "Low"; availability: "High" | "Low" }[];
  // Module 2 (strategy) top strategy name + why, for the value rationale.
  topStrategy: { name: string; whySelected: string } | null;
  // Module 10 (executive) recommendation + target value.
  executive: {
    recommendedAction: string;
    recommendedProtestValue: number | null;
    recommendedProtestValueBasis: string;
  } | null;
  comps: CaseReportComps | null;
  savings: { amount: number; reductionPct: number | null } | null;
  hearingGuide: HearingPrepGuide | null;
  noticeSignedAt: string | null;
};

function targetValueOf(i: CaseReportInputs): number | null {
  if (i.executive?.recommendedProtestValue != null) return i.executive.recommendedProtestValue;
  if (i.comps?.indicated) return i.comps.indicated.median;
  return null;
}

function filingStatusLabel(p: ProtestRecord | null): string {
  if (!p) return "Not started";
  switch (p.status) {
    case "requested":
      return "Prepared — not yet filed";
    case "filed":
    case "under_review":
      return "Filed with the county";
    default:
      return "Filed";
  }
}

function hearingStatusLabel(p: ProtestRecord | null): string {
  if (!p) return "—";
  if (p.status === "resolved") return "Concluded";
  if (p.arbDecision) return `Decision: ${p.arbDecision}`;
  if (p.hearingDate) return `Scheduled ${fmtDate(p.hearingDate)}`;
  if (p.status === "hearing_scheduled") return "Scheduled";
  return "Not scheduled";
}

function filingMethodLabel(c: CountyProtestInfo | null): string {
  if (!c) return "—";
  if (c.filingMethod.online)
    return `Online portal${c.filingMethod.online.url ? ` (${c.filingMethod.online.url})` : ""}`;
  if (c.filingMethod.mail) return `Mail: ${c.filingMethod.mail.address}`;
  if (c.filingMethod.inPerson) return `In person: ${c.filingMethod.inPerson.address}`;
  if (c.filingMethod.email?.address) return `Email: ${c.filingMethod.email.address}`;
  return "See county instructions";
}

function docStatus(
  docs: DocumentRecord[],
  types: string[],
): { status: "on_file" | "missing"; fileName?: string } {
  const hit = docs.find(
    (d) => d.deletedAt == null && d.documentType && types.includes(d.documentType),
  );
  return hit ? { status: "on_file", fileName: hit.fileName } : { status: "missing" };
}

export function buildCaseReport(i: CaseReportInputs): ProtestCaseReport {
  const { property: prop, protest: p, countyInfo: county } = i;
  const currentValue = prop.totalValue ?? p?.originalValue ?? null;
  const target = targetValueOf(i);
  const reduction =
    currentValue != null && target != null ? Math.max(0, currentValue - target) : null;

  // ── Property Information ──
  const propertyInfo: LabelValue[] = [
    { label: "Property address", value: prop.address || "—" },
    { label: "Account number", value: prop.accountNumber || "—" },
    { label: "Owner / entity", value: prop.ownerName || "—" },
    { label: "County", value: prop.cad || "—" },
    {
      label: "Tax year",
      value:
        p?.taxYear != null ? String(p.taxYear) : prop.taxYear != null ? String(prop.taxYear) : "—",
    },
    { label: "Property type", value: prop.propertyType || "—" },
  ];

  // ── Protest Information ──
  const protestInfo: LabelValue[] = [
    { label: "Protest deadline", value: fmtDate(prop.protestDeadline) },
    { label: "Filing method", value: filingMethodLabel(county) },
    { label: "Filing status", value: filingStatusLabel(p) },
    {
      label: "Filing confirmation",
      value: p?.filingConfirmationNumber
        ? `${p.filingConfirmationNumber}${p.filingChannel ? ` (${p.filingChannel.replace("_", " ")})` : ""}`
        : "Not recorded",
    },
    {
      label: "Informal review status",
      value: p ? INFORMAL_STATUS_LABEL[p.informalStatus] : "—",
    },
    { label: "Hearing status", value: hearingStatusLabel(p) },
  ];

  // ── Value Analysis ──
  const rationale: string[] = [];
  if (i.topStrategy)
    rationale.push(`Lead strategy — ${i.topStrategy.name}: ${i.topStrategy.whySelected}`);
  if (i.comps?.indicated) {
    rationale.push(
      `Comparable sales indicate a market value of about ${money(i.comps.indicated.median)} ` +
        `(range ${money(i.comps.indicated.min)}–${money(i.comps.indicated.max)})` +
        (i.comps.valuationGapPct != null
          ? `, ${Math.abs(i.comps.valuationGapPct)}% ${i.comps.valuationGapPct > 0 ? "below" : "above"} the CAD value.`
          : "."),
    );
  }
  if (i.executive?.recommendedProtestValueBasis)
    rationale.push(i.executive.recommendedProtestValueBasis);
  if (rationale.length === 0)
    rationale.push(
      "Generate the Strategy and Market Value modules for a grounded valuation rationale.",
    );

  const valueAnalysis = {
    currentValue: money(currentValue),
    targetValue: money(target),
    estimatedReduction: money(reduction),
    estimatedSavings: money(i.savings?.amount ?? null),
    rationale,
  };

  // ── Evidence ──
  const evidenceDocs = i.documents.filter(
    (d) => d.deletedAt == null && d.documentType === PROTEST_EVIDENCE_DOCUMENT_TYPE,
  );
  const missingEvidence = i.evidenceChecklist
    .filter((e) => e.availability === "Low")
    .map((e) => `${e.item}${e.importance === "High" ? " (high priority)" : ""}`);
  const evidenceSubmissionStatus = p?.evidenceSubmittedConfirmedAt
    ? `Submitted to the ARB (confirmed ${fmtDate(p.evidenceSubmittedConfirmedAt)})`
    : p?.hearingDate
      ? "Not yet submitted — Texas law requires it to reach the ARB before the hearing"
      : "No hearing scheduled yet";
  const evidence = {
    uploaded: evidenceDocs.map((d) => d.fileName),
    accepted: evidenceDocs.filter((d) => d.aiVerdict === "valid").map((d) => d.fileName),
    missing: missingEvidence,
    packetStatus:
      evidenceDocs.length === 0
        ? "Empty — upload supporting documents in Module 8"
        : `${evidenceDocs.length} document${evidenceDocs.length === 1 ? "" : "s"} in the packet`,
    submissionStatus: evidenceSubmissionStatus,
  };

  // ── Key Documents ──
  const agentFormNeeded = /agent|llc|inc|corp|trust|partners|properties/i.test(
    prop.ownerName ?? "",
  );
  const keyDocuments: ProtestCaseReport["keyDocuments"] = [
    {
      label: "Notice of Protest (Form 50-132)",
      ...(i.noticeSignedAt ? { status: "on_file" as const } : { status: "missing" as const }),
    },
    {
      label: "Appointment of Agent (Form 50-162)",
      status: agentFormNeeded
        ? docStatus(i.documents, ["Appointment of Agent"]).status
        : "not_applicable",
      fileName: agentFormNeeded
        ? docStatus(i.documents, ["Appointment of Agent"]).fileName
        : undefined,
    },
    {
      label: "Evidence packet",
      ...(evidenceDocs.length > 0
        ? { status: "on_file" as const }
        : { status: "missing" as const }),
    },
    (() => {
      const s = docStatus(i.documents, ["Hearing Notice"]);
      return {
        label: "Hearing notice",
        status: p?.hearingDate ? s.status : "not_applicable",
        fileName: s.fileName,
      };
    })(),
    (() => {
      const s = docStatus(i.documents, [DECISION_DOCUMENT_TYPE, ARB_ORDER_DOCUMENT_TYPE]);
      return {
        label: "Decision / ARB order",
        status: p?.arbDecision ? s.status : "not_applicable",
        fileName: s.fileName,
      };
    })(),
    (() => {
      const s = docStatus(i.documents, [FILING_PROOF_DOCUMENT_TYPE, CONFIRMATION_DOCUMENT_TYPE]);
      return {
        label: "Filing / submission confirmation",
        status: p && p.status !== "requested" ? s.status : "not_applicable",
        fileName: s.fileName,
      };
    })(),
  ];

  // ── Hearing Guide ── (reuses the existing hearing-prep guide when present)
  const g = i.hearingGuide;
  const hearingGuide: ProtestCaseReport["hearingGuide"] = {
    scheduled: !!p?.hearingDate,
    dateTime: p?.hearingDate
      ? `${fmtDate(p.hearingDate)}${p.hearingTime ? ` at ${p.hearingTime}` : ""}`
      : "Not scheduled",
    locationMode: [p?.hearingLocation, p?.hearingMode].filter(Boolean).join(" · ") || "—",
    whatToBring: g?.documentsToHave ?? g?.beforeHearing.documentsToHaveReady ?? [],
    whatToSubmit: g ? [g.submissionInstructions] : [],
    whatToSayFirst: g?.duringHearing.openingStatement?.split(". ")[0] ?? "",
    openingStatement: g?.duringHearing.openingStatement ?? "",
    keyArguments: g?.propertySpecificArguments ?? [],
    comparableEvidence:
      i.comps?.ranked.map(
        (c) => `${c.address} — ${c.distanceMi.toFixed(1)} mi, ${money(c.marketValue)}`,
      ) ?? [],
    questionsToAsk: g?.questionsToAsk ?? [],
    questionsToExpect: g?.questionsArbMayAsk ?? [],
    risks: g?.weaknessesAndRisks ?? [],
    closingStatement: g?.duringHearing.closingStatement ?? "",
    note: g
      ? g.disclaimer
      : p?.hearingDate
        ? "Open the Hearing Preparation guide in View Case to generate the full script for this section."
        : "The hearing script appears here once a hearing is scheduled.",
  };

  // ── County Instructions ──
  const countyInstructions: LabelValue[] = [
    {
      label: "County contact",
      value: county?.arbContact?.phone || county?.arbContact?.office || "—",
    },
    { label: "Email", value: county?.arbContact?.email || "—" },
    { label: "Portal / filing method", value: filingMethodLabel(county) },
    {
      label: "Submission instructions",
      value:
        g?.submissionInstructions || (county ? "Follow the county's filing method above." : "—"),
    },
    {
      label: "Evidence deadline",
      value:
        "At least 14 days before the hearing (Tax Code §41.67(d)) — deliver your evidence and witness list to the ARB by then, or you cannot rely on it.",
    },
    {
      label: "Informal review procedure",
      value:
        county?.informalReview?.howToRequest ||
        "Contact the appraisal district to request an informal review.",
    },
    { label: "Source", value: county?.sourceUrl || "—" },
  ];

  // ── Next Actions ──
  const nextActions: NextAction[] = [];
  const filed = !!p && p.status !== "requested";
  const deadlineFuture =
    prop.protestDeadline != null &&
    new Date(`${prop.protestDeadline}T23:59:59`).getTime() >= Date.now();

  // Completed
  if (filed) nextActions.push({ category: "completed", label: "Notice of Protest filed" });
  if (p?.settlementOfferValue != null)
    nextActions.push({
      category: "completed",
      label: `Informal offer received (${money(p.settlementOfferValue)})`,
    });
  if (p?.arbDecision)
    nextActions.push({ category: "completed", label: `ARB decision recorded (${p.arbDecision})` });
  if (p?.status === "resolved")
    nextActions.push({
      category: "completed",
      label: `Case resolved — final value ${money(p.finalValue)}`,
    });

  // Waiting on county
  if (p && (p.status === "filed" || p.status === "under_review"))
    nextActions.push({
      category: "waiting_on_county",
      label: "County to acknowledge the protest and schedule the next step",
    });
  if (p && p.informalStatus === "requested")
    nextActions.push({
      category: "waiting_on_county",
      label: "County to respond to the informal review request",
    });
  if (p?.status === "hearing_scheduled")
    nextActions.push({
      category: "waiting_on_county",
      label: `Formal hearing on ${fmtDate(p.hearingDate)}`,
    });

  // Upcoming deadlines
  if (deadlineFuture && !filed)
    nextActions.push({
      category: "upcoming_deadline",
      label: `Protest filing deadline — ${fmtDate(prop.protestDeadline)}`,
    });
  if (p?.hearingDate && !p.arbDecision) {
    const evDeadline = new Date(new Date(`${p.hearingDate}T00:00:00`).getTime() - 14 * 86400000);
    nextActions.push({
      category: "upcoming_deadline",
      label: `Evidence to the ARB by ${evDeadline.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`,
    });
  }

  // Waiting on user — from the real outstanding items
  const outstandingProof = i.caseRecordItems.filter(
    (it) => it.status === "outstanding" && it.fulfil != null,
  );
  for (const it of outstandingProof.slice(0, 5))
    nextActions.push({ category: "waiting_on_user", label: it.label, detail: it.detail });
  const blockedPreFiling = (i.preFilingItems ?? []).filter(
    (it) => it.blocking && it.status === "missing",
  );
  for (const it of blockedPreFiling)
    nextActions.push({ category: "waiting_on_user", label: `Provide: ${it.label}` });

  // Next step — the single prioritized action
  let primary: NextAction | null = null;
  if (blockedPreFiling.length > 0) {
    primary = {
      category: "next_step",
      label: `Complete required information: ${blockedPreFiling[0].label}`,
      primary: true,
    };
  } else if (!filed && deadlineFuture) {
    primary = {
      category: "next_step",
      label: i.noticeSignedAt
        ? `Deliver your signed Notice of Protest to the county before ${fmtDate(prop.protestDeadline)}`
        : `Review, sign, and file your Notice of Protest before ${fmtDate(prop.protestDeadline)}`,
      primary: true,
    };
  } else if (p && p.hearingDate && !p.evidenceSubmittedConfirmedAt && !p.arbDecision) {
    primary = {
      category: "next_step",
      label: "Assemble and submit your evidence packet to the ARB (due 14 days before the hearing)",
      primary: true,
    };
  } else if (outstandingProof.length > 0) {
    primary = {
      category: "next_step",
      label: outstandingProof[0].label,
      detail: outstandingProof[0].detail,
      primary: true,
    };
  } else if (i.guidance.nextSteps.length > 0) {
    primary = {
      category: "next_step",
      label: i.guidance.nextSteps[0].label,
      detail: i.guidance.nextSteps[0].detail,
      primary: true,
    };
  } else if (p?.status === "hearing_scheduled") {
    primary = {
      category: "next_step",
      label: `Attend your hearing on ${fmtDate(p.hearingDate)} and present your case using the Hearing Guide above`,
      primary: true,
    };
  } else if (p?.status === "decision_received" && !p.finalValue) {
    primary = {
      category: "next_step",
      label: "Record the ARB's decision, then review your escalation options",
      primary: true,
    };
  }
  if (primary) nextActions.unshift(primary);

  return {
    propertyInfo,
    protestInfo,
    valueAnalysis,
    evidence,
    keyDocuments,
    hearingGuide,
    countyInstructions,
    nextActions,
    primaryAction: primary,
  };
}
