import { describe, it, expect } from "vitest";
import { computeEvidenceReadiness, type EvidenceReadinessItem } from "./evidence-readiness";

function item(over: Partial<EvidenceReadinessItem> = {}): EvidenceReadinessItem {
  return { status: "Missing", priority: "Supporting", relatedModule: null, ...over };
}

describe("computeEvidenceReadiness", () => {
  it("returns zeroes and Limited for an empty checklist", () => {
    const r = computeEvidenceReadiness([]);
    expect(r).toEqual({
      strategiesSupported: 0,
      itemsIdentified: 0,
      verifiedCount: 0,
      criticalMissingCount: 0,
      overall: "Limited",
    });
  });

  it("counts verified and critical-missing items correctly", () => {
    const items = [
      item({ status: "Verified", priority: "Critical" }),
      item({ status: "Missing", priority: "Critical" }),
      item({ status: "Found", priority: "Important" }),
    ];
    const r = computeEvidenceReadiness(items);
    expect(r.itemsIdentified).toBe(3);
    expect(r.verifiedCount).toBe(1);
    expect(r.criticalMissingCount).toBe(1);
  });

  it("counts a relatedModule as supported only when it has no critical gap", () => {
    const items = [
      item({ status: "Verified", priority: "Critical", relatedModule: "comps" }),
      item({ status: "Found", priority: "Important", relatedModule: "comps" }),
      item({ status: "Missing", priority: "Critical", relatedModule: "zoning" }),
      item({ status: "Verified", priority: "Important", relatedModule: "zoning" }),
    ];
    const r = computeEvidenceReadiness(items);
    // comps: no critical gap -> supported. zoning: has a critical gap -> not.
    expect(r.strategiesSupported).toBe(1);
  });

  it("items with no relatedModule never count toward strategiesSupported", () => {
    const items = [item({ status: "Verified", priority: "Critical", relatedModule: null })];
    expect(computeEvidenceReadiness(items).strategiesSupported).toBe(0);
  });

  it("is Strong when nothing critical is missing and most items are on file", () => {
    const items = [
      item({ status: "Verified", priority: "Critical" }),
      item({ status: "Verified", priority: "Important" }),
      item({ status: "Found", priority: "Supporting" }),
      item({ status: "Missing", priority: "Optional" }),
    ];
    expect(computeEvidenceReadiness(items).overall).toBe("Strong");
  });

  it("is Limited whenever any critical item is missing, regardless of ratio", () => {
    const items = [
      item({ status: "Verified", priority: "Important" }),
      item({ status: "Verified", priority: "Supporting" }),
      item({ status: "Missing", priority: "Critical" }),
    ];
    expect(computeEvidenceReadiness(items).overall).toBe("Limited");
  });

  it("is Moderate with no critical gaps but a middling non-missing ratio", () => {
    const items = [
      item({ status: "Verified", priority: "Important" }),
      item({ status: "Missing", priority: "Supporting" }),
      item({ status: "Missing", priority: "Optional" }),
    ];
    const r = computeEvidenceReadiness(items);
    expect(r.criticalMissingCount).toBe(0);
    expect(r.overall).toBe("Moderate");
  });
});
