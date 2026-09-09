import { useState, type ReactNode } from "react";
import { buildCaseReport, type CaseReportInputs, type ProtestCaseReport } from "@/lib/case-report";
import type { FinalCaseSummary } from "@/lib/final-case-summary";

// Module 10's "Full Case Report" — the consolidated protest playbook. Purely
// presentational: `buildCaseReport` (deterministic, no AI) does the assembly;
// this renders its eight sections. Reused as-is anywhere a ProtestCaseReport
// is available (Module 10 modal today; View Case later).

const CAT_META: Record<
  ProtestCaseReport["nextActions"][number]["category"],
  { label: string; cls: string }
> = {
  next_step: { label: "Do this next", cls: "border-accent/50 bg-accent/10 text-accent" },
  waiting_on_user: {
    label: "Waiting on you",
    cls: "border-warning/40 bg-warning/10 text-warning-foreground",
  },
  waiting_on_county: {
    label: "Waiting on the county",
    cls: "border-border bg-secondary/40 text-muted-foreground",
  },
  upcoming_deadline: {
    label: "Upcoming deadline",
    cls: "border-destructive/40 bg-destructive/10 text-destructive",
  },
  completed: { label: "Completed", cls: "border-success/40 bg-success/5 text-success" },
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border p-4">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      <div className="mt-2 text-sm">{children}</div>
    </section>
  );
}

