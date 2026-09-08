import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./properties", () => ({
  addProperty: vi.fn(),
  findExistingProperty: vi.fn(),
}));
vi.mock("./cad-lookup", () => ({
  cadLookup: vi.fn(),
}));

import { buildRows, enrichRow, commitRows, type ImportRow } from "./bulk-property-import";
import { addProperty, findExistingProperty } from "./properties";
import { cadLookup } from "./cad-lookup";
import type { ColumnMapping } from "./spreadsheet-import";

const mapping: ColumnMapping[] = [
  { header: "Address", field: "address", source: "alias" },
  { header: "County", field: "cad", source: "alias" },
  { header: "Value", field: "totalValue", source: "ai" },
];

beforeEach(() => {
  vi.mocked(addProperty).mockReset();
  vi.mocked(findExistingProperty).mockReset().mockResolvedValue(null);
  vi.mocked(cadLookup).mockReset();
});

describe("buildRows", () => {
  it("maps columns, parses currency numbers, flags a missing address", () => {
    const rows = buildRows(
      {
        headers: ["Address", "County", "Value"],
        rows: [
          ["100 Main St", "Dallas CAD", "$500,000"],
          ["", "Tarrant", "250000"],
          ["3 Oak Ave", "", "not a number"],
        ],
      },
      mapping,
    );
    expect(rows[0].values).toMatchObject({
      address: "100 Main St",
      cad: "Dallas CAD",
      totalValue: 500000,
    });
    expect(rows[0].status).toBe("ok");
    expect(rows[1].flags.some((f) => f.message === "No address.")).toBe(true);
    expect(rows[1].status).toBe("review");
    expect(rows[2].flags.some((f) => f.message.includes("isn't a number"))).toBe(true);
  });
});

function row(address: string, extra: Partial<ImportRow["values"]> = {}): ImportRow {
  return {
    rowNumber: 2,
    values: { address, ...extra },
    flags: [],
    status: "ok",
    include: true,
    existingId: null,
    cadOptions: null,
  };
}

describe("enrichRow", () => {
  it("marks a row that already exists as a duplicate", async () => {
    vi.mocked(findExistingProperty).mockResolvedValueOnce({ id: "existing-1" } as never);
    const r = await enrichRow("u1", row("100 Main St"));
    expect(r.status).toBe("duplicate");
    expect(r.existingId).toBe("existing-1");
  });

  it("fills blanks from a matched CAD record and flags a disagreement", async () => {
    vi.mocked(cadLookup).mockResolvedValueOnce({
      matched: true,
      record: {
        ownerName: "COUNTY OWNER LLC",
        propertyAddress: "100 Main St",
        cad: "Dallas Central Appraisal District",
        accountNumber: "123456",
        propertyType: "commercial",
        landValue: 100000,
        improvementValue: 400000,
        totalValue: 500000,
        taxYear: 2026,
      },
    } as never);
    const r = await enrichRow("u1", row("100 Main St", { ownerName: "MY LLC" }));
    expect(r.values.accountNumber).toBe("123456");
    expect(r.values.totalValue).toBe(500000);
    expect(r.flags.some((f) => f.message.includes("differs from the county record"))).toBe(true);
    expect(r.status).toBe("review");
  });

  it("offers a parcel picker when the address matches multiple CAD parcels", async () => {
    vi.mocked(cadLookup).mockResolvedValueOnce({
      matched: "multiple",
      options: [{ accountNumber: "A" }, { accountNumber: "B" }],
    } as never);
    const r = await enrichRow("u1", row("11400 Culebra, San Antonio"));
    expect(r.cadOptions).toHaveLength(2);
    expect(r.status).toBe("review");
  });

  it("keeps a no-match row importable", async () => {
    vi.mocked(cadLookup).mockResolvedValueOnce({ matched: false, nearby: [] } as never);
    const r = await enrichRow("u1", row("500 Rural Rd", { cad: "Loving CAD", accountNumber: "9" }));
    expect(r.status).toBe("review"); // a warn flag, still includable
    expect(r.flags.some((f) => f.message.includes("No county appraisal record"))).toBe(true);
  });
});

describe("commitRows", () => {
  it("adds only included, non-duplicate rows", async () => {
    vi.mocked(addProperty).mockImplementation((_u, p) =>
      Promise.resolve({ id: `p-${p.address}`, address: p.address } as never),
    );
    const rows: ImportRow[] = [
      row("A"),
      { ...row("B"), include: false },
      { ...row("C"), status: "duplicate" },
      row("D"),
    ];
    const res = await commitRows("u1", rows);
    expect(res.imported.map((p) => p.address)).toEqual(["A", "D"]);
    expect(res.duplicates).toBe(1); // the C row
    expect(addProperty).toHaveBeenCalledTimes(2);
  });
});
