// Generate Evidence Package — combining the case's real evidence documents
// into one downloadable PDF. "AI strategically selects" is a deterministic
// match against Module 8's own already-computed checklist (an item's real
// foundIn naming an uploaded file), never a fresh AI call re-guessing
// relevance — Module 8 already did that analysis once, honestly.
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { DocumentRecord } from "./documents";
import { previewKind } from "./documents";

export type EvidenceItemLike = {
  foundIn: string | null;
  status: "Verified" | "Found" | "Missing";
};

// A document is "relevant" when some non-Missing Module 8 item's own foundIn
// names it (an exact match, or the item naming it as a substring — Module 8
// sometimes writes "the uploaded X" rather than the literal filename).
export function selectRelevantEvidence(
  evidenceDocuments: DocumentRecord[],
  items: EvidenceItemLike[] | null,
): DocumentRecord[] {
  if (!items || items.length === 0 || evidenceDocuments.length === 0) return [];
  const foundInNames = items
    .filter((i) => i.status !== "Missing" && i.foundIn)
    .map((i) => (i.foundIn as string).toLowerCase());
  if (foundInNames.length === 0) return [];
  return evidenceDocuments.filter((d) => {
    const name = d.fileName.toLowerCase();
    return foundInNames.some((f) => f === name || f.includes(name) || name.includes(f));
  });
}

export type PackageFile = {
  fileName: string;
  bytes: ArrayBuffer;
};

const LETTER: [number, number] = [612, 792];

// Merges real PDFs and images into one combined PDF, in the given order —
// each item gets a one-line filename label page first, so the assembled
// package is navigable rather than a blind concatenation. A file type pdf-lib
// can't embed directly (gif/webp/bmp/heic/tiff, or a corrupt file) still gets
// its label page — the original stays on file in Documents regardless.
export async function buildEvidencePackagePdf(files: PackageFile[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.HelveticaBold);

  for (const file of files) {
    const labelPage = out.addPage(LETTER);
    labelPage.drawText(file.fileName, {
      x: 50,
      y: 720,
      size: 14,
      font,
      color: rgb(0.15, 0.15, 0.15),
    });

    const kind = previewKind(file.fileName);
    if (kind === "pdf") {
      try {
        const src = await PDFDocument.load(file.bytes);
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach((p) => out.addPage(p));
      } catch {
        // Corrupt/unreadable PDF — the label page still marks its place.
      }
    } else if (kind === "image") {
      const ext = file.fileName.toLowerCase().split(".").pop() ?? "";
      try {
        const image =
          ext === "png" ? await out.embedPng(file.bytes) : await out.embedJpg(file.bytes);
        const page = out.addPage(LETTER);
        const scale = Math.min(500 / image.width, 680 / image.height, 1);
        const w = image.width * scale;
        const h = image.height * scale;
        page.drawImage(image, {
          x: (LETTER[0] - w) / 2,
          y: (LETTER[1] - h) / 2,
          width: w,
          height: h,
        });
      } catch {
        // gif/webp/bmp/heic/tiff aren't embeddable by pdf-lib directly —
        // same fallback as an unreadable PDF above.
      }
    }
  }

  return out.save();
}
