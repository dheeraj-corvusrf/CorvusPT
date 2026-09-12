import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import { selectRelevantEvidence, buildEvidencePackagePdf } from "./evidence-package";
import type { DocumentRecord } from "./documents";

function doc(over: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: "doc-1",
    propertyId: "prop-1",
    fileName: "notice.pdf",
    storagePath: "prop-1/notice.pdf",
    documentType: null,
    uploadedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("selectRelevantEvidence", () => {
  it("returns nothing when Module 8 hasn't run or there's nothing uploaded", () => {
    expect(selectRelevantEvidence([doc()], null)).toEqual([]);
    expect(selectRelevantEvidence([], [{ foundIn: "notice.pdf", status: "Verified" }])).toEqual([]);
  });

  it("selects a document whose exact fileName a non-Missing item names as foundIn", () => {
    const photo = doc({ id: "doc-2", fileName: "roof-damage.jpg" });
    const result = selectRelevantEvidence(
      [doc(), photo],
      [
        { foundIn: "roof-damage.jpg", status: "Verified" },
        { foundIn: null, status: "Missing" },
      ],
    );
    expect(result).toEqual([photo]);
  });

  it("never selects a document only a Missing item mentions", () => {
    const result = selectRelevantEvidence([doc()], [{ foundIn: "notice.pdf", status: "Missing" }]);
    expect(result).toEqual([]);
  });

  it("matches when foundIn is a descriptive phrase containing the real filename", () => {
    const receipt = doc({ id: "doc-3", fileName: "receipt.pdf" });
    const result = selectRelevantEvidence(
      [receipt],
      [{ foundIn: "the uploaded receipt.pdf", status: "Found" }],
    );
    expect(result).toEqual([receipt]);
  });
});

describe("buildEvidencePackagePdf", () => {
  it("combines multiple real PDFs into one, each preceded by a label page", async () => {
    const a = await PDFDocument.create();
    a.addPage([200, 200]);
    const aBytes = await a.save();

    const b = await PDFDocument.create();
    b.addPage([200, 200]);
    b.addPage([200, 200]);
    const bBytes = await b.save();

    const merged = await buildEvidencePackagePdf([
      { fileName: "one.pdf", bytes: aBytes.buffer as ArrayBuffer },
      { fileName: "two.pdf", bytes: bBytes.buffer as ArrayBuffer },
    ]);

    const result = await PDFDocument.load(merged);
    // 1 label + 1 page (a) + 1 label + 2 pages (b) = 5
    expect(result.getPageCount()).toBe(5);
  });

  it("still adds a label page for a file type it can't embed, without throwing", async () => {
    const merged = await buildEvidencePackagePdf([
      { fileName: "photo.webp", bytes: new Uint8Array([1, 2, 3]).buffer },
    ]);
    const result = await PDFDocument.load(merged);
    expect(result.getPageCount()).toBe(1);
  });

  it("returns real, loadable PDF bytes even for an empty file list", async () => {
    const merged = await buildEvidencePackagePdf([]);
    expect(merged.length).toBeGreaterThan(0);
    await expect(PDFDocument.load(merged)).resolves.toBeTruthy();
  });
});
