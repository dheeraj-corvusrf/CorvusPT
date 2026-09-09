// Deterministic "what remedies may still be available" engine for a case
// whose informal review AND formal ARB hearing both ended unsatisfactorily.
// Same discipline as case-guidance.ts / pre-filing-check.ts: every number
// here is either computed from a real field already on the case/property or
// taken from the statutory dataset below (Texas Property Tax Code, current
// Comptroller deposit schedule). Never an AI call, never an invented figure.
//
// This is explicitly framed as an EVALUATION of options, not a prediction:
// see DISCLAIMER and every option's own wording. Corvus's copy narrates it;
// nothing in the output is model-generated.
import type { PropertyRecord } from "./properties";
import type { ProtestRecord } from "./protests";
import { getEffectiveTaxRate } from "./texas-tax-rates";

export const DISCLAIMER =
  "This is an evaluation of remedies that may be available for your case under the Texas " +
  "Property Tax Code, based on the data on file. It is not legal advice and not a prediction " +
  "or guarantee of any outcome. Deadlines and eligibility can turn on facts only you or an " +
  "attorney can confirm — verify every date with your appraisal district before you rely on it.";

export type EscalationOptionId =
  | "binding_arbitration"
  | "limited_binding_arbitration"
  | "district_court"
  | "soah"
  | "correction_motion"
  | "no_further_action";

export type RiskBand = "lower" | "moderate" | "higher";
export type EvidenceStrength = "strong" | "moderate" | "limited" | "unknown";

export type EscalationOption = {
  id: EscalationOptionId;
  title: string;
  statute: string;
  eligible: boolean;
  eligibilityBasis: string;
  // Null when there's no recorded ARB-order date to count from — the window
  // still exists, we just can't state the date honestly.
  deadline: { date: string | null; basis: string };
  estimatedCost: { min: number; max: number; basis: string } | null;
  potentialAdditionalSavings: { amount: number | null; basis: string };
  estimatedRoi: { ratio: number | null; basis: string };
  evidenceStrength: EvidenceStrength;
  risk: { band: RiskBand; basis: string };
  practicalBenefit: string;
  // The single option Corvus's rules surface as the most reasonable next
  // step for this case — at most one option has this true.
  recommended: boolean;
};

export type EscalationEvaluation = {
  available: boolean;
  // Why the panel is (or isn't) showing — always populated.
  availabilityBasis: string;
  headline: string;
  disclaimer: string;
  options: EscalationOption[];
};

// ── Statutory dataset ────────────────────────────────────────────────────
// Regular binding arbitration deposit schedule — Comptroller Form AP-219,
// paid to the appraisal district with the request. The arbitrator's fee is
// drawn from this; $50 is retained by the Comptroller; the balance is
// refunded to the owner if the arbitrator's value is nearer the owner's
// opinion than the ARB's value (Tax Code §41A.05, §41A.10).
function bindingArbitrationDeposit(value: number, homestead: boolean): number {
  if (homestead) return value <= 500_000 ? 450 : 500;
  if (value <= 500_000) return 500;
  if (value <= 1_000_000) return 800;
  if (value <= 2_000_000) return 1_050;
  if (value <= 3_000_000) return 1_550;
  return 2_500; // > $3M and ≤ $5M (above $5M, non-homestead is ineligible)
}

const BINDING_ARBITRATION_VALUE_CAP = 5_000_000; // §41A.01 — non-homestead
const SOAH_VALUE_FLOOR = 1_000_000; // §42.30 — appeal to SOAH alternative
const LBA_DEPOSIT = 450; // §41A.015 limited binding arbitration
// District-court out-of-pocket, excluding any contingency-fee arrangement —
// a broad, openly-labelled estimate, not a quote.
const DISTRICT_COURT_COST = { min: 350, max: 8_000 };
const SOAH_FILING_FEE = 1_500; // §42.30(b)

const DAY = 24 * 60 * 60 * 1000;

function homesteadLikely(property: PropertyRecord): boolean {
  return /residence|homestead|single.?family|\bsfr\b/i.test(property.propertyType ?? "");
}

function addDays(iso: string | null, days: number): string | null {
  if (!iso) return null;
  const base = new Date(`${iso}T00:00:00`).getTime();
  if (!Number.isFinite(base)) return null;
  return new Date(base + days * DAY).toISOString().slice(0, 10);
}

function bandEvidence(evidenceDocumentCount: number | undefined): EvidenceStrength {
  if (evidenceDocumentCount == null) return "unknown";
  if (evidenceDocumentCount === 0) return "limited";
  if (evidenceDocumentCount <= 2) return "moderate";
  return "strong";
}