function KeyValues({ rows }: { rows: { label: string; value: string }[] }) {
  return (
    <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
      {rows.map((r) => (
        <div key={r.label} className="min-w-0">
          <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{r.label}</dt>
          <dd className="font-medium text-foreground">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Bullets({ items, empty }: { items: string[]; empty?: string }) {
  if (items.length === 0) return <p className="text-muted-foreground">{empty ?? "None."}</p>;
  return (
    <ul className="list-disc space-y-1 pl-5">
      {items.map((it, n) => (
        <li key={n}>{it}</li>
      ))}
    </ul>
  );
}

export function CaseReportView({ report }: { report: ProtestCaseReport }) {
  const r = report;
  return (
    <div className="mt-4 grid gap-3">
      {r.primaryAction && (
        <div className="rounded-lg border border-accent/50 bg-accent/10 p-4">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-accent">
            Your next required action
          </div>
          <p className="mt-1 font-serif text-base font-bold text-foreground">
            {r.primaryAction.label}
          </p>
          {r.primaryAction.detail && (
            <p className="mt-0.5 text-xs text-muted-foreground">{r.primaryAction.detail}</p>
          )}
        </div>
      )}

      <Section title="Property Information">
        <KeyValues rows={r.propertyInfo} />
      </Section>

      <Section title="Protest Information">
        <KeyValues rows={r.protestInfo} />
      </Section>

      <Section title="Value Analysis">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Current value
            </div>
            <div className="font-semibold">{r.valueAnalysis.currentValue}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Target value
            </div>
            <div className="font-semibold">{r.valueAnalysis.targetValue}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Est. reduction
            </div>
            <div className="font-semibold">{r.valueAnalysis.estimatedReduction}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Est. savings / yr
            </div>
            <div className="font-semibold text-success">{r.valueAnalysis.estimatedSavings}</div>
          </div>
        </div>
        <div className="mt-2">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Supporting rationale
          </div>
          <Bullets items={r.valueAnalysis.rationale} />
        </div>
      </Section>

      <Section title="Evidence">
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Uploaded
            </div>
            <Bullets items={r.evidence.uploaded} empty="Nothing uploaded yet." />
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Accepted (passed AI check)
            </div>
            <Bullets items={r.evidence.accepted} empty="None checked yet." />
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Missing / recommended
            </div>
            <Bullets items={r.evidence.missing} empty="Checklist looks complete." />
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Packet & submission
            </div>
            <p>{r.evidence.packetStatus}</p>
            <p className="text-muted-foreground">{r.evidence.submissionStatus}</p>
          </div>
        </div>
      </Section>

      <Section title="Key Documents">
        <ul className="space-y-1">
          {r.keyDocuments.map((d) => (
            <li key={d.label} className="flex items-start gap-2">
              <span
                className={
                  d.status === "on_file"
                    ? "text-success"
                    : d.status === "missing"
                      ? "text-warning-foreground"
                      : "text-muted-foreground"
                }
              >
                {d.status === "on_file" ? "●" : d.status === "missing" ? "○" : "–"}
              </span>
              <span className="flex-1">
                <span className="font-medium text-foreground">{d.label}</span>
                <span className="text-muted-foreground">
                  {" "}
                  —{" "}
                  {d.status === "on_file"
                    ? (d.fileName ?? "on file")
                    : d.status === "missing"
                      ? "not on file"
                      : "not applicable"}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Hearing Guide">
        {r.hearingGuide.scheduled ? (
          <>
            <KeyValues
              rows={[
                { label: "Date / time", value: r.hearingGuide.dateTime },
                { label: "Location / mode", value: r.hearingGuide.locationMode },
              ]}
            />
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  What to bring
                </div>
                <Bullets
                  items={r.hearingGuide.whatToBring}
                  empty="See the Hearing Preparation guide."
                />
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  What to submit
                </div>
                <Bullets
                  items={r.hearingGuide.whatToSubmit}
                  empty="See the Hearing Preparation guide."
                />
              </div>
            </div>
            {r.hearingGuide.openingStatement && (
              <div className="mt-2">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Suggested opening statement
                </div>
                <p className="italic">{r.hearingGuide.openingStatement}</p>
              </div>
            )}
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Key arguments
                </div>
                <Bullets items={r.hearingGuide.keyArguments} empty="See the Strategy module." />
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Comparable evidence
                </div>
                <Bullets
                  items={r.hearingGuide.comparableEvidence}
                  empty="No comparable-sales data for this county."
                />
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Questions to ask
                </div>
                <Bullets items={r.hearingGuide.questionsToAsk} empty="—" />
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Questions to expect
                </div>
                <Bullets items={r.hearingGuide.questionsToExpect} empty="—" />
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Weaknesses / risks
                </div>
                <Bullets items={r.hearingGuide.risks} empty="—" />
              </div>
            </div>
            {r.hearingGuide.closingStatement && (
              <div className="mt-2">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Closing statement
                </div>
                <p className="italic">{r.hearingGuide.closingStatement}</p>
              </div>
            )}
            <p className="mt-2 text-[11px] text-muted-foreground">{r.hearingGuide.note}</p>
          </>
        ) : (
          <p className="text-muted-foreground">{r.hearingGuide.note}</p>
        )}
      </Section>

      <Section title="County Instructions">
        <KeyValues rows={r.countyInstructions} />
      </Section>

      <Section title="Next Actions">
        <ul className="space-y-1.5">
          {r.nextActions.map((a, n) => {
            const meta = CAT_META[a.category];
            return (
              <li key={n} className="flex flex-wrap items-start gap-2">
                <span
                  className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${meta.cls}`}
                >
                  {meta.label}
                </span>
                <span className="flex-1">
                  <span className={a.primary ? "font-semibold text-foreground" : "text-foreground"}>
                    {a.label}
                  </span>
                  {a.detail && (
                    <span className="block text-xs text-muted-foreground">{a.detail}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </Section>
    </div>
  );
}

// Final case summary — added to Module 9 once the protest process has
// concluded (see buildFinalCaseSummary). Deterministic; every figure is a
// real, decision-backed number. Renders nothing while the case is still in
// progress.
export function FinalCaseSummaryPanel({ summary }: { summary: FinalCaseSummary }) {
  if (!summary.available) return null;
  const s = summary;
  const closed = s.status.kind === "closed";
  const rows: { label: string; value: string }[] = [
    { label: "Original value", value: s.originalValue },
    { label: "Final value", value: s.finalValue },
    { label: "Value reduction", value: s.valueReduction },
    {
      label:
        s.taxSavings.basis === "actual"
          ? "Actual tax savings / yr"
          : s.taxSavings.basis === "estimated"
            ? "Estimated tax savings / yr"
            : "Tax savings",
      value: s.taxSavings.value,
    },
    { label: "Protest outcome", value: s.protestOutcome },
    { label: "Informal outcome", value: s.informalOutcome },
    { label: "Hearing outcome", value: s.hearingOutcome },
    { label: "Decision date", value: s.decisionDate },
    ...(s.remainingEscalationDeadline
      ? [{ label: "Remaining appeal / escalation deadline", value: s.remainingEscalationDeadline }]
      : []),
    { label: "Case close date", value: s.caseCloseDate },
  ];
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-serif text-base font-bold text-foreground">Final Case Summary</h4>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
            closed ? "bg-success/15 text-success" : "bg-destructive/10 text-destructive"
          }`}
        >
          {s.status.label}
        </span>
      </div>
      <dl className="mt-3 grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
        {rows.map((r) => (
          <div key={r.label} className="min-w-0">
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{r.label}</dt>
            <dd className="font-medium text-foreground">{r.value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 rounded-md border border-accent/40 bg-accent/10 p-3">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-accent">
          Recommended next action
        </div>
        <p className="mt-0.5 text-sm text-foreground">{s.recommendedNextAction}</p>
      </div>
      <p className="mt-2 text-[10px] text-muted-foreground">
        Figures are the real, recorded outcome of this case. Savings shown before the case is closed
        are estimates, not a guarantee.
      </p>
    </div>
  );
}

// Module 10 modal shell: keeps the existing executive summary exactly as it
// was (passed in as `summary`) and adds a second tab that renders the
// consolidated report. The report is built on demand from `reportInputs`
// (cheap, pure) the first time the tab is shown.
export function ExecutiveModuleTabs({
  summary,
  reportInputs,
}: {
  summary: ReactNode;
  reportInputs: CaseReportInputs;
}) {
  const [tab, setTab] = useState<"summary" | "report">("summary");
  return (
    <div>
      <div className="mt-2 flex gap-1 border-b border-border">
        {(["summary", "report"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-xs font-semibold transition-colors ${
              tab === t
                ? "border-accent text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t === "summary" ? "Executive Summary" : "Full Case Report"}
          </button>
        ))}
      </div>
      {tab === "summary" ? summary : <CaseReportView report={buildCaseReport(reportInputs)} />}
    </div>
  );
}
