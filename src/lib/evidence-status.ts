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
  | "submitted"
  | "awaiting_confirmation"
  | "confirmed"
  | "additional_requested"
  | "complete";

export const EVIDENCE_STATUS_LABEL: Record<EvidenceStatusStage, string> = {
  not_started: "Not Started",
  evidence_required: "Evidence Required",
  being_prepared: "Evidence Being Prepared",
  ready_to_submit: "Ready to Submit",
  submitted: "Submitted",
  awaiting_confirmation: "Awaiting Confirmation",
  confirmed: "Evidence Confirmed",
  additional_requested: "Additional Evidence Requested",
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
    "filingMethod" | "emailSentAt" | "filingConfirmedAt" | "additionalRequestedAt"
  > | null;
};

export function computeEvidenceStatus(input: EvidenceStatusInput): EvidenceStatusStage {
  const subStatus = filingSubmissionStatus(input.submission);

  if (subStatus === "additional_requested") return "additional_requested";
  if (subStatus === "confirmed") {
    return input.criticalMissingCount === null || input.criticalMissingCount === 0
      ? "complete"
      : "confirmed";
  }
  if (subStatus === "awaiting_confirmation") return "awaiting_confirmation";
  if (subStatus === "method_chosen") return "submitted";

  // No method chosen yet — readiness is purely about the evidence itself.
  if (input.evidenceDocCount === 0) {
    return input.criticalMissingCount === null ? "not_started" : "evidence_required";
  }
  if (input.criticalMissingCount != null && input.criticalMissingCount > 0) {
    return "being_prepared";
  }
  return "ready_to_submit";
}
