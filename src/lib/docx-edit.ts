import mammoth from "mammoth";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// Read/write helpers for the Documents tab's "Edit" on a .docx upload.
// mammoth pulls the raw text (formatting is not preserved — the tradeoff
// noted in the plan); the user edits plain text; on save it becomes either a
// fresh .docx (one paragraph per line) or, by default, a PDF so the result
// slots straight into the evidence packet like every other document.

export async function docxToText(bytes: ArrayBuffer): Promise<string> {
  const { value } = await mammoth.extractRawText({ arrayBuffer: bytes });
  return value.replace(/\r\n/g, "\n").trimEnd();
}

export async function textToDocx(text: string): Promise<Uint8Array> {
  const doc = new Document({
    sections: [
      {
        children: text.split("\n").map((line) => new Paragraph({ children: [new TextRun(line)] })),
      },
    ],
  });
  // toBlob (not toBuffer) — toBuffer needs a Node Buffer polyfill in the
  // browser; toBlob is the browser-native path.
  const blob = await Packer.toBlob(doc);
  return new Uint8Array(await blob.arrayBuffer());
}

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
const FONT_SIZE = 11;
const LINE_HEIGHT = 15;

export async function textToPdf(text: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const maxWidth = PAGE_W - MARGIN * 2;

  let page = pdf.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const drawLine = (line: string) => {
    if (y < MARGIN) {
      page = pdf.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
    page.drawText(line, { x: MARGIN, y, size: FONT_SIZE, font, color: rgb(0.1, 0.1, 0.1) });
    y -= LINE_HEIGHT;
  };

  for (const raw of text.split("\n")) {
    const wrapped = wrap(raw, font, FONT_SIZE, maxWidth);
    if (wrapped.length === 0) {
      y -= LINE_HEIGHT; // blank line
      continue;
    }
    wrapped.forEach(drawLine);
  }
  return pdf.save();
}

function wrap(
  text: string,
  font: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  size: number,
  maxWidth: number,
): string[] {
  if (!text.trim()) return [];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      // A single word longer than the line — hard-break it.
      if (font.widthOfTextAtSize(word, size) > maxWidth) {
        let chunk = "";
        for (const ch of word) {
          if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth) {
            lines.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        current = chunk;
      } else {
        current = word;
      }
    }
  }
  if (current) lines.push(current);
  return lines;
}
