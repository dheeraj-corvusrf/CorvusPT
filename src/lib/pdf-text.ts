import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";

// A tiny text → PDF renderer for AI-generated reference documents (see
// data-sheet.ts). Handles exactly what those prompts emit: "# " / "## "
// headings, "- " bullets, blank-line-separated paragraphs, and **bold**
// inline. Paginates automatically onto US-Letter pages. Not a full markdown
// engine — tables and links fall back to plain text.

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const MAX_WIDTH = PAGE_WIDTH - MARGIN * 2;

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const trial = current ? `${current} ${word}` : word;
    if (current && font.widthOfTextAtSize(trial, size) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = trial;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

export async function buildTextPdf(title: string, body: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.09, 0.09, 0.11);
  const muted = rgb(0.42, 0.42, 0.46);

  let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  const ensureRoom = (needed: number) => {
    if (y - needed < MARGIN) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
  };

  const draw = (
    text: string,
    opts: { size?: number; bold?: boolean; color?: typeof ink; indent?: number; gap?: number } = {},
  ) => {
    const size = opts.size ?? 10.5;
    const font = opts.bold ? bold : regular;
    const indent = opts.indent ?? 0;
    // Strip inline ** markers — this renderer doesn't do partial-bold runs.
    const clean = text.replace(/\*\*/g, "");
    for (const line of wrapText(clean, font, size, MAX_WIDTH - indent)) {
      ensureRoom(size * 1.5);
      page.drawText(line, { x: MARGIN + indent, y, size, font, color: opts.color ?? ink });
      y -= size * 1.5;
    }
    y -= opts.gap ?? 0;
  };

  draw(title, { size: 17, bold: true, gap: 4 });
  draw(
    `Generated ${new Date().toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" })}`,
    { size: 9, color: muted, gap: 12 },
  );

  for (const rawLine of body.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trimEnd();
    if (line.trim() === "") {
      y -= 6;
      continue;
    }
    if (/^#\s+/.test(line)) {
      draw(line.replace(/^#\s+/, ""), { size: 14, bold: true, gap: 3 });
    } else if (/^#{2,}\s+/.test(line)) {
      draw(line.replace(/^#{2,}\s+/, ""), { size: 12, bold: true, gap: 2 });
    } else if (/^\s*[-*]\s+/.test(line)) {
      draw(`•  ${line.replace(/^\s*[-*]\s+/, "")}`, { indent: 10 });
    } else {
      draw(line);
    }
  }

  return doc.save();
}
