// Pure status derivation for the Filing Method & Submission workflow — the
// same real fields protest-form-submissions.ts already persists, read back
// into one of five states so every surface (FilingStepBar, the per-document
// panel's own status line, View Case's Filed Protest / Evidence status
// cards) agrees on what "done" means without re-deriving it differently in
// each place.
import type { FormSubmission } from "./protest-form-submissions";

export type FilingSubmissionStatus =
  "unstarted" | "method_chosen" | "awaiting_confirmation" | "confirmed" | "additional_requested";

export const FILING_SUBMISSION_STATUS_LABEL: Record<FilingSubmissionStatus, string> = {
  unstarted: "Not yet submitted",
  method_chosen: "In progress",
  awaiting_confirmation: "Awaiting County Confirmation",
  confirmed: "Confirmed",
  additional_requested: "Additional Information Requested",
};

type StatusFields = Pick<
  FormSubmission,
  "filingMethod" | "emailSentAt" | "filingConfirmedAt" | "additionalRequestedAt"
>;

export function filingSubmissionStatus(submission: StatusFields | null): FilingSubmissionStatus {
  if (!submission) return "unstarted";
  const { filingConfirmedAt, additionalRequestedAt } = submission;
  // Newest timestamp wins — a request that came in after the last
  // confirmation takes priority; a fresh confirmFiling() call after that
  // (the user re-submitted) naturally supersedes it again, with no separate
  // "clear the request" step anywhere.
  if (additionalRequestedAt && (!filingConfirmedAt || additionalRequestedAt > filingConfirmedAt)) {
    return "additional_requested";
  }
  if (filingConfirmedAt) return "confirmed";
  // Email is the one method with a real middle state: the user told us they
  // sent it, but nothing here reads a reply — see confirmFiling's own
  // comment. Every other method treats a real reference number or an
  // uploaded proof document as confirmation-ready in one step.
  if (submission.filingMethod === "email" && submission.emailSentAt) {
    return "awaiting_confirmation";
  }
  if (submission.filingMethod) return "method_chosen";
  return "unstarted";
}

// A typed confirmation/tracking number is real proof on its own — an uploaded
// document is the other, separately-tracked kind (see getFilingProofDocumentsFor
// in documents.ts); the caller combines both when deciding whether "Confirm"
// should be enabled.
export function hasFilingReferenceNumber(
  submission: Pick<FormSubmission, "filingConfirmationNumber" | "mailTrackingNumber"> | null,
): boolean {
  if (!submission) return false;
  return !!(submission.filingConfirmationNumber?.trim() || submission.mailTrackingNumber?.trim());
}
