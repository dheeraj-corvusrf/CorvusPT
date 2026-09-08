import { useState } from "react";
import { toast } from "sonner";
import { Modal } from "@/components/Modal";
import { useFileDrop } from "@/hooks/use-file-drop";
import { downloadCsvTemplate } from "@/lib/csv-import";
import {
  readSpreadsheet,
  deterministicMapping,
  suggestColumnMapping,
  IMPORT_FIELDS,
  type ColumnMapping,
  type ColumnTarget,
  type SpreadsheetGrid,
} from "@/lib/spreadsheet-import";
import { buildRows, enrichRow, commitRows, type ImportRow } from "@/lib/bulk-property-import";
import { type PropertyRecord } from "@/lib/properties";
import { type CadRecord } from "@/lib/cad-lookup";
import { currency } from "@/lib/intake-store";

type Step = "pick" | "mapping" | "review" | "importing" | "done";

const FIELD_LABEL: Record<ColumnTarget, string> = {
  address: "Address",
  cad: "County / CAD",
  accountNumber: "Account number",
  ownerName: "Owner name",
  propertyType: "Property type",
  landValue: "Land value",
  improvementValue: "Improvement value",
  totalValue: "Total value",
  taxYear: "Tax year",
  ignore: "— ignore —",
};

export function ImportPropertiesModal({
  userId,
  onImported,
  onClose,
}: {
  userId: string;
  onImported: (properties: PropertyRecord[]) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>("pick");
  const [fileError, setFileError] = useState<string | null>(null);
  const [grid, setGrid] = useState<SpreadsheetGrid | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping[]>([]);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<{ added: number; dup: number; failed: number } | null>(null);

  async function handleFile(file: File) {
    setFileError(null);
    let g: SpreadsheetGrid;
    try {
      g = await readSpreadsheet(file);
    } catch (err) {
      console.error(err);
      setFileError(
        "Couldn't read that file. Use a .csv or .xlsx export with one property per row.",
      );
      return;
    }
    if (g.headers.length === 0 || g.rows.length === 0) {
      setFileError("That file has no data rows.");
      return;
    }
    setGrid(g);

    // Deterministic mapping first — if every column resolves and there's an
    // address, skip the mapping step entirely.
    const deter = deterministicMapping(g.headers);
    const hasAddress = deter.some((m) => m.field === "address");
    const allResolved = deter.every((m) => m.source !== "unmapped");
    if (hasAddress && allResolved) {
      setMapping(deter);
      startReview(g, deter);
      return;
    }
    setMapping(deter);
    setStep("mapping");
    // Ask the AI to place the leftover columns in the background.
    suggestColumnMapping(g).then(setMapping);
  }

  const { isDragging, dropHandlers } = useFileDrop(handleFile, step !== "pick");

  function setColumn(header: string, field: ColumnTarget) {
    setMapping((prev) =>
      prev.map((m) => (m.header === header ? { ...m, field, source: "user" } : m)),
    );
  }

  async function startReview(g: SpreadsheetGrid, m: ColumnMapping[]) {
    const built = buildRows(g, m);
    setRows(built);
    setStep("review");
    setProgress({ done: 0, total: built.length });
    // Sequential dedupe + CAD lookup with live progress.
    for (let i = 0; i < built.length; i++) {
      await enrichRow(userId, built[i]);
      setProgress({ done: i + 1, total: built.length });
      setRows((prev) => prev.map((r, idx) => (idx === i ? { ...built[i] } : r)));
    }
  }

  async function confirmMapping() {
    if (!grid) return;
    if (!mapping.some((m) => m.field === "address")) {
      toast.error("Map one column to Address to continue.");
      return;
    }
    await startReview(grid, mapping);
  }

  async function runImport() {
    setStep("importing");
    setProgress({
      done: 0,
      total: rows.filter((r) => r.include && r.status !== "duplicate").length,
    });
    const { imported, duplicates, failed } = await commitRows(userId, rows, (done, total) =>
      setProgress({ done, total }),
    );
    setResult({ added: imported.length, dup: duplicates, failed });
    setStep("done");
    onImported(imported);
    const parts = [`Added ${imported.length} propert${imported.length === 1 ? "y" : "ies"}.`];
    if (duplicates > 0) parts.push(`${duplicates} already existed.`);
    if (failed > 0) parts.push(`${failed} failed.`);
    (imported.length > 0 ? toast.success : toast.error)(parts.join(" "));
  }

  function editRow(idx: number, patch: Partial<ImportRow["values"]>) {
    setRows((prev) =>
      prev.map((r, i) => {
        if (i !== idx) return r;
        const values = { ...r.values, ...patch };
        // Clearing the "no address" error once one is typed.
        const flags = values.address ? r.flags.filter((f) => f.message !== "No address.") : r.flags;
        const status =
          r.status === "duplicate"
            ? "duplicate"
            : flags.some((f) => f.level === "error")
              ? "review"
              : flags.length
                ? "review"
                : "ok";
        return { ...r, values, flags, status };
      }),
    );
  }

  function pickParcel(idx: number, rec: CadRecord) {
    setRows((prev) =>
      prev.map((r, i) =>
        i === idx
          ? {
              ...r,
              values: {
                ...r.values,
                cad: rec.cad,
                accountNumber: rec.accountNumber ?? r.values.accountNumber,
                ownerName: rec.ownerName ?? r.values.ownerName,
                totalValue: rec.totalValue ?? r.values.totalValue,
              },
              cadOptions: null,
              flags: r.flags.filter((f) => !f.message.startsWith("Address matches")),
              status: "ok",
            }
          : r,
      ),
    );
  }

  const ready = rows.filter((r) => r.include && r.status === "ok").length;
  const needsReview = rows.filter((r) => r.include && r.status === "review").length;
  const dupes = rows.filter((r) => r.status === "duplicate").length;
  const enriching = step === "review" && progress.done < progress.total;

  return (
    <Modal onClose={onClose} wide={step === "review" || step === "mapping"}>
      <h3 className="font-serif text-xl font-semibold">Bulk Upload Properties</h3>

      {step === "pick" && (
        <div className="mt-4 grid gap-4">
          <p className="text-sm text-muted-foreground">
            Upload an Excel or CSV file with one property per row. AI maps your columns to our
            fields, matches each address to the county appraisal district, and flags anything that
            needs a look — nothing is saved until you confirm. Existing properties are never added
            twice.
          </p>
          <button type="button" onClick={downloadCsvTemplate} className="btn-outline text-sm w-fit">
            Download CSV Template
          </button>
          <label
            className={`grid cursor-pointer place-items-center rounded-lg border-2 border-dashed p-8 text-sm ${
              isDragging ? "border-accent bg-accent/5" : "border-border"
            }`}
            {...dropHandlers}
          >
            <span className="font-medium">
              {isDragging ? "Drop to upload" : "Choose a file or drop it here"}
            </span>
            <span className="text-muted-foreground text-xs">.xlsx, .xls, or .csv</span>
            <input
              type="file"
              accept=".csv,text/csv,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) handleFile(f);
              }}
            />
          </label>
          {fileError && <p className="text-sm text-destructive">{fileError}</p>}
        </div>
      )}

      {step === "mapping" && grid && (
        <div className="mt-4 grid gap-3">
          <p className="text-sm text-muted-foreground">
            Confirm how your columns map to our property fields. Columns marked{" "}
            <span className="badge-soft">AI</span> were guessed — change any that look wrong.
          </p>
          <div className="max-h-[50vh] overflow-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-secondary text-left">
                <tr>
                  <th className="px-3 py-2">Your column</th>
                  <th className="px-3 py-2">Sample</th>
                  <th className="px-3 py-2">Maps to</th>
                </tr>
              </thead>
              <tbody>
                {mapping.map((m, i) => (
                  <tr key={m.header} className="border-t border-border">
                    <td className="px-3 py-2 font-medium">
                      {m.header || <span className="text-muted-foreground italic">(no name)</span>}
                      {m.source === "ai" && <span className="badge-soft ml-1.5">AI</span>}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{grid.rows[0]?.[i] || "—"}</td>
                    <td className="px-3 py-2">
                      <select
                        value={m.field}
                        onChange={(e) => setColumn(m.header, e.target.value as ColumnTarget)}
                        className="rounded-md border border-input bg-background px-2 py-1"
                      >
                        {[...IMPORT_FIELDS, "ignore" as const].map((f) => (
                          <option key={f} value={f}>
                            {FIELD_LABEL[f]}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setStep("pick")} className="btn-outline">
              Back
            </button>
            <button type="button" onClick={confirmMapping} className="btn-accent">
              Looks right
            </button>
          </div>
        </div>
      )}

      {step === "review" && (
        <div className="mt-4 grid gap-3">
          {enriching ? (
            <div>
              <p className="text-sm text-muted-foreground">
                Matching {progress.done} of {progress.total} to the county appraisal district…
              </p>
              <div className="mt-2 h-2 w-full rounded-full bg-secondary">
                <div
                  className="h-2 rounded-full bg-accent transition-all"
                  style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }}
                />
              </div>
            </div>
          ) : (
            <p className="text-sm">
              <span className="font-medium text-success">{ready} ready</span> ·{" "}
              <span className="font-medium text-warning-foreground">{needsReview} need review</span>
              {dupes > 0 && ` · ${dupes} already in your account (won't be re-added)`}
            </p>
          )}

          <div className="max-h-[50vh] overflow-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-secondary text-left">
                <tr>
                  <th className="px-2 py-2">Use</th>
                  <th className="px-2 py-2">Address</th>
                  <th className="px-2 py-2">County</th>
                  <th className="px-2 py-2">Account</th>
                  <th className="px-2 py-2">Total value</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, idx) => (
                  <tr
                    key={r.rowNumber}
                    className={`border-t border-border ${r.status === "duplicate" ? "opacity-60" : ""}`}
                  >
                    <td className="px-2 py-2">
                      <input
                        type="checkbox"
                        checked={r.include}
                        onChange={(e) =>
                          setRows((prev) =>
                            prev.map((x, i) =>
                              i === idx ? { ...x, include: e.target.checked } : x,
                            ),
                          )
                        }
                      />
                    </td>
                    <td className="px-2 py-2">
                      <input
                        value={r.values.address}
                        onChange={(e) => editRow(idx, { address: e.target.value })}
                        className="w-full min-w-[12rem] rounded border border-input bg-background px-1.5 py-1"
                      />
                      {r.flags.map((f, fi) => (
                        <div
                          key={fi}
                          className={`mt-0.5 text-[11px] ${f.level === "error" ? "text-destructive" : "text-warning-foreground"}`}
                        >
                          {f.message}
                        </div>
                      ))}
                      {r.cadOptions && (
                        <div className="mt-1 grid gap-1">
                          {r.cadOptions.map((o) => (
                            <button
                              key={o.accountNumber ?? o.propertyAddress}
                              onClick={() => pickParcel(idx, o)}
                              className="text-left text-[11px] text-accent underline underline-offset-2"
                            >
                              Use {o.accountNumber ?? "this parcel"} — {o.ownerName ?? "owner n/a"}
                            </button>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-2 text-muted-foreground">{r.values.cad ?? "—"}</td>
                    <td className="px-2 py-2 text-muted-foreground">
                      {r.values.accountNumber ?? "—"}
                    </td>
                    <td className="px-2 py-2 text-muted-foreground">
                      {r.values.totalValue != null ? currency(r.values.totalValue) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setStep("pick")} className="btn-outline">
              Start over
            </button>
            <button
              type="button"
              onClick={runImport}
              disabled={enriching || ready + needsReview === 0}
              className="btn-accent disabled:opacity-60"
            >
              Add {rows.filter((r) => r.include && r.status !== "duplicate").length} propert
              {rows.filter((r) => r.include && r.status !== "duplicate").length === 1 ? "y" : "ies"}
            </button>
          </div>
        </div>
      )}

      {step === "importing" && (
        <div className="mt-4">
          <p className="text-sm text-muted-foreground">
            Adding {progress.done} of {progress.total}…
          </p>
          <div className="mt-2 h-2 w-full rounded-full bg-secondary">
            <div
              className="h-2 rounded-full bg-accent transition-all"
              style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }}
            />
          </div>
        </div>
      )}

      {step === "done" && result && (
        <div className="mt-4 grid gap-3">
          <p className="text-sm">
            Added <span className="font-medium text-success">{result.added}</span> propert
            {result.added === 1 ? "y" : "ies"}.{result.dup > 0 && ` ${result.dup} already existed.`}
            {result.failed > 0 && ` ${result.failed} failed.`}
          </p>
          <div className="flex justify-end">
            <button type="button" onClick={onClose} className="btn-accent">
              Done
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