// ── Evaluation ──────────────────────────────────────────────────────────
export function evaluateEscalation(
  property: PropertyRecord,
  protest: ProtestRecord,
  evidenceDocumentCount: number | undefined,
  // The owner's own opinion of value (Form 50-132 line, or the AI Report's
  // comps-indicated value). When absent, additional-savings/ROI can't be
  // stated and say so rather than guessing.
  opinionOfValue?: number | null,
): EscalationEvaluation {
  const currentValue = protest.finalValue ?? protest.originalValue ?? property.totalValue ?? null;
  const homestead = homesteadLikely(property);
  const evidence = bandEvidence(evidenceDocumentCount);
  const taxRate = getEffectiveTaxRate(property.cad);
  const orderDate = protest.arbDecisionDate ?? null;
  const courtPetitionFiled = protest.escalationPath === "appeal";

  // The panel only makes sense once BOTH tracks have genuinely closed
  // unfavorably: informal rejected / unavailable AND an ARB decision that
  // wasn't a full win.
  const informalClosedUnfavourably =
    protest.informalStatus === "rejected" || protest.informalStatus === "no_informal_available";
  const arbUnfavourable = protest.arbDecision === "denied" || protest.arbDecision === "partial";
  const available = informalClosedUnfavourably && arbUnfavourable;
  const availabilityBasis = available
    ? `Informal review ${protest.informalStatus === "rejected" ? "was rejected" : "was not available"} ` +
      `and the ARB ${protest.arbDecision === "denied" ? "denied the protest" : "granted only a partial reduction"}.`
    : "Escalation options open only after the informal review and the formal ARB hearing have both concluded without a satisfactory result.";

  // Potential additional savings = (current roll value − owner's opinion) ×
  // effective tax rate, floored at zero. Only when an opinion is on file.
  const gap =
    opinionOfValue != null && currentValue != null
      ? Math.max(0, currentValue - opinionOfValue)
      : null;
  const additionalSavings = gap != null ? Math.round(gap * taxRate) : null;
  const savingsBasis =
    additionalSavings != null
      ? `(${currentValue!.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })} current value − your ${opinionOfValue!.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })} opinion) × ${(taxRate * 100).toFixed(1)}% effective tax rate. One year; a sustained reduction compounds.`
      : "Add your opinion of value (from your Notice of Protest or the AI Report's comparable-sales range) to estimate this.";

  const roi = (cost: { min: number; max: number } | number | null) => {
    if (additionalSavings == null || cost == null) {
      return {
        ratio: null,
        basis: "Needs an opinion of value and a cost figure.",
      };
    }
    const mid = typeof cost === "number" ? cost : (cost.min + cost.max) / 2;
    if (mid <= 0) return { ratio: null, basis: "No out-of-pocket cost recorded." };
    return {
      ratio: Math.round((additionalSavings / mid) * 10) / 10,
      basis: `First-year additional savings ÷ midpoint cost (${mid.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })}).`,
    };
  };

  // Risk band: starts from evidence strength, then nudged by how the ARB
  // already moved. A partial grant means the ARB accepted some of the case
  // and the remaining gap is harder to win; a flat denial leaves the whole
  // gap live but signals the ARB was unpersuaded.
  const riskFor = (base: RiskBand): { band: RiskBand; basis: string } => {
    let band = base;
    const bump = (b: RiskBand): RiskBand => (b === "lower" ? "moderate" : "higher");
    if (protest.arbDecision === "partial") band = bump(band);
    return {
      band,
      basis:
        `Evidence on file is ${evidence}` +
        (protest.arbDecision === "partial"
          ? "; the ARB already granted part of the reduction, so the remaining gap is harder to move."
          : "; the ARB denied the protest outright.") +
        " Risk is a qualitative read, not a probability.",
    };
  };
  const evidenceRiskBase: RiskBand =
    evidence === "strong" ? "lower" : evidence === "moderate" ? "moderate" : "higher";

  const options: EscalationOption[] = [];

  // 1 — Regular binding arbitration (§41A)
  {
    const capOk =
      homestead || (currentValue != null && currentValue <= BINDING_ARBITRATION_VALUE_CAP);
    const eligible = capOk && !courtPetitionFiled;
    const deposit =
      currentValue != null ? bindingArbitrationDeposit(currentValue, homestead) : null;
    options.push({
      id: "binding_arbitration",
      title: "Regular binding arbitration",
      statute: "Tax Code §41A",
      eligible,
      eligibilityBasis: !capOk
        ? `Non-homestead property over the $5,000,000 arbitration cap.`
        : courtPetitionFiled
          ? "Not available once a district-court petition has been filed for the same order."
          : homestead
            ? "Residence homesteads qualify at any value."
            : `Appraised value is within the $5,000,000 cap.`,
      deadline: {
        date: addDays(orderDate, 60),
        basis: orderDate
          ? "60th day after the ARB order was received (§41A.03)."
          : "Within 60 days of receiving the ARB order — record the order date to see the exact deadline.",
      },
      estimatedCost:
        deposit != null
          ? {
              min: deposit,
              max: deposit,
              basis:
                `Deposit filed with the appraisal district (Comptroller Form AP-219). ` +
                `$50 is retained; the rest funds the arbitrator's fee and is refunded to you ` +
                `if the arbitrator's value is closer to your opinion than to the ARB's.`,
            }
          : null,
      potentialAdditionalSavings: { amount: additionalSavings, basis: savingsBasis },
      estimatedRoi: roi(deposit),
      evidenceStrength: evidence,
      risk: riskFor(evidenceRiskBase),
      practicalBenefit:
        "A neutral arbitrator re-decides the value. Cheaper and faster than court, no attorney required, " +
        "and the downside is largely capped at the deposit. Best fit when the value gap is real but the " +
        "dollars don't justify litigation.",
      recommended: false,
    });
  }

  // 2 — Limited binding arbitration (§41A.015) — procedural only
  options.push({
    id: "limited_binding_arbitration",
    title: "Limited binding arbitration (procedural)",
    statute: "Tax Code §41A.015",
    eligible: false,
    eligibilityBasis:
      "Only for compelling the ARB or chief appraiser to follow a specific procedural requirement " +
      "(notice, hearing procedure, evidence exchange) — not for re-arguing value. Applies only if a " +
      "procedural failure actually occurred at your hearing.",
    deadline: {
      date: null,
      basis:
        "Request within 30 days of the procedural failure, after giving the ARB chair 10 days' written " +
        "notice to cure (§41A.015).",
    },
    estimatedCost: {
      min: LBA_DEPOSIT,
      max: LBA_DEPOSIT,
      basis: "Fixed $450 deposit, refundable if the arbitrator finds the failure occurred.",
    },
    potentialAdditionalSavings: {
      amount: null,
      basis: "Procedural remedy — it can reset the hearing, not change the value directly.",
    },
    estimatedRoi: { ratio: null, basis: "Not a value remedy." },
    evidenceStrength: "unknown",
    risk: {
      band: "moderate",
      basis: "Turns entirely on whether a documented procedural violation occurred.",
    },
    practicalBenefit:
      "If the ARB genuinely skipped a required step, this forces a compliant do-over of the hearing " +
      "for a small fixed cost.",
    recommended: false,
  });

  // 3 — District court appeal (§42)
  {
    options.push({
      id: "district_court",
      title: "Appeal to district court",
      statute: "Tax Code §42",
      eligible: true,
      eligibilityBasis:
        "Available for any property after an ARB order. You must also pay the undisputed portion of " +
        "the tax before it becomes delinquent (§42.08).",
      deadline: {
        date: addDays(orderDate, 60),
        basis: orderDate
          ? "60th day after receiving the ARB order (§42.06)."
          : "Within 60 days of receiving the ARB order — record the order date to see the exact deadline.",
      },
      estimatedCost: {
        ...DISTRICT_COURT_COST,
        basis:
          "Court filing fee plus, typically, a fee appraisal and counsel. Many owners use a contingency " +
          "fee instead of paying hourly. Broad estimate — get a real quote.",
      },
      potentialAdditionalSavings: { amount: additionalSavings, basis: savingsBasis },
      estimatedRoi: roi(DISTRICT_COURT_COST),
      evidenceStrength: evidence,
      risk: {
        band: evidence === "strong" ? "moderate" : "higher",
        basis:
          "De novo review — a fresh look at value — but litigation cost and time are real, and the " +
          `evidence on file is ${evidence}. Usually only economic when the value gap is large.`,
      },
      practicalBenefit:
        "The strongest remedy: the court is not bound by the ARB's finding. Worth it when a large value " +
        "gap makes the recoverable tax dwarf the litigation cost.",
      recommended: false,
    });
  }

  // 4 — SOAH appeal (§42.30) — larger properties only
  {
    const eligible = currentValue != null && currentValue > SOAH_VALUE_FLOOR;
    options.push({
      id: "soah",
      title: "Appeal to SOAH",
      statute: "Tax Code §42.30",
      eligible,
      eligibilityBasis: eligible
        ? "Appraised value is over $1,000,000, so a State Office of Administrative Hearings appeal is an " +
          "alternative to district court for this order."
        : "Only for property appraised over $1,000,000.",
      deadline: {
        date: addDays(orderDate, 30),
        basis: orderDate
          ? "30th day after receiving the ARB order (§42.30(a))."
          : "Within 30 days of receiving the ARB order — shorter than the court window.",
      },
      estimatedCost: {
        min: SOAH_FILING_FEE,
        max: SOAH_FILING_FEE,
        basis:
          "$1,500 filing fee (§42.30(b)); $300 is retained if you do not prevail, the rest refunded.",
      },
      potentialAdditionalSavings: { amount: additionalSavings, basis: savingsBasis },
      estimatedRoi: roi(SOAH_FILING_FEE),
      evidenceStrength: evidence,
      risk: riskFor(evidenceRiskBase),
      practicalBenefit:
        "An administrative-law judge re-decides value — less costly and formal than court, but the filing " +
        "window is tighter (30 days) and it's limited to higher-value property.",
      recommended: false,
    });
  }

  // 5 — Correction motion (§25.25) — narrow, and usually foreclosed by a hearing
  options.push({
    id: "correction_motion",
    title: "Correction motion",
    statute: "Tax Code §25.25",
    eligible: false,
    eligibilityBasis:
      "§25.25(c) covers clerical errors, duplicate appraisals, non-existent property, and ownership " +
      "errors — not a value disagreement. §25.25(d) (value over one-third too high) is generally " +
      "unavailable once you have had a §41.41 hearing on that value for the year, and carries a 10% " +
      "late-correction penalty.",
    deadline: {
      date: null,
      basis: "§25.25(c): up to 5 years back. §25.25(d): before taxes become delinquent.",
    },
    estimatedCost: {
      min: 0,
      max: 0,
      basis: "No filing fee; a §25.25(d) correction adds a 10% penalty on the corrected tax.",
    },
    potentialAdditionalSavings: {
      amount: null,
      basis: "Only if a qualifying error — not a value dispute — is actually present.",
    },
    estimatedRoi: { ratio: null, basis: "Depends entirely on the specific error." },
    evidenceStrength: "unknown",
    risk: {
      band: "higher",
      basis:
        "Rarely available after a completed protest hearing; confirm with the appraisal district.",
    },
    practicalBenefit:
      "The right tool only if the roll has a factual/clerical error (wrong square footage carried for " +
      "years, the same parcel appraised twice) rather than a value you simply disagree with.",
    recommended: false,
  });

  // 6 — No further action
  options.push({
    id: "no_further_action",
    title: "Accept the ARB value and close",
    statute: "—",
    eligible: true,
    eligibilityBasis: "Always available.",
    deadline: { date: null, basis: "No deadline." },
    estimatedCost: { min: 0, max: 0, basis: "None." },
    potentialAdditionalSavings: { amount: 0, basis: "No further reduction pursued this year." },
    estimatedRoi: { ratio: null, basis: "—" },
    evidenceStrength: evidence,
    risk: {
      band: "lower",
      basis: "No cost, no deadline exposure. You can protest again next year.",
    },
    practicalBenefit:
      "The right call when the remaining gap is small, the evidence is thin, or the cost and effort of " +
      "escalating outweigh a single year's additional savings.",
    recommended: false,
  });

  // ── Recommendation ────────────────────────────────────────────────────
  // Pick the eligible value-remedy with the best first-year ROI when we can
  // compute one and the risk isn't "higher"; otherwise recommend closing.
  const valueRemedies = options.filter(
    (o) =>
      o.eligible &&
      (o.id === "binding_arbitration" || o.id === "district_court" || o.id === "soah"),
  );
  const scored = valueRemedies
    .filter(
      (o) => o.estimatedRoi.ratio != null && o.estimatedRoi.ratio >= 2 && o.risk.band !== "higher",
    )
    .sort((a, b) => (b.estimatedRoi.ratio ?? 0) - (a.estimatedRoi.ratio ?? 0));
  const pick = scored[0] ?? options.find((o) => o.id === "no_further_action")!;
  pick.recommended = true;

  const headline = available
    ? pick.id === "no_further_action"
      ? "Escalation may be available — but accepting the ARB value looks like the better call"
      : `Escalation may be available — ${pick.title.toLowerCase()} is worth a closer look`
    : "Escalation options are not open for this case yet";

  return {
    available,
    availabilityBasis,
    headline,
    disclaimer: DISCLAIMER,
    options,
  };
}
