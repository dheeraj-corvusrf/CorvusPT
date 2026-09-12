// "What do I need to do next?" for a single property's case — the deterministic
// engine behind the AI Report page's Case Progress card. Reuses the exact same
// primitives View Case itself is built on (requiredFilingSteps/FILING_STEP_META/
// isFilingStepDone from filing-workflow.ts, getCaseGuidance from case-guidance.ts,
// getPreFilingCheck from pre-filing-check.ts) so the terminology and the "what's
// current" verdict can never drift from what View Case's own Prepare & File tab
// and Corvus AI Guidance panel say — one set of rules, two surfaces.
//
// New workflows should extend `POST_FILE_PHASES` (and, if View Case grows a new
// filing sub-step, FilingStepId/FILING_STEP_META in filing-workflow.ts) rather
// than adding another branch here — the timeline and action-selection logic
// walk those tables generically.
import type { PropertyRecord } from "./properties";
import type { ProtestRecord } from "./protests";
import { getCountyProtestInfo, type CountyProtestInfo } from "./county-protest-info";
import { getCaseGuidance, type CaseStage } from "./case-guidance";
import { getPreFilingCheck, isPreFilingBlocked } from "./pre-filing-check";
import { getSubmission } from "./protest-form-submissions";
import {
  requiredFilingSteps,
  FILING_STEP_META,
  isFilingStepDone,
  firstIncompleteFilingStep,
  type FilingStepId,
  type FilingStepStatusInput,
} from "./filing-workflow";

export type CaseActionStageId = FilingStepId | "informal" | "hearing" | "decision";
export type CaseActionStatus = "done" | "current" | "upcoming";

export type CaseTimelineEntry = {
  id: CaseActionStageId;
  label: string;
  status: CaseActionStatus;
};

export type CaseNextActionButton = {
  label: string;
  // "internal" always means View Case for this property — the one place the
  // action is actually taken; "external" is a real, county-specific URL
  // (never a fabricated one — only ever countyInfo's own verified filingMethod).
  kind: "internal" | "external";
  href: string;
};

export type CaseNextAction = {
  // Every applicable stage shown together (not just the current one) — a
  // stage this case doesn't need (e.g. Agent/Representative for a
  // self-representing owner) is simply absent, not shown as skipped.
  timeline: CaseTimelineEntry[];
  summary: string;
  // null exactly once there's genuinely nothing left to do (case resolved).
  action: CaseNextActionButton | null;
};

const VIEW_CASE_HREF = "/dashboard/case";

// The post-filing phases, in order, with the real View Case tab/label they
// correspond to — "escalation" folds into "Decision & Appeal" because that's
// the one tab View Case itself shows for both (see CaseDetailModal.tsx's
// caseTabUnlocked "decision" case), not a separate phase of its own.
const POST_FILE_PHASES: {
  id: "informal" | "hearing" | "decision";
  label: string;
  stages: CaseStage[];
}[] = [
  { id: "informal", label: "Informal Review", stages: ["informal_review"] },
  { id: "hearing", label: "Formal Hearing", stages: ["hearing"] },
  { id: "decision", label: "Decision & Appeal", stages: ["decision", "escalation"] },
];

const STAGE_RANK: Record<CaseStage, number> = {
  prepare_file: 0,
  filed: 1,
  informal_review: 2,
  hearing: 3,
  decision: 4,
  escalation: 4,
  resolved: 5,
};

function isExternalAnchor(anchor: string): boolean {
  return anchor.startsWith("http") || anchor.startsWith("tel:") || anchor.startsWith("mailto:");
}

// --- Still in Prepare & File (protest.status === "requested") --------------

function computePrepareFileAction(
  property: PropertyRecord,
  protest: ProtestRecord,
  evidenceCount: number,
  countyInfo: CountyProtestInfo | null,
  noticeSignedAt: string | null,
  noticeHearingAppearance: string | null,
  agentFormSignedAt: string | null,
  evidenceDeclarationSignedAt: string | null,
): CaseNextAction {
  const steps = requiredFilingSteps({
    attendanceType: protest.attendanceType,
    hasAgentAuthorization: false,
    hearingAppearance: noticeHearingAppearance,
  });
  const preFilingItems = getPreFilingCheck(property, protest, evidenceCount);
  const preFilingBlocked = isPreFilingBlocked(preFilingItems);
  const status: FilingStepStatusInput = {
    preFilingBlocked,
    noticeSignedAt,
    agentFormSignedAt,
    evidenceDeclarationSignedAt,
    evidenceSubmittedConfirmedAt: protest.evidenceSubmittedConfirmedAt ?? null,
  };

  const requiresPrepForm = steps.includes("agent") || steps.includes("affidavit");
  const allStepsDone = steps.every((id) => isFilingStepDone(id, status));
  const firstIncomplete = firstIncompleteFilingStep(steps, status);

  // The one remaining real task is getting the already-signed, already-
  // prepared packet to the county — either everything required is done and
  // only delivery/confirmation is left, or (the simplest case: no Agent/
  // Affidavit needed) the Notice is signed and Evidence is the only other
  // open item, so nothing stands between "signed" and "deliver it."
  const deliverToCounty =
    !preFilingBlocked &&
    !!noticeSignedAt &&
    (allStepsDone || (!requiresPrepForm && firstIncomplete === "evidence"));

  const onlineUrl = countyInfo?.filingMethod.online?.url ?? null;

  let current: FilingStepId;
  let summary: string;
  let action: CaseNextActionButton;

  if (preFilingBlocked) {
    current = "file";
    summary = "Corvus needs you to confirm or correct a detail before this case can be filed.";
    action = { label: "Resolve in View Case", kind: "internal", href: VIEW_CASE_HREF };
  } else if (deliverToCounty) {
    current = "file";
    summary = allStepsDone
      ? "Everything is prepared. Deliver your filing to the county, then confirm it in View Case."
      : "Your Notice of Protest is signed. Deliver it to the county to complete filing.";
    action = onlineUrl
      ? { label: "Go to County CAD", kind: "external", href: onlineUrl }
      : { label: "How to File", kind: "internal", href: VIEW_CASE_HREF };
  } else {
    current = firstIncomplete === "prefiling" ? "file" : firstIncomplete;
    summary = FILING_STEP_META[current].blurb;
    action = { label: FILING_STEP_META[current].label, kind: "internal", href: VIEW_CASE_HREF };
  }

  const timeline: CaseTimelineEntry[] = [
    ...steps
      .filter((id): id is Exclude<FilingStepId, "prefiling"> => id !== "prefiling")
      .map((id) => {
        // "File Protest" stays "current" (not "done") for as long as delivery
        // is the open task, even though signing alone already satisfies
        // isFilingStepDone("file") for View Case's own step bar — that step
        // bar's job is "can I move on to the next form," this timeline's job
        // is "is this case actually filed with the county."
        const status2: CaseActionStatus =
          id === "file" && (deliverToCounty || allStepsDone)
            ? "current"
            : isFilingStepDone(id, status)
              ? "done"
              : id === current
                ? "current"
                : "upcoming";
        return { id, label: FILING_STEP_META[id].label, status: status2 };
      }),
    ...POST_FILE_PHASES.map((p) => ({ id: p.id, label: p.label, status: "upcoming" as const })),
  ];

  return { timeline, summary, action };
}

