// Pure rollup for Module 8's own end-of-checklist "Evidence Summary" (Part
// 8) — every number here is derived straight from the same real items
// ai-report.tsx already has (ModuleResultMap["evidence"]["items"]), nothing
// re-fetched or guessed. Kept separate from the page so it's independently
// testable and so the "how do we define Strong/Moderate/Limited" judgment
// call lives in exactly one place.

export type EvidenceReadinessItem = {
  status: "Verified" | "Found" | "Missing";
  priority: "Critical" | "Important" | "Supporting" | "Optional";
  relatedModule?: "comps" | "site" | "improvement" | "zoning" | "income" | "strategy" | null;
};

export type EvidenceReadiness = {
  // Count of distinct real findings (relatedModule values actually present
  // on the items) that currently have no unresolved Critical+Missing item
  // tied to them — i.e. the case's strategies that evidence doesn't leave
  // exposed. 0 when no item names a relatedModule yet.
  strategiesSupported: number;
  itemsIdentified: number;
  verifiedCount: number;
  criticalMissingCount: number;
  // "This is an evidence-readiness assessment, not a prediction of protest
  // success" — Strong/Moderate/Limited is about how complete the file is,
  // never phrased or computed as a win-probability.
  overall: "Strong" | "Moderate" | "Limited";
};

export function computeEvidenceReadiness(items: EvidenceReadinessItem[]): EvidenceReadiness {
  const itemsIdentified = items.length;
  const verifiedCount = items.filter((i) => i.status === "Verified").length;
  const missingCount = items.filter((i) => i.status === "Missing").length;
  const criticalMissingCount = items.filter(
    (i) => i.status === "Missing" && i.priority === "Critical",
  ).length;

  const linkedModules = new Set(
    items.filter((i) => i.relatedModule).map((i) => i.relatedModule as string),
  );
  let strategiesSupported = 0;
  for (const mod of linkedModules) {
    const group = items.filter((i) => i.relatedModule === mod);
    const hasCriticalGap = group.some((i) => i.status === "Missing" && i.priority === "Critical");
    if (!hasCriticalGap) strategiesSupported++;
  }

  const nonMissingRatio =
    itemsIdentified > 0 ? (itemsIdentified - missingCount) / itemsIdentified : 0;
  const overall: EvidenceReadiness["overall"] =
    criticalMissingCount === 0 && nonMissingRatio >= 0.6
      ? "Strong"
      : criticalMissingCount > 0 || nonMissingRatio < 0.3
        ? "Limited"
        : "Moderate";

  return { strategiesSupported, itemsIdentified, verifiedCount, criticalMissingCount, overall };
}
