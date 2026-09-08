import { describe, it, expect, vi } from "vitest";

vi.mock("./edge-functions", () => ({
  invokeEdgeFunction: vi.fn(() => Promise.reject(new Error("should not be called"))),
}));

import { readSpreadsheet, deterministicMapping, suggestColumnMapping } from "./spreadsheet-import";
import { invokeEdgeFunction } from "./edge-functions";

function csvFile(text: string): File {
  return new File([text], "props.csv", { type: "text/csv" });
}

describe("readSpreadsheet (CSV path)", () => {
  it("splits a quoted CSV into a header + padded rows", async () => {
    const g = await readSpreadsheet(
      csvFile('address,county,value\n"1 Main St, Dallas, TX",Dallas CAD,"$500,000"\n2 Oak Ave,,\n'),
    );
    expect(g.headers).toEqual(["address", "county", "value"]);
    expect(g.rows).toEqual([
      ["1 Main St, Dallas, TX", "Dallas CAD", "$500,000"],
      ["2 Oak Ave", "", ""],
    ]);
  });
});

describe("deterministicMapping", () => {
  it("aliases known headers and leaves unknowns unmapped", () => {
    const m = deterministicMapping(["Address", "County", "Parcel #", "2026 Mkt Val"]);
    expect(m.find((x) => x.header === "Address")?.field).toBe("address");
    expect(m.find((x) => x.header === "County")?.field).toBe("cad");
    expect(m.find((x) => x.header === "Parcel #")?.source).toBe("unmapped");
    expect(m.find((x) => x.header === "2026 Mkt Val")?.source).toBe("unmapped");
  });
});

describe("suggestColumnMapping", () => {
  it("does not call the AI when every column aliases cleanly", async () => {
    const out = await suggestColumnMapping({
      headers: ["address", "cad", "account", "total value"],
      rows: [["1 Main", "Dallas CAD", "123", "500000"]],
    });
    expect(invokeEdgeFunction).not.toHaveBeenCalled();
    expect(out.every((m) => m.source === "alias")).toBe(true);
  });

  it("merges AI suggestions for the unresolved columns and clamps to our fields", async () => {
    vi.mocked(invokeEdgeFunction).mockResolvedValueOnce({
      mapping: [
        { header: "Parcel #", field: "accountNumber", confidence: 90 },
        { header: "Parcel #", field: "notAField" }, // dropped
        { header: "Nonsense", field: "address" }, // header not sent -> dropped
      ],
    });
    const out = await suggestColumnMapping({
      headers: ["Address", "Parcel #"],
      rows: [["1 Main St", "R12345"]],
    });
    expect(out.find((m) => m.header === "Address")?.field).toBe("address");
    const parcel = out.find((m) => m.header === "Parcel #");
    expect(parcel?.field).toBe("accountNumber");
    expect(parcel?.source).toBe("ai");
  });
});
