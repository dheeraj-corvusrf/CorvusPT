import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  readIntake,
  updateIntake,
  appendAudit,
  effectiveExtraction,
  detectMismatch,
  routeWorkflows,
  currency,
  displayVal,
  takePendingFile,
  LOW_CONFIDENCE_THRESHOLD,
  type IntakeState,
  type WorkflowSuggestion,
} from "@/lib/intake-store";
import { askAboutDocument } from "@/lib/document-ai";
import type { Extraction } from "@/lib/document-ai";
import { useAuth } from "@/lib/auth";
import { addProperty } from "@/lib/properties";
import { uploadDocument } from "@/lib/documents";
import { addTaxBill, recordRefund } from "@/lib/tax-bills";
import { Modal } from "@/components/Modal";
import { LoadingLine } from "@/components/LoadingLine";
import { cadLookup } from "@/lib/cad-lookup";
import { classifyPropertyCategory } from "@/lib/texas-tax-rates";

export const Route = createFileRoute("/document-review")({
  head: () => ({
    meta: [
      { title: "Document Review — CorvusPT" },
      {
        name: "description",
        content: "AI read your Texas property tax document. Review and confirm.",
      },
      { property: "og:title", content: "Document Review — CorvusPT" },
      {
        property: "og:description",
        content: "Confirm classification, extraction, and next-best workflow.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: DocumentReview,
});

type Mode = "review" | "edit" | "confirmed";

function DocumentReview() {
  const nav = useNavigate();
  const { user } = useAuth();
  const [state, setState] = useState<IntakeState>({ previewsUsed: [] });
  const [mode, setMode] = useState<Mode>("review");
  const [askOpen, setAskOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [hearingOpen, setHearingOpen] = useState(false);
  // Same reasoning as /intake's own CAD-based block: the AI extraction has no
  // residential/commercial field of its own, so the extracted address is
  // checked against the real CAD record (classifyPropertyCategory() again —
  // the same Texas state-code classifier, not a second, possibly-inconsistent
  // one) once the document's extracted address is known. "pending" until that
  // lookup resolves; a failed/unmatched lookup fails open (not blocked) —
  // we only block on an address CAD *positively* confirms as residential.
  const [propertyCheck, setPropertyCheck] = useState<"pending" | "ok" | "residential">("pending");
  const [residentialInfo, setResidentialInfo] = useState<{
    address: string;
    propertyType: string | null;
  } | null>(null);

  useEffect(() => {
    const s = readIntake();
    setState(s);
    if (!s.extraction) {
      nav({ to: "/intake" });
    }
  }, [nav]);

  const extraction = effectiveExtraction(state);
  const lowConfidence = !!extraction && extraction.confidence < LOW_CONFIDENCE_THRESHOLD;
  const mismatch = !!state.mismatchFlag;
  const workflows: WorkflowSuggestion[] = useMemo(
    () => (extraction ? routeWorkflows(extraction) : []),
    [extraction],
  );

  // effectiveExtraction() (above) builds a brand-new object on every call —
  // it's not memoized, and it's called fresh on every render — so depending
  // on `extraction` itself here would re-fire this effect every render this
  // effect's own setPropertyCheck() calls cause, an infinite loop of CAD
  // lookups. Depend on the actual address string instead, which only
  // changes when the extraction's address field itself changes.
  const checkAddress = extraction?.propertyAddress ?? extraction?.situsAddress ?? null;

  useEffect(() => {
    if (!checkAddress) {
      setPropertyCheck("ok");
      return;
    }
    let cancelled = false;
    setPropertyCheck("pending");
    cadLookup(checkAddress)
      .then((res) => {
        if (cancelled) return;
        // A "multiple" result (2+ real CAD accounts at this exact address —
        // see cad-lookup.ts) doesn't need the full disambiguation UX here;
        // this is only a lightweight residential-property guard on an
        // uploaded document's extracted address, not the primary intake
        // flow, so it's simplest and safe to just treat it the same as "ok"
        // and let the user proceed (the real intake path still catches a
        // residential match on whichever account they end up choosing).
        if (
          res.matched === true &&
          classifyPropertyCategory(res.record.propertyType) === "residential"
        ) {
          appendAudit({
            actor: "ai",
            action: "block_residential_property",
            reason: res.record.propertyType ?? undefined,
          });
          setResidentialInfo({
            address: res.record.propertyAddress,
            propertyType: res.record.propertyType,
          });
          setPropertyCheck("residential");
        } else {
          setPropertyCheck("ok");
        }
      })
      .catch((err) => {
        console.error(err);
        if (!cancelled) setPropertyCheck("ok");
      });
    return () => {
      cancelled = true;
    };
  }, [checkAddress]);

  if (!extraction) {
    return (
      <div className="container-page py-12">
        <LoadingLine text="Loading document…" />
      </div>
    );
  }

  if (propertyCheck === "pending") {
    return (
      <div className="container-page py-12">
        <LoadingLine text="Checking property type…" />
      </div>
    );
  }

  if (propertyCheck === "residential") {
    return (
      <div className="container-page py-12 max-w-3xl">
        <div className="card-elev p-6">
          <h1 className="font-serif text-2xl font-semibold">This is a residential property.</h1>
          <p className="mt-1 text-muted-foreground">
            The county's own records classify {residentialInfo?.address ?? "this address"} as
            residential{residentialInfo?.propertyType ? ` (${residentialInfo.propertyType})` : ""}.
            CorvusPT currently serves commercial properties only.
          </p>
          <div className="mt-4 flex gap-2">
            <Link to="/intake" className="btn-outline">
              Upload a Different Document
            </Link>
          </div>
        </div>
      </div>
    );
  }

  function saveEdit(patch: Partial<Extraction>) {
    const prev = effectiveExtraction(state);
    const nextEdited = { ...(state.extractionEdited ?? {}), ...patch };
    const next = updateIntake({ extractionEdited: nextEdited });
    // audit each field
    for (const k of Object.keys(patch) as Array<keyof Extraction>) {
      appendAudit({
        actor: "user",
        action: "edit_field",
        field: k as string,
        from: (prev?.[k] as string | number | null | undefined) ?? null,
        to: (patch[k] as string | number | null | undefined) ?? null,
      });
    }
    setState(next);
  }

  async function onConfirm() {
    const eff = effectiveExtraction(state);
    if (!eff) return;
    const routed = routeWorkflows(eff);
    appendAudit({ actor: "user", action: "confirm_extraction" });
    appendAudit({
      actor: "ai",
      action: "route_workflows",
      to: routed.map((r) => r.workflow).join(","),
    });
    // Also propagate legacy fields for the AI report.
    const next = updateIntake({
      extractionConfirmed: true,
      routedWorkflows: routed,
      address: eff.propertyAddress ?? eff.situsAddress ?? state.address,
      cad: eff.cadName ?? state.cad,
      accountNumber: eff.accountNumber ?? state.accountNumber,
      ownerName: eff.ownerName ?? state.ownerName,
      taxYear: eff.taxYear ?? state.taxYear,
      landValue: eff.landValue ?? state.landValue,
      improvementValue: eff.improvementValue ?? state.improvementValue,
      totalValue:
        eff.noticeValue ?? ((eff.landValue ?? 0) + (eff.improvementValue ?? 0) || state.totalValue),
      confirmed: true,
    });
    setState(next);

    if (user && next.address) {
      setSaving(true);
      try {
        const saved = await addProperty(user.id, {
          address: next.address,
          cad: next.cad,
          accountNumber: next.accountNumber,
          ownerName: next.ownerName,
          landValue: next.landValue,
          improvementValue: next.improvementValue,
          totalValue: next.totalValue,
          taxYear: next.taxYear,
          protestDeadline: eff.protestDeadline ?? undefined,
          paymentDueDate: eff.paymentDueDate ?? undefined,
          taxAmountDue: eff.taxAmountDue ?? undefined,
          valueHistory: next.valueHistory,
        });
        toast.success("Property added to your dashboard.");

        let documentId: string | undefined;
        const file = takePendingFile();
        if (file) {
          try {
            const doc = await uploadDocument(user.id, saved.id, file, eff.documentType);
            documentId = doc.id;
          } catch (err) {
            console.error(err);
            toast.error("Property saved, but the document itself couldn't be stored.");
          }
        }

        // Makes the workflow cards below ("AI will track this bill" / "AI will track
        // the refund") actually true instead of just displaying a message that goes
        // nowhere — see src/lib/tax-bills.ts.
        if (routed.some((r) => r.workflow === "tax_payment_tracking")) {
          try {
            await addTaxBill(
              user.id,
              saved.id,
              {
                taxYear: eff.taxYear ?? undefined,
                taxableValue: eff.taxableValue ?? undefined,
                taxRate: eff.taxRate ?? undefined,
                amountDue: eff.taxAmountDue ?? undefined,
                dueDate: eff.paymentDueDate ?? undefined,
                penaltyDate: eff.penaltyDate ?? undefined,
              },
              documentId,
            );
            toast.success("Tax bill saved. Track it under Dashboard → Tax Bills.");
          } catch (err) {
            console.error(err);
            toast.error("Property saved, but the tax bill couldn't be tracked.");
          }
        } else if (routed.some((r) => r.workflow === "refund_tracking")) {
          try {
            const bill = await addTaxBill(
              user.id,
              saved.id,
              { taxYear: eff.taxYear ?? undefined, notes: "From uploaded refund notice" },
              documentId,
            );
            await recordRefund(bill.id, { amount: eff.refundAmount ?? undefined });
            toast.success("Refund saved. Track it under Dashboard → Tax Bills.");
          } catch (err) {
            console.error(err);
            toast.error("Property saved, but the refund couldn't be tracked.");
          }
        }
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not save this property to your dashboard.",
        );
      } finally {
        setSaving(false);
      }
    }

    setMode("confirmed");
  }

  return (
    <div className="container-page py-10 max-w-5xl">
      <div className="flex items-center gap-2">
        <span className="badge-soft">AI Document Analysis</span>
        <span className="text-xs text-muted-foreground">
          {state.noticeFileName ?? "Uploaded document"}
        </span>
      </div>
      <h1 className="mt-3 font-serif text-3xl font-semibold">
        AI read your document. Please confirm the details.
      </h1>
      <p className="mt-1 text-muted-foreground">
        Document type: <strong>{extraction.documentType}</strong> · Confidence{" "}
        <span
          className={
            lowConfidence ? "text-warning-foreground font-semibold" : "text-success font-semibold"
          }
        >
          {(extraction.confidence * 100).toFixed(0)}%
        </span>
      </p>

      {hearingOpen && (
        <HearingDetails
          hearingDate={extraction.hearingDate}
          hearingTime={extraction.hearingTime}
          hearingInstructions={extraction.hearingInstructions}
          onClose={() => setHearingOpen(false)}
        />
      )}

      {/* Flags */}
      {lowConfidence && (
        <FlagBanner
          tone="warn"
          title="Some details need review."
          body="CorvusPT staff will verify this document before filing or deadline action. You can still edit values below."
        />
      )}
      {mismatch && (
        <FlagBanner
          tone="error"
          title="Possible county or account mismatch."
          body="This document's county or account number doesn't match what you entered earlier in this session. Double-check the details below before confirming."
        />
      )}

      {/* Grid */}
      <section className="mt-6 grid gap-4 md:grid-cols-2">
        <Card>
          <CardTitle>Property</CardTitle>
          <FieldRow
            label="Property / Business Name"
            k="propertyName"
            v={extraction.propertyName}
            mode={mode}
            onChange={saveEdit}
          />
          <FieldRow
            label="Owner Name"
            k="ownerName"
            v={extraction.ownerName}
            mode={mode}
            onChange={saveEdit}
          />
          <FieldRow
            label="Property Address"
            k="propertyAddress"
            v={extraction.propertyAddress}
            mode={mode}
            onChange={saveEdit}
          />
          <FieldRow
            label="Situs Address"
            k="situsAddress"
            v={extraction.situsAddress}
            mode={mode}
            onChange={saveEdit}
          />
        </Card>
        <Card>
          <CardTitle>Jurisdiction</CardTitle>
          <FieldRow
            label="County"
            k="county"
            v={extraction.county}
            mode={mode}
            onChange={saveEdit}
          />
          <FieldRow
            label="CAD Name"
            k="cadName"
            v={extraction.cadName}
            mode={mode}
            onChange={saveEdit}
          />
          <FieldRow
            label="Account Number"
            k="accountNumber"
            v={extraction.accountNumber}
            mode={mode}
            onChange={saveEdit}
          />
          <FieldRow
            label="Parcel ID"
            k="parcelId"
            v={extraction.parcelId}
            mode={mode}
            onChange={saveEdit}
          />
          <FieldRow
            label="Tax Year"
            k="taxYear"
            v={extraction.taxYear}
            mode={mode}
            onChange={saveEdit}
            numeric
          />
        </Card>
        <Card>
          <CardTitle>Values</CardTitle>
          <FieldRow
            label="Notice Value"
            k="noticeValue"
            v={extraction.noticeValue}
            mode={mode}
            onChange={saveEdit}
            numeric
            money
          />
          <FieldRow
            label="Land Value"
            k="landValue"
            v={extraction.landValue}
            mode={mode}
            onChange={saveEdit}
            numeric
            money
          />
          <FieldRow
            label="Improvement Value"
            k="improvementValue"
            v={extraction.improvementValue}
            mode={mode}
            onChange={saveEdit}
            numeric
            money
          />
          <FieldRow
            label="BPP Value"
            k="bppValue"
            v={extraction.bppValue}
            mode={mode}
            onChange={saveEdit}
            numeric
            money
          />
          <FieldRow
            label="Prior Value"
            k="priorValue"
            v={extraction.priorValue}
            mode={mode}
            onChange={saveEdit}
            numeric
            money
          />
        </Card>
        <Card>
          <CardTitle>Dates & Deadlines</CardTitle>
          <FieldRow
            label="Notice Date"
            k="noticeDate"
            v={extraction.noticeDate}
            mode={mode}
            onChange={saveEdit}
          />
          <FieldRow
            label="Mail Date"
            k="mailDate"
            v={extraction.mailDate}
            mode={mode}
            onChange={saveEdit}
          />
          <FieldRow
            label="Protest Deadline"
            k="protestDeadline"
            v={extraction.protestDeadline}
            mode={mode}
            onChange={saveEdit}
          />
          <FieldRow
            label="Hearing Date"
            k="hearingDate"
            v={extraction.hearingDate}
            mode={mode}
            onChange={saveEdit}
            onValueClick={() => setHearingOpen(true)}
          />
          <FieldRow
            label="Payment Due Date"
            k="paymentDueDate"
            v={extraction.paymentDueDate}
            mode={mode}
            onChange={saveEdit}
          />
          <FieldRow
            label="Tax Amount Due"
            k="taxAmountDue"
            v={extraction.taxAmountDue}
            mode={mode}
            onChange={saveEdit}
            numeric
            money
          />
          <FieldRow
            label="PIN / EPIN"
            k="pinOrEpin"
            v={extraction.pinOrEpin}
            mode={mode}
            onChange={saveEdit}
          />
          <FieldRow
            label="Exemptions"
            k="exemptions"
            v={extraction.exemptions?.join(", ") ?? null}
            mode={mode}
            onChange={(patch) => {
              const val = patch.exemptions as unknown as string | null;
              saveEdit({
                exemptions:
                  typeof val === "string"
                    ? val
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean)
                    : null,
              });
            }}
          />
        </Card>
      </section>

      {/* Actions */}
      <section className="mt-8 card-elev p-5 flex flex-wrap gap-2 justify-between items-center">
        <div className="text-sm text-muted-foreground">
          {mode === "edit"
            ? "Edits are saved automatically. Return to review when finished."
            : "AI extracted values above. Data Not Found means the field wasn't visible on this document."}
        </div>
        <div className="flex flex-wrap gap-2">
          {mode !== "edit" ? (
            <>
              <button
                onClick={onConfirm}
                disabled={saving}
                className={`btn-primary btn-primary-hover ${saving ? "opacity-60" : ""}`}
              >
                {saving ? "Saving…" : "Confirm Details"}
              </button>
              <button onClick={() => setMode("edit")} className="btn-outline">
                Edit Details
              </button>
              <Link to="/intake" className="btn-outline">
                Upload Another Document
              </Link>
              <button onClick={() => setAskOpen(true)} className="btn-outline">
                Ask AI
              </button>
            </>
          ) : (
            <button onClick={() => setMode("review")} className="btn-primary btn-primary-hover">
              Done editing
            </button>
          )}
        </div>
      </section>

      {/* Workflow routing shown after confirm */}
      {mode === "confirmed" && (
        <section className="mt-8">
          <h2 className="font-serif text-2xl font-semibold">
            AI identified the next best workflow.
          </h2>
          <p className="text-muted-foreground text-sm">
            Based on this document, AI recommends the following path
            {workflows.length > 1 ? "s" : ""}.
          </p>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {workflows.map((w) => {
              const isBillOrRefund =
                w.workflow === "tax_payment_tracking" || w.workflow === "refund_tracking";
              return (
                <div key={w.workflow} className="card-elev p-5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="badge-soft">{w.primary ? "Primary" : "Also detected"}</span>
                    <span className="text-xs text-muted-foreground">{w.label}</span>
                  </div>
                  <p className="mt-3">{w.message}</p>
                  <div className="mt-4 flex gap-2">
                    {isBillOrRefund ? (
                      <Link
                        to="/dashboard/tax-bills"
                        className="btn-primary btn-primary-hover text-sm py-2"
                      >
                        View Tax Bills
                      </Link>
                    ) : (
                      <Link to="/ai-report" className="btn-primary btn-primary-hover text-sm py-2">
                        Continue
                      </Link>
                    )}
                    <Link to="/dashboard" className="btn-outline text-sm py-2">
                      {user ? "View on Dashboard" : "Go to Dashboard"}
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
          {(lowConfidence || mismatch) && (
            <p className="mt-4 text-sm text-muted-foreground">
              Because this document was flagged, CorvusPT staff will review the routing before any
              filing action.
            </p>
          )}
        </section>
      )}

      {/* Audit log summary */}
      {(state.auditLog?.length ?? 0) > 0 && (
        <details className="mt-8 card-elev p-5">
          <summary className="cursor-pointer text-sm font-medium">
            Audit log ({state.auditLog?.length ?? 0} entries)
          </summary>
          <ul className="mt-3 text-xs text-muted-foreground space-y-1 max-h-64 overflow-auto">
            {state.auditLog?.map((a, i) => (
              <li key={i}>
                <span className="text-foreground">
                  [{new Date(a.ts).toLocaleTimeString()}] {a.actor.toUpperCase()} · {a.action}
                </span>
                {a.field ? (
                  <>
                    {" "}
                    · <em>{a.field}</em>: {String(a.from ?? "—")} → {String(a.to ?? "—")}
                  </>
                ) : null}
                {a.reason ? ` · ${a.reason}` : null}
              </li>
            ))}
          </ul>
        </details>
      )}

      {askOpen && (
        <AskModal
          onClose={() => setAskOpen(false)}
          ask={async (q) => {
            const res = await askAboutDocument({
              question: q,
              context: JSON.stringify(extraction),
            });
            return res.answer;
          }}
        />
      )}
    </div>
  );
}

const WHATS_NEXT_STEPS = [
  "If you haven't filed your protest yet, make sure you submit it before the deadline mentioned in your appraisal notice.",
  "If your notice doesn't include a hearing date and time, keep an eye out for the hearing notice from your appraisal district.",
  "When you receive your hearing notice, read it carefully. It will explain how your hearing will be conducted, what documents you need to submit, any deadlines you need to meet, and any other instructions you should follow.",
  "Start gathering your evidence, such as comparable sales, photos, contractor estimates, or any other documents that support your protest.",
  "Review the AI-generated protest summary and talking points so you know exactly what you'll present at the hearing.",
  "Upload any additional evidence you'd like to include before your hearing.",
  "Attend your hearing with your documents ready and present your case.",
  "After the hearing, come back to record the outcome and track your updated property value and estimated tax savings.",
];

function formatHearingDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function HearingDetails({
  hearingDate,
  hearingTime,
  hearingInstructions,
  onClose,
}: {
  hearingDate: string | null;
  hearingTime: string | null;
  hearingInstructions: string | null;
  onClose: () => void;
}) {
  const dateLabel = formatHearingDate(hearingDate);

  return (
    <section className="mt-6 card-elev p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Hearing Date &amp; Time
          </div>
          <div className="mt-1 font-serif text-2xl font-semibold">
            {dateLabel ? (
              <>
                {dateLabel}
                {hearingTime ? ` at ${hearingTime}` : ""}
              </>
            ) : (
              "Not yet scheduled"
            )}
          </div>
          {!dateLabel && (
            <p className="mt-1 text-sm text-muted-foreground">
              This notice didn't include a hearing date. See "What's Next?" below for what to do in
              the meantime.
            </p>
          )}
        </div>
        <button onClick={onClose} className="text-sm text-muted-foreground hover:text-foreground">
          Close
        </button>
      </div>

      {hearingInstructions && (
        <div className="mt-5">
          <h3 className="text-sm font-semibold">Hearing Instructions (from your notice)</h3>
          <p className="mt-2 rounded-md bg-secondary/60 p-4 text-sm whitespace-pre-wrap">
            {hearingInstructions}
          </p>
        </div>
      )}

      <div className="mt-6">
        <h3 className="font-serif text-lg font-semibold">What's Next?</h3>
        <ol className="mt-3 grid gap-2 text-sm list-decimal list-inside">
          {WHATS_NEXT_STEPS.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function FlagBanner({
  tone,
  title,
  body,
}: {
  tone: "warn" | "error";
  title: string;
  body: string;
}) {
  const cls =
    tone === "error"
      ? "bg-destructive/10 border-destructive/40 text-foreground"
      : "bg-warning/15 border-warning/40 text-foreground";
  return (
    <div className={`mt-5 card-elev p-4 border ${cls}`}>
      <div className="font-semibold">{title}</div>
      <p className="text-sm text-muted-foreground mt-1">{body}</p>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="card-elev p-5 grid gap-3">{children}</div>;
}
function CardTitle({ children }: { children: React.ReactNode }) {
  return <div className="font-serif text-lg font-semibold">{children}</div>;
}

function FieldRow<K extends keyof Extraction>({
  label,
  k,
  v,
  mode,
  onChange,
  numeric,
  money,
  onValueClick,
}: {
  label: string;
  k: K;
  v: Extraction[K] | string | null;
  mode: Mode;
  onChange: (patch: Partial<Extraction>) => void;
  numeric?: boolean;
  money?: boolean;
  onValueClick?: () => void;
}) {
  const [local, setLocal] = useState<string>(v == null ? "" : String(v));
  useEffect(() => {
    setLocal(v == null ? "" : String(v));
  }, [v]);

  const shown =
    v == null || v === ""
      ? "Data Not Found"
      : money && typeof v === "number"
        ? currency(v)
        : displayVal(v as string | number | null);

  if (mode !== "edit") {
    return (
      <div className="grid grid-cols-[minmax(140px,1fr)_2fr] items-baseline gap-3">
        <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
        {onValueClick ? (
          <dd>
            <button
              type="button"
              onClick={onValueClick}
              className={`text-sm text-left underline underline-offset-2 hover:text-accent ${
                v == null || v === "" ? "text-muted-foreground italic" : "text-accent"
              }`}
            >
              {shown}
            </button>
          </dd>
        ) : (
          <dd
            className={v == null || v === "" ? "text-muted-foreground italic text-sm" : "text-sm"}
          >
            {shown}
          </dd>
        )}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[minmax(140px,1fr)_2fr] items-center gap-3">
      <label className="text-xs uppercase tracking-wide text-muted-foreground">{label}</label>
      <input
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          const raw = local.trim();
          if (raw === "") {
            onChange({ [k]: null } as Partial<Extraction>);
            return;
          }
          if (numeric) {
            const n = Number(raw.replace(/[$,]/g, ""));
            onChange({ [k]: Number.isFinite(n) ? n : null } as Partial<Extraction>);
          } else {
            onChange({ [k]: raw } as Partial<Extraction>);
          }
        }}
        className="rounded-md border border-input bg-background px-3 py-2 text-sm"
      />
    </div>
  );
}

function AskModal({ onClose, ask }: { onClose: () => void; ask: (q: string) => Promise<string> }) {
  const [q, setQ] = useState("");
  const [a, setA] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <Modal onClose={onClose}>
      <h3 className="font-serif text-xl font-semibold">Ask AI about this document</h3>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!q.trim()) return;
          setLoading(true);
          setErr(null);
          setA(null);
          try {
            const res = await ask(q.trim());
            setA(res);
          } catch (e2) {
            console.error(e2);
            setErr(e2 instanceof Error ? e2.message : "Could not get an answer. Please try again.");
          } finally {
            setLoading(false);
          }
        }}
        className="mt-4 grid gap-2"
      >
        <textarea
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="e.g. What is my protest deadline? Is the notice value higher than last year?"
          className="rounded-md border border-input bg-background px-3 py-2 min-h-[80px] text-sm"
        />
        <button className="btn-primary btn-primary-hover" disabled={loading}>
          {loading ? "Thinking…" : "Ask AI"}
        </button>
      </form>
      {err && <p className="mt-3 text-sm text-destructive">{err}</p>}
      {a && (
        <div className="mt-4 rounded-md bg-secondary/60 p-3 text-sm whitespace-pre-wrap">{a}</div>
      )}
    </Modal>
  );
}
