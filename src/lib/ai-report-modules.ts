import { invokeEdgeFunction } from "./edge-functions";

export type ModuleAnalysisInput = {
  address?: string;
  cad?: string;
  propertyType?: string;
  landValue?: number;
  improvementValue?: number;
  totalValue?: number;
  taxYear?: number;
  // Only read by the "improvement" module — property photos/documents (as base64
  // data URLs) that ground its guidance in what's actually visible/stated instead of
  // only general guidance. See src/routes/ai-report.tsx.
  evidenceImages?: { mimeType: string; dataUrl: string }[];
  // Real signals threaded into the Strategy module's prompt (never fabricated —
  // each is the same real value another part of the app already computes). See
  // buildRecord() in supabase/functions/ai-report-modules/index.ts.
  compsSummary?: { median: number; min: number; max: number; count: number } | null;
  assessmentRatio?: { medianPct: number; cod: number; codOverCeiling: number } | null;
  valueTrend?: { jumpTriggered: boolean; jumpPct: number | null } | null;
  // "health" only — the real year-by-year CAD value history, so Module 1's
  // score can speak to actual historical trends rather than reporting them
  // missing. See loadModule()'s health branch in ai-report.tsx.
  valueHistory?: { year: number; total: number }[];
  evidenceFileNames?: string[];
  // "health" only — property detail the app really has (CAD record / AI-fetched
  // base data), so Module 1 stops reporting these as missing. Omitted when the
  // source didn't provide it; lastTransferDate is a deed date, never a price.
  legalDescription?: string | null;
  subdivision?: string | null;
  buildingSqft?: number | null;
  yearBuilt?: number | null;
  buildingClass?: string | null;
  lotSizeAcres?: number | null;
  lastTransferDate?: string | null;
  // Module 8 (evidence) only — what the app can already verify before asking
  // the user for anything. evidenceOnFile: the protest-evidence documents
  // actually uploaded (+ their analyze-document read). authoritativeFacts:
  // real one-liners the app itself computes (CAD record, value history,
  // zoning, site GIS, income, comps) — never fabricated. selectedStrategy:
  // the top strategy name, so Critical is judged against what that argument
  // truly needs. See loadModule()'s evidence branch in ai-report.tsx.
  evidenceOnFile?: {
    name: string;
    category: string | null;
    aiNotes: string | null;
    verdict: string | null;
  }[];
  authoritativeFacts?: string[];
  selectedStrategy?: string | null;
  // Module 2's own per-strategy scores, sent when loading comps/site/improvement/
  // zoning so their guidance stays consistent with — and prioritized by — the
  // Strategy module's ranking. See loadModule()'s sequencing in ai-report.tsx.
  priorityContext?: { strategy: string; score: number }[];
  // Only for "comps" — every ranked comp computeComparableStats() produced
  // client-side (see comps-analysis.ts), each with a stable `key`, so the
  // module can recommend the strongest 3-5 (recommendedKeys) and give a
  // per-comp use/exclude verdict. `excluded` marks a comp the user already
  // dropped; `userAdded` a comp they entered by hand or from an uploaded
  // sale document. See loadModule()'s comps branch.
  topComps?: {
    key: string;
    address: string;
    distanceMi: number;
    marketValue: number | null;
    similarity: number;
    excluded?: boolean;
    userAdded?: boolean;
    saleVerified?: boolean;
    // Deterministic reliability flags (Stale / Distant / Size mismatch /
    // Type mismatch / Unverified price / Not a market sale) — see
    // compFlags in comps-analysis.ts.
    flags?: string[];
  }[];
  compsSubjectValue?: number | null;
  // The subject's own year-over-year assessed-value trend as a whole-number
  // % — context for the comps module's recency / time-adjustment reasoning.
  subjectTrendPctPerYear?: number | null;
  // Only for "zoning" (Module 6) — the real CAD classification / zoning
  // string / legal description this app actually has, plus the comps'
  // classifications and the file names of any zoning docs the user
  // uploaded. enforceZoningRealData in the edge function gates each of the
  // four aspects on whether real data for it is present here. See
  // loadModule()'s zoning branch in ai-report.tsx.
  zoningData?: {
    cadClassification: string | null;
    cadZoning: string | null;
    legalDescription: string | null;
    subdivision: string | null;
    comps: { classification: string | null; zoning: string | null }[];
    uploadedDocs: string[];
  };
  // Only for "income" (Module 7) — the owner-confirmed income figures and the
  // deterministically-computed EGI/NOI/indicated value from
  // src/lib/income-approach.ts. The AI layer only *explains* these; it never
  // produces a revenue, expense, NOI, or cap-rate number. enforceIncomeRealData
  // in the edge function forces an "inconclusive" verdict when figures or a
  // cap rate are missing. See loadModule()'s income branch in ai-report.tsx.
  incomeFigures?: {
    grossPotentialIncome: number | null;
    otherIncome: number | null;
    vacancyPct: number | null;
    operatingExpenses: number | null;
    egiComputed: number | null;
    noiComputed: number | null;
    opexRatioPct: number | null;
    rentableSqft: number | null;
    documentKinds: string[];
  };
  capRate?: { pct: number | null; source: "appraisal" | "owner" | null };
  incomeIndicatedValue?: number | null;
  cadValue?: number | null;
  compsIndicatedRange?: { min: number; median: number; max: number } | null;
  // Only for "executive" — Module 7's real income indication, when the owner
  // completed it, as a second valuation view alongside compsIndicated.
  incomeIndicated?: {
    indicatedValue: number | null;
    gapPct: number | null;
    supports: string;
    confidencePct: number;
  } | null;
  // Everything below is only for "executive" — real outputs Modules 2/3/8/9
  // already computed (never regenerated), so Module 10 can actually
  // reconcile them instead of writing a recommendation blind to the rest of
  // the report. See loadModule()'s executive branch in ai-report.tsx and the
  // sequencing effect that waits for strategy + evidence to resolve first.
  topStrategies?: {
    name: string;
    primaryReason: string;
    strengthScore: number;
    whySelected: string;
    existingEvidence: string[];
    missingEvidence: string[];
  }[];
  evidenceReadiness?: {
    criticalMissing: string[];
    importantMissing: string[];
    uploadedCount: number;
  };
  compsIndicated?: {
    min: number;
    median: number;
    max: number;
    gapPct: number | null;
    confidencePct: number | null;
  } | null;
  financialSummary?: {
    savings: number;
    basis: "comps" | "formula";
    reductionPct: number | null;
    // Module 9's fuller financial-opportunity result (all deterministic —
    // see src/lib/savings-analysis.ts). Optional so a stale caller still
    // type-checks; the executive prompt weighs these when present.
    annualSavings?: number;
    netBenefit?: number;
    protestCost?: number;
    protestCostSource?: "contingency" | "override" | "none";
    savingsToCostMultiple?: number | null;
    roiPct?: number | null;
    indicatedRange?: { low: number; high: number } | null;
    financialConfidence?: "High" | "Moderate" | "Limited";
    topScenarioReductionPct?: number;
  } | null;
  // Only present once a real protest case exists for this property (see
  // getPreFilingCheck() in pre-filing-check.ts) — omitted, not fabricated,
  // when no case has been started yet.
  preFilingStatus?: { missingBlocking: string[] } | null;
  // Only for "site" — real point data from site-gis.ts's getSiteGis() (FEMA
  // flood zone + USGS elevation + OSM highway/rail proximity) for the
  // property's real lat/lng, when one exists. Absent entirely, not just
  // null fields, whenever no real lat/lng exists for this property/county
  // (most counties today) — see loadSiteGis() in ai-report.tsx.
  siteGis?: {
    floodZone: { zone: string; label: string; inSFHA: boolean } | null;
    elevationFt: number | null;
    nearestHighwayMi: number | null;
    nearestRailMi: number | null;
  } | null;
  // Only for "improvement" — the real typical economic-life range for this
  // property's type (improvement-condition.ts's getTypicalEconomicLife()),
  // always sent (unlike evidenceImages, not gated on anything real existing
  // yet) so the AI's effective-age estimate is grounded in an honest
  // industry-general figure rather than an unmoored guess.
  economicLifeYears?: { min: number; max: number; typical: number } | null;
  // Real, user-confirmed exclusions — see module-overrides.ts and
  // "Not Applicable"/notApplicable handling in ai-report.tsx. notApplicableFactors
  // (site) and notApplicableComponents (improvement) hard-clamp that specific
  // factor/component server-side, same discipline as enforceSiteFactorRealData/
  // enforceBuildingComponentRealData; notApplicableContext (strategy/evidence/
  // executive) is prose context only — it steers the AI's reasoning but isn't
  // hard-enforced, since those modules' missing-evidence lists are free text.
  notApplicableFactors?: string[];
  notApplicableComponents?: string[];
  notApplicableContext?: string[];
};

