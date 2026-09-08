import { readSheet } from "read-excel-file/browser";
import { invokeEdgeFunction } from "./edge-functions";
import { parseCsvRows, HEADER_ALIASES, normalizeHeader } from "./csv-import";

// The property fields a bulk upload can map a spreadsheet column onto.
export const IMPORT_FIELDS = [
  "address",
  "cad",
  "accountNumber",
  "ownerName",
  "propertyType",
  "landValue",
  "improvementValue",
  "totalValue",
  "taxYear",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export type ColumnTarget = ImportField | "ignore";

export type SpreadsheetGrid = { headers: string[]; rows: string[][] };

// header (verbatim from the file) -> our field, plus where the mapping came
// from so the review UI can badge the AI-suggested ones.
export type ColumnMapping = {
  header: string;
  field: ColumnTarget;
  source: "alias" | "ai" | "user" | "unmapped";
  confidence?: number;
};

const cell = (v: unknown): string => {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
};

// Reads a .xlsx/.xls or .csv file into a plain string grid. First row is the
// header row; every other row is padded/truncated to the header length so
// downstream indexing is safe.
export async function readSpreadsheet(file: File): Promise<SpreadsheetGrid> {
  const name = file.name.toLowerCase();
  let raw: string[][];
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    // readSheet -> the first sheet's rows as (string | number | boolean |
    // Date | null)[][]. Normalise every cell to a trimmed string.
    const rows = await readSheet(file);
    raw = rows.map((r) => r.map((c) => cell(c)));
  } else {
    raw = parseCsvRows(await file.text()).map((r) => r.map((c) => c.trim()));
  }
  raw = raw.filter((r) => r.some((c) => c !== ""));
  if (raw.length === 0) return { headers: [], rows: [] };
  const headers = raw[0].map((h) => h.trim());
  const width = headers.length;
  const rows = raw.slice(1).map((r) => {
    const out = r.slice(0, width);
    while (out.length < width) out.push("");
    return out;
  });
  return { headers, rows };
}

// Deterministic first pass — the existing HEADER_ALIASES cover a template
// file and most tidy exports with no AI call at all.
export function deterministicMapping(headers: string[]): ColumnMapping[] {
  return headers.map((header) => {
    const aliased = HEADER_ALIASES[normalizeHeader(header)];
    if (aliased && aliased !== "skip") {
      return { header, field: aliased as ImportField, source: "alias" };
    }
    return { header, field: "ignore", source: "unmapped" };
  });
}

// Asks the AI to map only the headers the deterministic pass couldn't place.
// Merges the AI's suggestions back into the full mapping; clamps every field
// to IMPORT_FIELDS/"ignore" and every header to the ones actually sent.
export async function suggestColumnMapping(grid: SpreadsheetGrid): Promise<ColumnMapping[]> {
  const base = deterministicMapping(grid.headers);
  const unresolved = base.filter((m) => m.source === "unmapped").map((m) => m.header);
  if (unresolved.length === 0) return base;

  try {
    const { mapping } = await invokeEdgeFunction<{
      mapping: { header: string; field: string; confidence?: number }[];
    }>("map-import-columns", {
      headers: unresolved,
      sampleRows: grid.rows.slice(0, 5),
    });
    const bySent = new Set(unresolved);
    const allowed = new Set<string>([...IMPORT_FIELDS, "ignore"]);
    for (const s of mapping) {
      if (!bySent.has(s.header) || !allowed.has(s.field)) continue;
      const slot = base.find((m) => m.header === s.header);
      if (slot) {
        slot.field = s.field as ColumnTarget;
        slot.source = "ai";
        slot.confidence = s.confidence;
      }
    }
  } catch {
    // AI mapping is a convenience — a failure just leaves those columns on
    // "ignore" for the user to set by hand in the review step.
  }
  return base;
}
