import type { AttendanceType } from "./protests";

// The dynamic step set for the "Prepare & File" workflow. Which steps a case
// actually needs is derived from real case data — the same signals the case
// already tracks, never a guess:
//  - File Protest and Evidence are always part of a filing.
//  - Agent / Representative only when a third-party agent will represent the
//    owner (the case's attendance choice, or a signed agent authorization).
//  - Evidence Affidavit / Declaration (Form 50-283) only when the owner will
//    NOT appear in person at the ARB hearing — read from the Notice of
//    Protest's own "how will you appear" answer once it's been filled in.

export type FilingStepId = "prefiling" | "file" | "agent" | "affidavit" | "evidence";

export const FILING_STEP_META: Record<FilingStepId, { label: string; blurb: string }> = {
  prefiling: {
    label: "Pre-Filing Check",
    blurb:
      "Corvus confirms the case's county, property, tax year, owner, deadline, and county requirements before you file.",
  },
  file: {
    label: "File Protest",
    blurb:
      "Complete, review, sign, and file your Notice of Protest (Comptroller Form 50-132) with the county.",
  },
  agent: {
    label: "Agent / Representative",
    blurb:
      "Appoint the tax agent or representative who will act for you (Comptroller Form 50-162).",
  },
  affidavit: {
    label: "Evidence Affidavit",
    blurb:
      "You won't appear in person, so your evidence goes to the ARB by sworn affidavit (Comptroller Form 50-283).",
  },
  evidence: {
    label: "Evidence",
    blurb:
      "Assemble your evidence package around your protest strategy and submit it to the county.",
  },
};

export type FilingStepInput = {
  // "Property Owner" | "Authorized Agent" | "Both" | null
  attendanceType: AttendanceType | null;
  // A signed Protest Authorization that names a representing agent is on file.
  hasAgentAuthorization: boolean;
  // The saved value of the Notice of Protest's "ARB hearing" (how will you
  // appear) radio — null until that section has been filled in. Anything other
  // than "In person" means an affidavit is needed.
  hearingAppearance: string | null;
};

function willNotAppearInPerson(hearingAppearance: string | null): boolean {
  if (!hearingAppearance) return false;
  return !/^\s*in person\s*$/i.test(hearingAppearance);
}

export function requiredFilingSteps(input: FilingStepInput): FilingStepId[] {
  // Pre-Filing Check always comes first — it runs between Corvus's guidance and
  // the protest form.
  const steps: FilingStepId[] = ["prefiling", "file"];

  if (
    input.attendanceType === "Authorized Agent" ||
    input.attendanceType === "Both" ||
    input.hasAgentAuthorization
  ) {
    steps.push("agent");
  }

  if (willNotAppearInPerson(input.hearingAppearance)) {
    steps.push("affidavit");
  }

  steps.push("evidence");
  return steps;
}

// The real signals a step's own completion reads from — every one a fact
// already tracked elsewhere (a form's signed_at, the Pre-Filing Check's own
// blocked/clear verdict, the case record's evidence-submitted timestamp),
// never a separately-tracked "done" flag that could drift from the truth.
// Shared by CaseDetailModal.tsx's own step bar AND anything else (e.g. the AI
// Report page's Case Progress card) that needs to say the same "what's next"
// without re-deriving — and needs to say it identically.
export type FilingStepStatusInput = {
  preFilingBlocked: boolean;
  noticeSignedAt: string | null;
  agentFormSignedAt: string | null;
  evidenceDeclarationSignedAt: string | null;
  evidenceSubmittedConfirmedAt: string | null;
};

export function isFilingStepDone(id: FilingStepId, s: FilingStepStatusInput): boolean {
  switch (id) {
    case "prefiling":
      return !s.preFilingBlocked;
    case "file":
      return !!s.noticeSignedAt;
    case "agent":
      return !!s.agentFormSignedAt;
    case "affidavit":
      return !!s.evidenceDeclarationSignedAt;
    case "evidence":
      return !!s.evidenceSubmittedConfirmedAt;
  }
}

// The first step in `steps` (in order) that isn't done yet — falls back to
// the first step overall once everything is (nothing left to point at as
// "next", so the caller should treat that as its own case rather than trust
// this return value as "still incomplete").
export function firstIncompleteFilingStep(
  steps: FilingStepId[],
  s: FilingStepStatusInput,
): FilingStepId {
  return steps.find((id) => !isFilingStepDone(id, s)) ?? steps[0];
}
