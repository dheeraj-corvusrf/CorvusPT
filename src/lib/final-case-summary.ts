// Deterministic final case summary — shown in Module 9 once the protest
// process has actually concluded (an accepted informal offer, an ARB
// decision, or a resolved case). Same discipline as case-guidance.ts /
// case-report.ts: every figure is a straight function of real fields on the
// case + the county effective tax rate. No AI, no projection presented as a
// guarantee.
import type { PropertyRecord } from "./properties";
import type { ProtestRecord } from "./protests";
import { INFORMAL_STATUS_LABEL } from "./protests";
import { getEffectiveTaxRate } from "./texas-tax-rates";

const money = (n: number | null | undefined): string =>
  n == null
    ? "—"
    : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const fmtDate = (iso: string | null | undefined): string =>
  iso
    ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : "—";

const DAY = 24 * 60 * 60 * 1000;

export type FinalCaseStatus =
  | { kind: "closed"; label: string }
  | { kind: "action_required"; label: string; deadline: string | null };

export type FinalCaseSummary = {
  // Whether the process has concluded enough to show a meaningful summary.
  available: boolean;
  originalValue: string;
  finalValue: string;
  valueReduction: string;
  taxSavings: { value: string; basis: "actual" | "estimated" | "unavailable" };
  protestOutcome: string;
  informalOutcome: string;
  hearingOutcome: string;
  decisionDate: string;
  remainingEscalationDeadline: string | null;
  recommendedNextAction: string;
  caseCloseDate: string;
  status: FinalCaseStatus;
};

// The earliest still-open post-ARB deadline, or null once the case is
// resolved / already escalated / has no ARB-order date to count from.
function remainingDeadline(property: PropertyRecord, protest: ProtestRecord): string | null {
  if (protest.status === "resolved") return null;
  if (protest.escalationPath === "appeal" || protest.escalationPath === "arbitration") return null;
  if (!protest.arbDecisionDate) return null;
  if (protest.arbDecision !== "denied" && protest.arbDecision !== "partial") return null;
  const base = new Date(`${protest.arbDecisionDate}T00:00:00`).getTime();
  if (!Number.isFinite(base)) return null;
  const value = protest.finalValue ?? protest.originalValue ?? property.totalValue ?? 0;
  // SOAH (30 days) only applies over $1M; otherwise the 60-day arbitration /
  // district-court window is the operative one. Whichever is sooner and
  // still in the future.
  const candidates: number[] = [base + 60 * DAY];
  if (value > 1_000_000) candidates.push(base + 30 * DAY);
  const soonestFuture = candidates.filter((t) => t >= Date.now()).sort((a, b) => a - b)[0];
  const chosen = soonestFuture ?? Math.min(...candidates);
  return new Date(chosen).toISOString().slice(0, 10);
}

export function buildFinalCaseSummary(
  property: PropertyRecord,
  protest: ProtestRecord | null,
  opts?: { recommendedNextStep?: string | null },
): FinalCaseSummary {
  const concluded =
    !!protest &&
    (protest.status === "resolved" ||
      protest.arbDecision != null ||
      protest.informalStatus === "accepted");

  if (!protest || !concluded) {
    return {
      available: false,
      originalValue: "—",
      finalValue: "—",
      valueReduction: "—",
      taxSavings: { value: "—", basis: "unavailable" },
      protestOutcome: "In progress",
      informalOutcome: protest ? INFORMAL_STATUS_LABEL[protest.informalStatus] : "—",
      hearingOutcome: "—",
      decisionDate: "—",
      remainingEscalationDeadline: null,
      recommendedNextAction: opts?.recommendedNextStep ?? "Continue working the case.",
      caseCloseDate: "—",
      status: { kind: "action_required", label: "Action Required", deadline: null },
    };
  }

  const original = protest.originalValue ?? property.totalValue ?? null;
  const final = protest.finalValue ?? null;
  const reduction = original != null && final != null ? Math.max(0, original - final) : null;

  let taxSavings: FinalCaseSummary["taxSavings"];
  if (reduction != null && protest.status === "resolved") {
    taxSavings = {
      value: money(Math.round(reduction * getEffectiveTaxRate(property.cad))),
      basis: "actual",
    };
  } else if (property.estimatedSavings != null) {
    taxSavings = { value: money(property.estimatedSavings), basis: "estimated" };
  } else {
    taxSavings = { value: "—", basis: "unavailable" };
  }

  const protestOutcome =
    protest.status === "resolved"
      ? reduction != null && reduction > 0
        ? "Resolved — value reduced"
        : "Resolved — no change to value"
      : protest.arbDecision === "denied"
        ? "ARB denied — decision not yet accepted or escalated"
        : protest.arbDecision === "partial"
          ? "ARB granted a partial reduction — decision not yet accepted or escalated"
          : "Informal offer accepted — pending close";

  const informalOutcome =
    protest.settlementOfferValue != null
      ? `${INFORMAL_STATUS_LABEL[protest.informalStatus]} (${money(protest.settlementOfferValue)})`
      : INFORMAL_STATUS_LABEL[protest.informalStatus];

  const hearingOutcome = protest.arbDecision
    ? `ARB ${protest.arbDecision}${protest.arbDecisionDate ? ` on ${fmtDate(protest.arbDecisionDate)}` : ""}`
    : protest.hearingDate
      ? "Hearing held — decision pending"
      : "No formal hearing";

  const decisionDate = protest.arbDecisionDate
    ? fmtDate(protest.arbDecisionDate)
    : protest.informalStatus === "accepted"
      ? fmtDate(protest.settlementOfferReceivedAt)
      : "—";

  const deadline = remainingDeadline(property, protest);

  const status: FinalCaseStatus =
    protest.status === "resolved" && !deadline
      ? { kind: "closed", label: "Case Closed" }
      : deadline
        ? {
            kind: "action_required",
            label: `Action Required — Deadline: ${fmtDate(deadline)}`,
            deadline,
          }
        : {
            kind: "action_required",
            label: "Action Required",
            deadline: null,
          };

  const recommendedNextAction =
    opts?.recommendedNextStep ??
    (status.kind === "closed"
      ? "No further action required. You can protest again next tax year."
      : deadline
        ? `Decide whether to accept the ARB value or escalate — before ${fmtDate(deadline)}. See Module 10's escalation review.`
        : "Record the ARB decision and review your escalation options in Module 10.");

  return {
    available: true,
    originalValue: money(original),
    finalValue: money(final),
    valueReduction: money(reduction),
    taxSavings,
    protestOutcome,
    informalOutcome,
    hearingOutcome,
    decisionDate,
    remainingEscalationDeadline: deadline ? fmtDate(deadline) : null,
    recommendedNextAction,
    caseCloseDate: protest.closedAt ? fmtDate(protest.closedAt) : "—",
    status,
  };
}
