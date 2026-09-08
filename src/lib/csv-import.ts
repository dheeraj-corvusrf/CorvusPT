// Minimal hand-rolled CSV parser — no npm dependency needed (same posture as
// src/lib/ics.ts's hand-rolled .ics generator). A naive split(",") would silently
// corrupt rows exported from Excel/Sheets whenever a field contains a comma (they
// get quoted, e.g. `"1234 Main St, Suite 100"`), so this is a real RFC4180-ish
// state machine, not a one-liner.
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  // Normalizing CRLF/CR to LF up front keeps the loop below from having to treat
  // "\r\n" as two separate row-boundary signals.
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (inQuotes) {
      if (ch === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  // The last field/row has no trailing newline to trigger a push above.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

export type ParsedPropertyRow = {
  rowNumber: number; // 1-based, matches what a user would see counting header as row 1
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

export type CsvRowError = {
  rowNumber: number;
  reason: string;
};

export type ParsePropertiesCsvResult = {
  rows: ParsedPropertyRow[];
  errors: CsvRowError[];
};

// header name -> field name. Accepts a few common synonyms since a user's own
// spreadsheet won't necessarily use our exact internal names.
export const HEADER_ALIASES: Record<string, keyof ParsedPropertyRow | "skip"> = {
  address: "address",
  cad: "cad",
  county: "cad",
  accountnumber: "accountNumber",
  account: "accountNumber",
  acctnumber: "accountNumber",
  ownername: "ownerName",
  owner: "ownerName",
  propertytype: "propertyType",
  type: "propertyType",
  landvalue: "landValue",
  improvementvalue: "improvementValue",
  totalvalue: "totalValue",
  value: "totalValue",
  taxyear: "taxYear",
  year: "taxYear",
};

export function normalizeHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

// Tolerates the way real-world spreadsheets format numbers — "$450,000",
// "450,000.00" — rather than requiring a bare integer string.
export function parseNumber(raw: string): number | undefined {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (cleaned === "") return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

export function parsePropertiesCsv(text: string): ParsePropertiesCsvResult {
  const csvRows = parseCsvRows(text);
  const rows: ParsedPropertyRow[] = [];
  const errors: CsvRowError[] = [];

  if (csvRows.length === 0) {
    return { rows, errors: [{ rowNumber: 1, reason: "The file is empty." }] };
  }

  const headerFields = csvRows[0].map(normalizeHeader);
  const fieldForColumn = headerFields.map((h) => HEADER_ALIASES[h]);
  const addressColumn = fieldForColumn.indexOf("address");
  if (addressColumn === -1) {
    return {
      rows,
      errors: [{ rowNumber: 1, reason: 'No "address" column found in the header row.' }],
    };
  }

  for (let i = 1; i < csvRows.length; i++) {
    const rowNumber = i + 1; // 1-based, header counted as row 1
    const cells = csvRows[i];
    const address = (cells[addressColumn] ?? "").trim();
    if (!address) {
      errors.push({ rowNumber, reason: "Missing address." });
      continue;
    }

    const parsed: ParsedPropertyRow = { rowNumber, address };
    let numericError: string | null = null;

    fieldForColumn.forEach((field, colIndex) => {
      if (!field || field === "skip" || field === "address" || field === "rowNumber") return;
      const raw = (cells[colIndex] ?? "").trim();
      if (!raw) return;
      switch (field) {
        case "landValue":
        case "improvementValue":
        case "totalValue":
        case "taxYear": {
          const n = parseNumber(raw);
          if (n === undefined) {
            numericError = `"${raw}" in column "${csvRows[0][colIndex]}" isn't a number.`;
            return;
          }
          parsed[field] = n;
          break;
        }
        case "cad":
        case "accountNumber":
        case "ownerName":
        case "propertyType":
          parsed[field] = raw;
          break;
      }
    });

    if (numericError) {
      errors.push({ rowNumber, reason: numericError });
      continue;
    }
    rows.push(parsed);
  }

  return { rows, errors };
}

export const PROPERTY_CSV_TEMPLATE = [
  "address,cad,accountNumber,ownerName,propertyType,landValue,improvementValue,totalValue,taxYear",
  '"1234 Main St, Suite 100, Dallas, TX 75201",Dallas CAD,12345678,Acme Holdings LLC,commercial,150000,350000,500000,2026',
].join("\r\n");

export function downloadCsvTemplate(): void {
  const blob = new Blob([PROPERTY_CSV_TEMPLATE], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "corvuspt-properties-template.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
