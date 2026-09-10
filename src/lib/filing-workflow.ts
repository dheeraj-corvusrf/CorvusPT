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

export type FilingStepId = "file" | "agent" | "affidavit" | "evidence";

export const FILING_STEP_META: Record<FilingStepId, { label: string; blurb: string }> = {
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
  const steps: FilingStepId[] = ["file"];

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
