import { describe, it, expect } from "vitest";
import { findDuplicateCandidates } from "./document-duplicates";
import { isEvidenceDoc, type DocumentRecord } from "./documents";

function doc(overrides: Partial<DocumentRecord>): DocumentRecord {
  return {
    id: "d1",
    propertyId: "p1",
    fileName: "notice.pdf",
    storagePath: "u/p/notice.pdf",
    documentType: null,
    uploadedAt: "2026-01-01T00:00:00Z",
    category: null,
    source: null,
    aiVerdict: null,
    aiNotes: null,
    aiCrossRefs: null,
    aiCheckedAt: null,
    suggestedName: null,
    deletedAt: null,
    useAsEvidence: null,
    duplicateOf: null,
    dupReviewed: false,
    aiExplanation: null,
    editedFrom: null,
    ...overrides,
  };
}

describe("findDuplicateCandidates", () => {
  it("flags two files with the same base name", () => {
    const a = doc({ id: "a", fileName: "Appraisal Notice.pdf" });
    const b = doc({ id: "b", fileName: "appraisal notice (1).pdf" });
    expect(findDuplicateCandidates(a, [a, b]).map((d) => d.id)).toEqual(["b"]);
  });

  it("flags two AI-checked docs of the same category sharing ≥2 facts", () => {
    const a = doc({
      id: "a",
      fileName: "one.pdf",
      category: "appraisal_notice",
      aiCheckedAt: "2026-01-02T00:00:00Z",
      aiNotes: "Account 2748399, tax year 2026, value $900,000.",
    });
    const b = doc({
      id: "b",
      fileName: "two.pdf",
      category: "appraisal_notice",
      aiCheckedAt: "2026-01-03T00:00:00Z",
      aiNotes: "Notice of appraised value. Acct 2748399. Year 2026.",
    });
    expect(findDuplicateCandidates(a, [a, b]).map((d) => d.id)).toEqual(["b"]);
  });

  it("does not flag different-category docs or a soft-deleted one", () => {
    const a = doc({
      id: "a",
      fileName: "one.pdf",
      category: "appraisal_notice",
      aiCheckedAt: "x",
      aiNotes: "Acct 2748399 2026",
    });
    const different = doc({
      id: "c",
      fileName: "tax.pdf",
      category: "tax_bill",
      aiCheckedAt: "x",
      aiNotes: "Acct 2748399 2026",
    });
    const trashed = doc({
      id: "t",
      fileName: "one.pdf",
      deletedAt: "2026-01-05T00:00:00Z",
    });
    expect(findDuplicateCandidates(a, [a, different, trashed])).toEqual([]);
  });

  it("ignores documents on other properties", () => {
    const a = doc({ id: "a", fileName: "x.pdf", propertyId: "p1" });
    const b = doc({ id: "b", fileName: "x.pdf", propertyId: "p2" });
    expect(findDuplicateCandidates(a, [a, b])).toEqual([]);
  });
});

describe("isEvidenceDoc", () => {
  it("honors the explicit use_as_evidence choice over document_type", () => {
    expect(isEvidenceDoc(doc({ documentType: "Protest Evidence", useAsEvidence: false }))).toBe(
      false,
    );
    expect(isEvidenceDoc(doc({ documentType: "Other", useAsEvidence: true }))).toBe(true);
    expect(isEvidenceDoc(doc({ documentType: "Protest Evidence", useAsEvidence: null }))).toBe(
      true,
    );
    expect(isEvidenceDoc(doc({ documentType: "Other", useAsEvidence: null }))).toBe(false);
  });
});
