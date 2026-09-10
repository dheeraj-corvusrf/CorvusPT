import { invokeEdgeFunction } from "./edge-functions";
import { getCountyProtestInfo } from "./county-protest-info";
import { getPreFilingCheck } from "./pre-filing-check";
import type { PropertyRecord } from "./properties";
import type { ProtestRecord } from "./protests";

// A light AI review of an assembled protest case against the county's real
// filing requirements — shown in the "AI Guidance & Filing Notice" step.
// Advisory: the deterministic getPreFilingCheck() is what actually blocks
// filing. The AI only surfaces "this doesn't line up, confirm it" concerns.

export type CaseReadinessConcern = {
  field: string;
  concern: string;
  severity: "high" | "medium";
};

export async function verifyCaseReadiness(
  property: PropertyRecord,
  protest: ProtestRecord,
  evidenceCount: number,
): Promise<CaseReadinessConcern[]> {
  const countyInfo = getCountyProtestInfo(property.cad);
  // Reuse the deterministic check's own resolved "Filing Method" string so
  // the AI sees exactly what the app will do, not a re-derived guess.
  const filingMethod =
    getPreFilingCheck(property, protest).find((i) => i.label === "Filing Method")?.value ?? null;

  const { concerns } = await invokeEdgeFunction<{ concerns: CaseReadinessConcern[] }>(
    "verify-case-readiness",
    {
      caseFacts: {
        cad: property.cad,
        address: property.address,
        accountNumber: property.accountNumber,
        protestTaxYear: protest.taxYear ?? null,
        propertyTaxYear: property.taxYear ?? null,
        ownerName: property.ownerName,
        propertyType: property.propertyType ?? null,
        protestDeadline: property.protestDeadline ?? null,
        applicableForm: "Comptroller Form 50-132 — Notice of Protest",
        filingMethod,
        evidenceCount,
      },
      countyReference: countyInfo
        ? {
            verifiedAt: countyInfo.verifiedAt,
            sourceUrl: countyInfo.sourceUrl,
            filingMethod: countyInfo.filingMethod,
            arbContact: countyInfo.arbContact,
          }
        : null,
    },
  );
  return concerns ?? [];
}
