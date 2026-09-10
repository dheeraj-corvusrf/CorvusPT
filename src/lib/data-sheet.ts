import { invokeEdgeFunction } from "./edge-functions";
import { buildTextPdf } from "./pdf-text";

// "AI fills in the missing data" — a report module flags inputs it's missing,
// and this drafts a starter data sheet (typical/assumed values + how to
// confirm each) that gets filed in the central Documents repository as a
// reference document, tagged to the module that needed it. It is NEVER fed
// back into a module edge function as a real input — see generate-data-sheet.

// The prefix the Documents tab / AI Report use to badge these as AI-authored.
export const DATA_SHEET_DOCUMENT_TYPE_PREFIX = "AI Data Sheet — ";

export type DataSheet = { title: string; markdown: string };

export async function generateDataSheet(
  moduleId: string,
  moduleLabel: string,
  moduleResult: unknown,
  caseContext: {
    address?: string | null;
    cad?: string | null;
    propertyType?: string | null;
    totalValue?: number | null;
    taxYear?: number | null;
  },
): Promise<DataSheet> {
  const result = await invokeEdgeFunction<DataSheet>("generate-data-sheet", {
    moduleId,
    moduleLabel,
    moduleResult,
    caseContext,
  });
  return {
    title: result.title || `${moduleLabel} — Starter Data Sheet`,
    markdown: result.markdown || "",
  };
}

// Renders the sheet to a PDF File ready for uploadDocument().
export async function buildDataSheetFile(sheet: DataSheet): Promise<File> {
  const bytes = await buildTextPdf(sheet.title, sheet.markdown);
  const safe =
    sheet.title
      .replace(/[^\w\- ]+/g, "")
      .trim()
      .slice(0, 60) || "data-sheet";
  return new File([bytes as BlobPart], `${safe}.pdf`, { type: "application/pdf" });
}
