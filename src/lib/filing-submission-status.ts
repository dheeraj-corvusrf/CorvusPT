// Pure status derivation for the Filing Method & Submission workflow — the
// same real fields protest-form-submissions.ts already persists, read back
// into one of six states so every surface (FilingStepBar, the per-document
// panel's own status line, View Case's Filed Protest / Evidence status
// cards) agrees on what "done" means without re-deriving it differently in
// each place.
import type { FormSubmission } from "./protest-form-submissions";

export type FilingSubmissionStatus =
  | "unstarted"
  | "method_chosen"
  | "awaiting_confirmation"
  | "confirmed"
  | "additional_requested"
  | "rejected";

export const FILING_SUBMISSION_STATUS_LABEL: Record<FilingSubmissionStatus, string> = {
  unstarted: "Not yet submitted",
  method_chosen: "In progress",
  awaiting_confirmation: "Awaiting County Confirmation",
  confirmed: "Confirmed",
  additional_requested: "Additional Information Requested",
  rejected: "Rejected",
};

type StatusFields = Pick<
  FormSubmission,
  "filingMethod" | "submittedAt" | "filingConfirmedAt" | "additionalRequestedAt" | "rejectedAt"
>;

export function filingSubmissionStatus(submission: StatusFields | null): FilingSubmissionStatus {
  if (!submission) return "unstarted";
  const { filingConfirmedAt, additionalRequestedAt, rejectedAt, submittedAt } = submission;

  // Whichever of the three real "the county did something" events is
  // newest wins — so a fresh re-confirmation after a rejection or an
  // additional-info request naturally supersedes it, with no separate
  // "clear this" step anywhere.
  const events: { at: string; status: FilingSubmissionStatus }[] = [
    ...(filingConfirmedAt ? [{ at: filingConfirmedAt, status: "confirmed" as const }] : []),
    ...(additionalRequestedAt
      ? [{ at: additionalRequestedAt, status: "additional_requested" as const }]
      : []),
    ...(rejectedAt ? [{ at: rejectedAt, status: "rejected" as const }] : []),
  ];
  if (events.length > 0) {
    events.sort((a, b) => (a.at < b.at ? 1 : -1));
    return events[0].status;
  }

  // The customer's own "I delivered this" report — the same real signal
  // for every method now (Online/Mail/In Person included, not just Email).
  if (submittedAt) return "awaiting_confirmation";
  if (submission.filingMethod) return "method_chosen";
  return "unstarted";
}

// A typed confirmation/tracking number is real proof on its own — an uploaded
// document is the other, separately-tracked kind (see getFilingProofDocumentsFor
// in documents.ts); the caller combines both when deciding whether "Mark as
// Submitted" should be enabled.
export function hasFilingReferenceNumber(
  submission: Pick<FormSubmission, "filingConfirmationNumber" | "mailTrackingNumber"> | null,
): boolean {
  if (!submission) return false;
  return !!(submission.filingConfirmationNumber?.trim() || submission.mailTrackingNumber?.trim());
}

// What kind of proof this method's own confirmation actually looks like —
// real, county-process fact (not invented per-county data; every county uses
// one of these four real channels the same general way).
export function confirmationMethodDescription(
  method: FormSubmission["filingMethod"],
): string | null {
  switch (method) {
    case "online":
      return "County portal confirmation, receipt, confirmation number, or screenshot";
    case "email":
      return "County acknowledgement or response through email";
    case "mail":
      return "Mailing receipt, delivery/tracking evidence, and county acknowledgement where applicable";
    case "in_person":
      return "Stamped copy, receipt, or county acknowledgement";
    case null:
      return null;
  }
}
