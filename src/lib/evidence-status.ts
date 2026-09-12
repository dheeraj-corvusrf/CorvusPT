// Pure status derivation for View Case's Evidence status card (Part 3) — a
// richer, evidence-specific state machine layered on top of the same real
// signals filing-submission-status.ts already reads (a chosen method, real
// proof/confirmation) plus Module 8's own cached "what's still missing"
// verdict. Never a second guess at either — just the rollup.
import type { FormSubmission } from "./protest-form-submissions";
import { filingSubmissionStatus } from "./filing-submission-status";

export type EvidenceStatusStage =
  | "not_started"
  | "evidence_required"
  | "being_prepared"
  | "ready_to_submit"
  | "awaiting_confirmation"
  | "confirmed"
  | "additional_requested"
  | "rejected"
  | "complete";

export const EVIDENCE_STATUS_LABEL: Record<EvidenceStatusStage, string> = {
  not_started: "Not Started",
  evidence_required: "Evidence Required",
  being_prepared: "Evidence Being Prepared",
  ready_to_submit: "Ready to Submit",
  awaiting_confirmation: "Awaiting Confirmation",
  confirmed: "Evidence Confirmed",
  additional_requested: "Additional Evidence Requested",
  rejected: "Evidence Rejected",
  complete: "Evidence Complete",
};

export type EvidenceStatusInput = {
  evidenceDocCount: number;
  // From Module 8's own cached checklist (getCachedModuleResult(propertyId,
  // "evidence")) — count of items with priority "Critical" and status
  // "Missing". null when Module 8 has never been run for this property yet
  // (genuinely unknown), deliberately distinct from 0 (Module 8 ran and
  // found nothing critical missing).
  criticalMissingCount: number | null;
  submission: Pick<
    FormSubmission,
    "filingMethod" | "submittedAt" | "filingConfirmedAt" | "additionalRequestedAt" | "rejectedAt"
  > | null;
};

export function computeEvidenceStatus(input: EvidenceStatusInput): EvidenceStatusStage {
  const subStatus = filingSubmissionStatus(input.submission);

  if (subStatus === "rejected") return "rejected";
  if (subStatus === "additional_requested") return "additional_requested";
  if (subStatus === "confirmed") {
    return input.criticalMissingCount === null || input.criticalMissingCount === 0
      ? "complete"
      : "confirmed";
  }
  if (subStatus === "awaiting_confirmation") return "awaiting_confirmation";

  // Neither "method_chosen" nor "unstarted" involves the county yet —
  // readiness before that point is purely about the evidence itself, a
  // method noted but not yet acted on still just means "ready."
  if (input.evidenceDocCount === 0) {
    return input.criticalMissingCount === null ? "not_started" : "evidence_required";
  }
  if (input.criticalMissingCount != null && input.criticalMissingCount > 0) {
    return "being_prepared";
  }
  return "ready_to_submit";
}

// A plain completeness percentage over Module 8's own checklist — "how much
// of what Corvus verified is actually in hand," not a re-judgment of any
// item. null (not 0) when Module 8 hasn't run yet, same "genuinely unknown
// vs. actually zero" discipline as criticalMissingCount above.
export function evidenceScore(items: { status: "Verified" | "Found" | "Missing" }[] | null): number | null {
  if (!items || items.length === 0) return null;
  const nonMissing = items.filter((i) => i.status !== "Missing").length;
  return Math.round((nonMissing / items.length) * 100);
}