// --- Filed or beyond (protest.status !== "requested") -----------------------

function computeFiledOnwardsAction(
  property: PropertyRecord,
  protest: ProtestRecord,
  evidenceCount: number,
  countyInfo: CountyProtestInfo | null,
): CaseNextAction {
  // Same real, deterministic stage/summary/next-step engine View Case's own
  // Corvus AI Guidance panel and roadmap read from — noticeSignedAt is only
  // meaningful to getCaseGuidance's "prepare_file" branch, which can't be
  // reached here since protest.status is no longer "requested".
  const guidance = getCaseGuidance(property, protest, evidenceCount, countyInfo, null);
  const currentRank = STAGE_RANK[guidance.stage];

  const timeline: CaseTimelineEntry[] = [
    { id: "file", label: "File Protest", status: "done" },
    ...POST_FILE_PHASES.map((p) => ({
      id: p.id,
      label: p.label,
      status: (STAGE_RANK[p.stages[0]] < currentRank
        ? "done"
        : p.stages.includes(guidance.stage)
          ? "current"
          : "upcoming") as CaseActionStatus,
    })),
  ];

  const next = guidance.nextSteps[0];
  let action: CaseNextActionButton | null = null;
  if (next) {
    action =
      next.action && isExternalAnchor(next.action.anchor)
        ? { label: next.action.label, kind: "external", href: next.action.anchor }
        : { label: next.label, kind: "internal", href: VIEW_CASE_HREF };
  }

  return { timeline, summary: guidance.summary, action };
}

// --- Public API --------------------------------------------------------------

// The pure, synchronous decision — everything the caller already has to hand.
// Split out from getCaseNextAction() below purely so it's unit-testable
// without a Supabase round trip (same pattern as pre-filing-check.ts /
// case-guidance.ts elsewhere in this app).
export type CaseNextActionInputs = {
  property: PropertyRecord;
  protest: ProtestRecord;
  evidenceCount: number;
  countyInfo: CountyProtestInfo | null;
  // Only read while protest.status === "requested" — ignored (and never
  // fetched by getCaseNextAction) once the case has moved on.
  noticeSignedAt: string | null;
  noticeHearingAppearance: string | null;
  agentFormSignedAt: string | null;
  evidenceDeclarationSignedAt: string | null;
};

export function computeCaseNextAction(input: CaseNextActionInputs): CaseNextAction {
  const { property, protest, evidenceCount, countyInfo } = input;
  if (protest.status === "requested") {
    return computePrepareFileAction(
      property,
      protest,
      evidenceCount,
      countyInfo,
      input.noticeSignedAt,
      input.noticeHearingAppearance,
      input.agentFormSignedAt,
      input.evidenceDeclarationSignedAt,
    );
  }
  return computeFiledOnwardsAction(property, protest, evidenceCount, countyInfo);
}

// The real, fetching entry point — reads exactly the rows View Case's own
// DocumentsSection reads (getSubmission ×3), only while still preparing to
// file (nothing to fetch once filed: computeFiledOnwardsAction doesn't need
// any of them).
export async function getCaseNextAction(
  property: PropertyRecord,
  protest: ProtestRecord,
  evidenceCount: number,
): Promise<CaseNextAction> {
  const countyInfo = getCountyProtestInfo(property.cad);

  if (protest.status !== "requested") {
    return computeFiledOnwardsAction(property, protest, evidenceCount, countyInfo);
  }

  const [notice, agent, affidavit] = await Promise.all([
    getSubmission(protest.id, "notice_of_protest"),
    getSubmission(protest.id, "appointment_of_agent"),
    getSubmission(protest.id, "evidence_declaration"),
  ]);
  const hearingAppearance = notice?.fieldValues?.["ARB hearing"];

  return computePrepareFileAction(
    property,
    protest,
    evidenceCount,
    countyInfo,
    notice?.signedAt ?? null,
    typeof hearingAppearance === "string" && hearingAppearance ? hearingAppearance : null,
    agent?.signedAt ?? null,
    affidavit?.signedAt ?? null,
  );
}
