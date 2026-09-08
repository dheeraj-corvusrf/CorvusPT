import { addProperty, findExistingProperty, type PropertyRecord } from "./properties";
import { cadLookup, type CadRecord } from "./cad-lookup";
import { parseNumber } from "./csv-import";
import {
  IMPORT_FIELDS,
  type ColumnMapping,
  type ImportField,
  type SpreadsheetGrid,
} from "./spreadsheet-import";

export type ImportFlag = { level: "warn" | "error"; message: string };

export type ImportRowStatus = "ok" | "review" | "duplicate";

export type ImportRow = {
  rowNumber: number; // 1-based, header = row 1
  values: {
    address: string;
    cad?: string;
    accountNumber?: string;
    ownerName?: string;
    propertyType?: string;
    landValue?: number;
    improvementValue?: number;
    totalValue?: number;
    taxYear?: number;
  };
  flags: ImportFlag[];
  status: ImportRowStatus;
  include: boolean; // user can uncheck a row
  existingId: string | null; // set when this property already exists
  cadOptions: CadRecord[] | null; // set when the address matched multiple CAD parcels
};

const NUMERIC: ImportField[] = ["landValue", "improvementValue", "totalValue", "taxYear"];

// Turn the raw grid + the confirmed column mapping into typed rows with
// per-row flags. No network — findExistingProperty / cadLookup happen in
// enrichRow so the caller can show progress.
export function buildRows(grid: SpreadsheetGrid, mapping: ColumnMapping[]): ImportRow[] {
  const colFor = new Map<ImportField, number>();
  mapping.forEach((m, i) => {
    if (m.field !== "ignore" && !colFor.has(m.field)) colFor.set(m.field as ImportField, i);
  });

  return grid.rows.map((cells, r) => {
    const rowNumber = r + 2;
    const flags: ImportFlag[] = [];
    const values: ImportRow["values"] = { address: "" };
    const sink = values as Record<string, string | number>;

    for (const field of IMPORT_FIELDS) {
      const col = colFor.get(field);
      if (col == null) continue;
      const raw = (cells[col] ?? "").trim();
      if (!raw) continue;
      if (NUMERIC.includes(field)) {
        const n = parseNumber(raw);
        if (n == null) {
          flags.push({
            level: "warn",
            message: `"${raw}" in "${field}" isn't a number — skipped.`,
          });
        } else {
          sink[field] = n;
        }
      } else {
        sink[field] = raw;
      }
    }

    if (!values.address) flags.push({ level: "error", message: "No address." });

    return {
      rowNumber,
      values,
      flags,
      status: flags.some((f) => f.level === "error") ? "review" : "ok",
      include: true,
      existingId: null,
      cadOptions: null,
    };
  });
}

function worst(flags: ImportFlag[]): ImportRowStatus {
  return flags.some((f) => f.level === "error") ? "review" : flags.length ? "review" : "ok";
}

// Dedupe check + CAD match for one row. Mutates and returns the row.
// Sequential by design — the caller loops with a progress callback.
export async function enrichRow(userId: string, row: ImportRow): Promise<ImportRow> {
  if (!row.values.address) return row;

  try {
    const existing = await findExistingProperty(userId, {
      address: row.values.address,
      cad: row.values.cad,
      accountNumber: row.values.accountNumber,
    });
    if (existing) {
      row.existingId = existing.id;
      row.status = "duplicate";
      row.flags.push({
        level: "warn",
        message: "Already in your account — it won't be added again.",
      });
      return row;
    }
  } catch {
    // A dedupe read failure shouldn't block the import — addProperty's own
    // findExistingProperty guard still runs at commit time.
  }

  try {
    const res = await cadLookup(row.values.address);
    if (res.matched === true) {
      const rec = res.record;
      fillBlank(row.values, "cad", rec.cad);
      fillBlank(row.values, "accountNumber", rec.accountNumber ?? undefined);
      fillBlank(row.values, "ownerName", rec.ownerName ?? undefined);
      fillBlank(row.values, "propertyType", rec.propertyType ?? undefined);
      fillBlankNum(row.values, "landValue", rec.landValue);
      fillBlankNum(row.values, "improvementValue", rec.improvementValue);
      fillBlankNum(row.values, "totalValue", rec.totalValue);
      fillBlankNum(row.values, "taxYear", rec.taxYear);
      disagree(row, "cad", rec.cad);
      disagree(row, "accountNumber", rec.accountNumber ?? undefined);
      disagree(row, "ownerName", rec.ownerName ?? undefined);
    } else if (res.matched === "multiple") {
      row.cadOptions = res.options;
      row.flags.push({
        level: "error",
        message: `Address matches ${res.options.length} county parcels — pick one.`,
      });
    } else {
      row.flags.push({
        level: "warn",
        message: "No county appraisal record found for this address.",
      });
    }
  } catch {
    row.flags.push({ level: "warn", message: "Couldn't reach the county appraisal district." });
  }

  if (row.status !== "duplicate") row.status = worst(row.flags);
  return row;
}

function fillBlank(
  v: ImportRow["values"],
  k: "cad" | "accountNumber" | "ownerName" | "propertyType",
  val: string | undefined,
) {
  if (!v[k] && val) v[k] = val;
}
function fillBlankNum(
  v: ImportRow["values"],
  k: "landValue" | "improvementValue" | "totalValue" | "taxYear",
  val: number | null,
) {
  if (v[k] == null && val != null) v[k] = val;
}
function disagree(
  row: ImportRow,
  k: "cad" | "accountNumber" | "ownerName",
  cadVal: string | undefined,
) {
  const fileVal = row.values[k];
  if (!fileVal || !cadVal) return;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (norm(fileVal) !== norm(cadVal)) {
    row.flags.push({
      level: "warn",
      message: `Your file's ${k} ("${fileVal}") differs from the county record ("${cadVal}").`,
    });
  }
}

export type CommitResult = {
  imported: PropertyRecord[];
  duplicates: number;
  failed: number;
};

// Adds every included, non-duplicate row. addProperty is itself
// dedupe-guarded, so a race that created the property between enrich and
// commit still can't double it.
export async function commitRows(
  userId: string,
  rows: ImportRow[],
  onProgress?: (done: number, total: number) => void,
): Promise<CommitResult> {
  const toAdd = rows.filter((r) => r.include && r.status !== "duplicate" && r.values.address);
  const imported: PropertyRecord[] = [];
  let duplicates = rows.filter((r) => r.include && r.status === "duplicate").length;
  let failed = 0;

  for (let i = 0; i < toAdd.length; i++) {
    onProgress?.(i + 1, toAdd.length);
    const r = toAdd[i];
    try {
      const before = await findExistingProperty(userId, {
        address: r.values.address,
        cad: r.values.cad,
        accountNumber: r.values.accountNumber,
      });
      const property = await addProperty(userId, r.values);
      if (before) duplicates++;
      else imported.push(property);
    } catch (err) {
      console.error("Bulk import row failed:", err);
      failed++;
    }
  }
  return { imported, duplicates, failed };
}