export type BatchModuleId =
  "strategy" | "comps" | "site" | "improvement" | "zoning" | "income" | "evidence" | "executive";

// One ranked valuation strategy from Module 2 — see StrategyList/StrategyDetail in
// src/routes/ai-report.tsx and the "strategy" MODULE_SPEC in the edge function.
export type StrategyEntry = {
  name: string;
  strengthScore: number;
  primaryReason: string;
  whySelected: string;
  supportingFindings: string;
  valuationRelevance: string;
  existingEvidence: string[];
  missingEvidence: string[];
  confidencePct: number;
  recommendedInvestigation: string;
  // The batch-module id (comps/site/improvement/income/zoning) this strategy maps
  // to, when it's one of the 5 fixed named strategies — empty for an "Other: ..."
  // entry, which doesn't correspond to any of Modules 3-7.
  relatedModules: string[];
  dataSufficient: boolean;
};

export type ModuleResultMap = {
  strategy: {
    strategies: StrategyEntry[];
    topStrategySummary: string;
  };
  comps: {
    guidance: string;
    checklist: string[];
    recommendedUse: string;
    // The strongest 3-5 comp keys (a subset of the keys sent in
    // topComps), a per-comp use/exclude verdict + one-line reason, and how
    // to use the comp set in the protest. Keys are clamped server-side to
    // the set actually sent — the model can't introduce a comp.
    recommendedKeys: string[];
    // flags: reliability concerns the deterministic check can't see
    // (portfolio sale, related parties, atypical financing). Merged with the
    // deterministic compFlags in the UI. Never invented.
    perComp: { key: string; verdict: "use" | "exclude"; reason: string; flags?: string[] }[];
    protestRecommendation: string;
  };
  // Real 16-factor structured assessment — see MODULE_SPECS.site and
  // enforceSiteFactorRealData in the edge function. Only "Floodplain",
  // "Grade", "Highway Proximity", and "Railroad Proximity" can ever read
  // "Confirmed"/"Partial Data"; every other factor is server-enforced to
  // "Additional Data Needed" until a real source exists for it, or "Not
  // Applicable" once the user has explicitly confirmed no such document
  // exists (see module-overrides.ts) — never trust status alone without
  // that context.
  site: {
    guidance: string;
    factors: {
      factor:
        | "Floodplain"
        | "Easements"
        | "Drainage"
        | "Sewer"
        | "Water Availability"
        | "Buildability"
        | "Ponds"
        | "Streams"
        | "Road Frontage"
        | "Visibility"
        | "Traffic Counts / VPD"
        | "Grade"
        | "Topography"
        | "Access Limitations"
        | "Highway Proximity"
        | "Railroad Proximity";
      status: "Confirmed" | "Partial Data" | "Additional Data Needed" | "Not Applicable";
      finding: string;
      severity: "High" | "Moderate" | "Low" | "Unknown";
      confidence: "High" | "Moderate" | "Low";
      potentialImpact: string;
      evidenceNeeded: string | null;
    }[];
    keyFinding: string;
    priorityScore: number;
  };
  // Real 4-component structured assessment — see MODULE_SPECS.improvement and
  // enforceBuildingComponentRealData in the edge function. hasPhoto/
  // condition are server-enforced: when zero evidence images were sent at
  // all, every component reads hasPhoto:false/condition:"Unknown" no
  // matter what the AI returned. notApplicable is also server-enforced —
  // true only when the user explicitly confirmed no photo exists for that
  // component (see module-overrides.ts) AND no real photo evidence for it
  // came back from the AI (real data always wins over a stale override).
  // effectiveAgeYears/functionalObsolescencePct/externalObsolescencePct are
  // null whenever the AI had no real basis for them — see
  // src/lib/improvement-condition.ts's computeDepreciation() for the real,
  // deterministic math built from these.
  improvement: {
    guidance: string;
    buildingComponents: {
      component: "Roof" | "HVAC" | "Exterior" | "Interior";
      hasPhoto: boolean;
      notApplicable: boolean;
      condition: "Good" | "Fair" | "Poor" | "Unknown";
      actionNeeded: string | null;
      notes: string;
    }[];
    effectiveAgeYears: number | null;
    effectiveAgeBasis: string;
    functionalObsolescencePct: number | null;
    functionalObsolescenceBasis: string;
    externalObsolescencePct: number | null;
    externalObsolescenceBasis: string;
    keyFinding: string;
    priorityScore: number;
  };
  // Module 6 — the property's CAD Classification / Actual Use / Zoning
  // District / Permitted Use lined up, with discrepancies kept SEPARATE from
  // valuation relevance kept separate from the evidence that would
  // substantiate either. Each aspect's status is server-enforced against the
  // real data in ModuleAnalysisInput.zoningData (see enforceZoningRealData)
  // — a mismatch the app can't actually see is never asserted.
  zoning: {
    matches: "consistent" | "inconsistent" | "uncertain";
    assessment: string;
    category:
      | "Office"
      | "Retail"
      | "Neighborhood Services"
      | "Commercial"
      | "Agricultural"
      | "Rural"
      | "Non-profit"
      | "Other";
    aspects: {
      label: "CAD Classification" | "Actual Use" | "Zoning District" | "Permitted Use";
      value: string;
      status: "Confirmed" | "Partial Data" | "Additional Data Needed";
      source: string;
    }[];
    discrepancies: {
      between: string;
      detail: string;
      confidence: "High" | "Moderate" | "Low";
    }[];
    valuationRelevance: string;
    possibleExemptions: string[];
    evidenceRequired: string[];
    restrictions: string;
    comparableClassifications: string;
    // Kept for backward-compat with the compact card's "Stated → Typical"
    // flow; the AI still returns it.
    typicalClassification: string;
  };
  // Module 7 — the AI *narrative* layer over the income approach. Every
  // dollar figure and the cap rate are computed deterministically in
  // src/lib/income-approach.ts from owner-confirmed data; this only
  // explains them. supportsCadValue is forced to "inconclusive"
  // server-side (enforceIncomeRealData) whenever the figures or a cap rate
  // are missing — the module never fills the gap with a typical number.
  income: {
    assessment: string;
    supportsCadValue: "supports" | "does-not-support" | "inconclusive";
    cadComparisonNarrative: string;
    vacancyBasis: string;
    opexBasis: string;
    capRateBasis: string;
    assumptions: string[];
    sources: string[];
    confidenceNote: string;
    missingInformation: string[];
    lineItemNotes: { line: string; note: string }[];
  };
  evidence: {
    items: {
      item: string;
      // priority is the real driver now — only "Critical" items block the
      // user; Important/Supporting/Optional are shown as ways to strengthen
      // the case. importance/availability are kept, DERIVED from
      // priority/status, so the quadrant card + executive readiness keep
      // working while callers migrate. See MODULE_SPECS.evidence.
      priority: "Critical" | "Important" | "Supporting" | "Optional";
      // Verified: a document on file or an authoritative record (CAD, value
      // history, GIS) directly satisfies this. Found: a document plausibly
      // matches but isn't confirmed. Missing: nothing on file.
      status: "Verified" | "Found" | "Missing";
      // Where it was found — "CAD record", "USGS + FEMA", an exact filename,
      // or null when Missing.
      foundIn: string | null;
      // One plain sentence: what this item actually proves for the case.
      whyNeeded: string;
      // Why it's Verified, or exactly what's still unconfirmed.
      verificationNote: string;
      importance: "High" | "Low";
      availability: "High" | "Low";
      // Real, concrete suggestions for what to upload to satisfy this
      // checklist item — see MODULE_SPECS.evidence in the edge function.
      // whereToObtain is always a general source TYPE (the CAD, a
      // surveyor, a licensed appraiser, etc.), never a specific vendor/
      // URL the AI can't actually verify.
      documentSuggestions: { documentName: string; whatToInclude: string; whereToObtain: string }[];
    }[];
  };
  // Recommendation/basis/nextStep kept for backward compatibility with any
  // stale cached shape — the real UI (ai-report.tsx's "executive" cases)
  // reads the richer fields below now. See MODULE_SPECS.executive in
  // supabase/functions/ai-report-modules/index.ts for the full schema this
  // mirrors.
  executive: {
    recommendedAction:
      | "Proceed with Protest"
      | "Proceed with Protest After Completing Recommended Evidence"
      | "Additional Information Needed Before Proceeding"
      | "Limited Protest Opportunity Based on Available Information";
    recommendationExplanation: string;
    primaryStrategyExplanation: string | null;
    secondaryStrategyExplanation: string | null;
    majorFindings: { finding: string; whyItMatters: string; relatedModule: string | null }[];
    missingInformation: { item: string; severity: "Critical" | "Important" | "Supporting" }[];
    recommendedProtestValue: number | null;
    recommendedProtestValueBasis: string;
    nextAction: string;
    // Only populated when the AI genuinely notices the fed-in signals
    // disagree (e.g. a strong strategy score against missing critical
    // evidence) — per the instruction to flag conflicts, not silently pick
    // a side. Absent, never fabricated, when nothing actually conflicts.
    conflictNote: string | null;
    defenseQA: {
      question: string;
      suggestedAnswer: string;
      status: "Supported" | "Partially Supported" | "Evidence Needed" | "User Input Needed";
      relatedModule: string | null;
    }[];
  };
};

