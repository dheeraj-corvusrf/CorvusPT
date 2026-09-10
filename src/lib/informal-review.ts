import { invokeEdgeFunction } from "./edge-functions";
import type { PropertyRecord } from "./properties";
import type { CountyProtestInfo } from "./county-protest-info";
import type { AppraiserCategory } from "./protests";
import type { HearingNoticeExtraction } from "./hearing-notice";

// Real, grounded informal-review guidance — see
// informal-review-guidance/index.ts for the prompt/discipline.
// draftEmailSubject/draftEmailBody are only ever populated when a real,
// verified contact email exists (contactEmail non-null); the caller should
// never build a mailto: link without checking that first.
export type InformalReviewGuidance = {
  available: "Yes" | "No" | "Unclear";
  appraiserCategory: AppraiserCategory;
  whoToContact: string;
  howToRequest: string;
  documentsToProvide: string[];
  requestedValueGuidance: string;
  evidenceToUse: string[];
  whatToSay: string;
  whatNotToSay: string;
  respondingToProposedValue: string;
  acceptingEndsCase: string;
  // County-specific how-to for getting the informal review scheduled and
  // done, grounded in the uploaded notice + county reference. steps is the
  // ordered walkthrough; missingInfo/nextSteps call out what the notice
  // didn't provide and what to do right now.
  steps: string[];
  whereToSchedule: string;
  applicableDeadlines: string[];
  missingInfo: string[];
  nextSteps: string[];
  draftEmailSubject: string;
  draftEmailBody: string;
  contactEmail: string | null;
};

export async function getInformalReviewGuidance(
  property: PropertyRecord,
  countyInfo: CountyProtestInfo | null,
  strategyRecommendation: string | null,
  estimatedReduction: number | null,
  evidenceFileNames: string[],
  // The latest hearing/county notice already read for this case, when there
  // is one (see getLatestHearingNotice / extract-hearing-notice) — grounds
  // the guidance's steps / whereToSchedule / applicableDeadlines /
  // missingInfo in the real document, not just the county reference.
  noticeContext: HearingNoticeExtraction | null = null,
): Promise<InformalReviewGuidance> {
  return invokeEdgeFunction<InformalReviewGuidance>("informal-review-guidance", {
    caseContext: {
      address: property.address,
      cad: property.cad,
      accountNumber: property.accountNumber,
      taxYear: property.taxYear,
      propertyType: property.propertyType,
      totalValue: property.totalValue,
      strategyRecommendation,
      estimatedReduction,
      evidenceFileNames,
    },
    countyReference: countyInfo
      ? { informalReview: countyInfo.informalReview, arbContact: countyInfo.arbContact }
      : null,
    noticeContext: noticeContext
      ? {
          hearingDate: noticeContext.hearingDate,
          evidenceSubmissionDeadline: noticeContext.evidenceSubmissionDeadline,
          appealDeadline: noticeContext.appealDeadline,
          countyContact: noticeContext.countyContact,
          appraiserContact: noticeContext.appraiserContact,
          submissionInstructions: noticeContext.submissionInstructions,
          requiredDocuments: noticeContext.requiredDocuments,
          informalReviewAvailable: noticeContext.informalReviewAvailable,
          proceduralDifferences: noticeContext.proceduralDifferences,
        }
      : null,
  });
}

// mailto: can't attach a file — same convention as PdfFormEditor's own
// buildFilingMailto.
export function buildInformalReviewMailto(guidance: InformalReviewGuidance): string | null {
  if (!guidance.contactEmail || !guidance.draftEmailBody) return null;
  const subject = guidance.draftEmailSubject || "Informal Review Request";
  return `mailto:${encodeURIComponent(guidance.contactEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(guidance.draftEmailBody)}`;
}
