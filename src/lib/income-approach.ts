// Deterministic, no-AI income-approach math for Module 7 (Income Value) — see
// ai-report.tsx's "income" case. Every number here is computed straight from
// figures the owner uploaded/confirmed (see income-analysis.ts); nothing is
// invented. The AI layer (MODULE_SPECS.income in the edge function) only
// *explains* these numbers — it never produces revenue, expenses, NOI, or a
// cap rate. Same discipline as comps-analysis.ts for Module 3.

export type CapRateSource = "appraisal" | "owner";

export type IncomeFigures = {
  // All annual dollars unless noted. null = the owner hasn't provided it.
  grossPotentialIncome: number | null;
  otherIncome: number | null;
  vacancyPct: number | null; // 0-100
  operatingExpenses: number | null;
  // Only set when a document states NOI directly — used to cross-check the
  // computed NOI, not to replace the ladder.
  noiStated: number | null;
  rentableSqft: number | null;
  capRatePct: number | null; // 0-100
  capRateSource: CapRateSource | null;
  // Which source documents backed these figures — drives the confidence bump
  // and the Data Availability panel. Kinds: "P&L", "Rent Roll",
  // "Operating Statement", "Appraisal".
  documentKinds: string[];
};

export type IncomeReliability = "High" | "Moderate" | "Low" | "Insufficient";

export type IncomeApproach = {
  gpi: number | null;
  otherIncome: number;
  vacancyPct: number | null;
  vacancyLoss: number | null;
  egi: number | null;
  operatingExpenses: number | null;
  opexRatioPct: number | null;
  noi: number | null;
  // The NOI the ladder produced, before falling back to a stated figure —
  // kept separate so the UI can show "stated NOI $X vs computed $Y".
  noiComputed: number | null;
  noiStated: number | null;
  noiMatchesStated: boolean | null;
  capRatePct: number | null;
  capRateSource: CapRateSource | null;
  indicatedValue: number | null;
  cadValue: number | null;
  gapVsCad: number | null; // cadValue - indicatedValue (positive => CAD is higher)
  gapPct: number | null; // gapVsCad / cadValue * 100
  // gpi + vacancy + opex all present — enough to build the NOI ladder.
  dataComplete: boolean;
  hasCapRate: boolean;
  // dataComplete AND a usable cap rate — the module can state an indicated value.
  complete: boolean;
  confidencePct: number;
  reliability: IncomeReliability;
};

const n = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export function computeIncomeApproach(f: IncomeFigures, cadValue: number | null): IncomeApproach {
  const gpi = n(f.grossPotentialIncome);
  const otherIncome = n(f.otherIncome) ?? 0;
  const vacancyPct = n(f.vacancyPct);
  const operatingExpenses = n(f.operatingExpenses);
  const noiStated = n(f.noiStated);
  const capRatePct = n(f.capRatePct);

  const vacancyLoss =
    gpi != null && vacancyPct != null ? Math.round((gpi * vacancyPct) / 100) : null;
  const egi = gpi != null && vacancyLoss != null ? gpi - vacancyLoss + otherIncome : null;
  const noiComputed = egi != null && operatingExpenses != null ? egi - operatingExpenses : null;
  const noi = noiComputed ?? noiStated;
  const opexRatioPct =
    egi != null && egi > 0 && operatingExpenses != null
      ? Math.round((operatingExpenses / egi) * 1000) / 10
      : null;

  const noiMatchesStated =
    noiComputed != null && noiStated != null && noiStated > 0
      ? Math.abs(noiComputed - noiStated) / noiStated <= 0.05
      : null;

  const hasCapRate = capRatePct != null && capRatePct > 0;
  const indicatedValue = noi != null && hasCapRate ? Math.round(noi / (capRatePct! / 100)) : null;

  const cad = n(cadValue);
  const gapVsCad = cad != null && indicatedValue != null ? cad - indicatedValue : null;
  const gapPct =
    gapVsCad != null && cad != null && cad > 0 ? Math.round((gapVsCad / cad) * 1000) / 10 : null;

  const dataComplete = gpi != null && vacancyPct != null && operatingExpenses != null;
  const complete = dataComplete && hasCapRate && noi != null;

  let confidencePct = 0;
  if (complete) {
    confidencePct = 40;
    const kinds = new Set(f.documentKinds.map((k) => k.toLowerCase()));
    if (kinds.has("p&l") || kinds.has("operating statement")) confidencePct += 20;
    if (kinds.has("rent roll")) confidencePct += 15;
    if (f.capRateSource === "appraisal") confidencePct += 15;
    if (noiMatchesStated === true) confidencePct += 10;
    confidencePct = Math.min(95, confidencePct);
  }

  const reliability: IncomeReliability = !complete
    ? "Insufficient"
    : confidencePct >= 70
      ? "High"
      : confidencePct >= 50
        ? "Moderate"
        : "Low";

  return {
    gpi,
    otherIncome,
    vacancyPct,
    vacancyLoss,
    egi,
    operatingExpenses,
    opexRatioPct,
    noi,
    noiComputed,
    noiStated,
    noiMatchesStated,
    capRatePct,
    capRateSource: f.capRateSource,
    indicatedValue,
    cadValue: cad,
    gapVsCad,
    gapPct,
    dataComplete,
    hasCapRate,
    complete,
    confidencePct,
    reliability,
  };
}

// Plain-language "does the income support the CAD value" read, from the
// deterministic gap alone — used as the fallback before the AI narrative
// resolves, and for the compact card. A gap within ±5% is "supports".
export function incomeSupportsCad(
  a: Pick<IncomeApproach, "complete" | "indicatedValue" | "gapPct">,
): "supports" | "does-not-support" | "inconclusive" {
  if (!a.complete || a.indicatedValue == null || a.gapPct == null) return "inconclusive";
  if (a.gapPct > 5) return "does-not-support"; // CAD materially higher than income indicates
  return "supports";
}