// Fetches exactly one module's analysis per call — the caller only invokes this when
// the user unlocks that specific module, so a Gemini call only happens for modules
// the user actually opens, not all eight up front.
export async function getModuleAnalysis<K extends BatchModuleId>(
  moduleId: K,
  input: ModuleAnalysisInput,
): Promise<ModuleResultMap[K]> {
  return invokeEdgeFunction<ModuleResultMap[K]>("ai-report-modules", { moduleId, ...input });
}

// Powers each module's "Ask AI" box — a single grounded follow-up question, answered
// from the same record plus whatever that module has already generated (priorData).
// Ephemeral by design: the answer is only ever held in the calling component's own
// state, never persisted, so it resets when the modal closes.
export type ModuleQAEvidenceContext = {
  linkedDocs: { name: string; notes: string | null }[];
  strategyRationale: string | null;
};

export async function askModuleQuestion(
  moduleId: string,
  question: string,
  input: ModuleAnalysisInput,
  priorModuleData?: unknown,
  // The central documents tagged to this module + the selected strategy's
  // rationale — lets the answer cite the evidence that backs a finding and
  // name what's still missing (see src/lib/document-modules.ts).
  evidenceContext?: ModuleQAEvidenceContext,
): Promise<string> {
  const result = await invokeEdgeFunction<{ answer: string }>("ai-report-modules", {
    moduleId,
    question,
    priorModuleData,
    evidenceContext,
    ...input,
  });
  return result.answer;
}
