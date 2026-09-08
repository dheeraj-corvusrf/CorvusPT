// Deploy via CLI: `supabase functions deploy ai-report-modules`.
// Requires the GEMINI_API_KEY secret (shared with the other AI functions).
//
// Covers modules 2, 3, 4, 5, 6, 8, 9, 10 (module 1 — health score — is its own
// function, ai-health-score; module 7 — income approach — genuinely needs a
// user-uploaded P&L/rent roll and stays a static gate in the client, not an AI
// call, unless the user marks it Not Applicable — see module-overrides.ts).
//
// One Gemini call per invocation covers exactly ONE module (selected via the
// `moduleId` field) rather than all eight at once — the client only calls this when
// the user clicks "Unlock preview" on that specific module, so tokens are only spent
// on modules the user actually opens.
//
// Also handles a second request shape — `question` set — used by the per-module
// Q&A box (see askModuleQuestion() in src/lib/ai-report-modules.ts): one grounded
// answer to a free-text follow-up about a module, reusing the same record-building
// and Gemini-call plumbing rather than a separate function.
//
// No Supabase auth check — same known-risk pattern already accepted for the other
// guest-accessible AI functions.
import { PROSE_STYLE } from "../_shared/prose-style.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

type ModulesInput = {
  moduleId?: string;
  address?: string;
  cad?: string;
  propertyType?: string;
  landValue?: number;
  improvementValue?: number;
  totalValue?: number;
  taxYear?: number;
  // Only read for moduleId "improvement" — property photos/documents as base64 data
  // URLs, already fetched client-side from a signed URL only the owning user could
  // obtain (same trust boundary as classify-document, which also accepts arbitrary
  // uploaded file bytes with no auth check).
  evidenceImages?: { mimeType?: string; dataUrl?: string }[];
  // Real signals computed client-side and passed through verbatim into the prompt
  // record — see buildRecord() below. None of this is fabricated server-side; it's
  // the same real comps/ratio-study/value-trend data other parts of the app already
  // compute (cad-comps.ts, texas-tax-rates.ts), just also handed to the Strategy
  // module (and, via priorityContext, to modules 3-7) so its reasoning is grounded
  // in more than the bare CAD record.
  compsSummary?: { median: number; min: number; max: number; count: number } | null;
  assessmentRatio?: { medianPct: number; cod: number; codOverCeiling: number } | null;
  valueTrend?: { jumpTriggered: boolean; jumpPct: number | null } | null;
  evidenceFileNames?: string[];
  // Module 2's own per-strategy scores, sent when calling comps/site/improvement/
  // zoning so their guidance stays consistent with — and prioritized by — the
  // Strategy module's ranking. See loadModule()'s sequencing in ai-report.tsx.
  priorityContext?: { strategy: string; score: number }[];
  // Only for moduleId "comps" — the real top-5-by-similarity comps
  // computeComparableStats() already ranked client-side (see
  // comps-analysis.ts), so recommendedUse below can name specific real
  // properties instead of speaking only in generalities. Every field here
  // is a real CAD-record value; nothing invented server-side.
  topComps?: {
    key: string;
    address: string;
    distanceMi: number;
    marketValue: number | null;
    similarity: number;
    excluded?: boolean;
    userAdded?: boolean;
    saleVerified?: boolean;
  }[];
  compsSubjectValue?: number | null;
  // Only for moduleId "executive" — real outputs Modules 2/3/8/9 already
  // computed client-side (never regenerated here), so the executive module
  // can actually reconcile them. See loadModule()'s executive branch and its
  // sequencing effect (waits for strategy + evidence to resolve) in
  // ai-report.tsx.
  topStrategies?: {
    name: string;
    primaryReason?: string;
    strengthScore: number;
    whySelected?: string;
    existingEvidence?: string[];
    missingEvidence?: string[];
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
    // Module 9's fuller deterministic financial-opportunity result — the
    // executive module weighs the net benefit / confidence, not just the
    // gross savings. All optional so a stale caller still parses.
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
  preFilingStatus?: { missingBlocking: string[] } | null;
  // Only for moduleId "site" — real point data the site-gis edge function
  // already fetched (FEMA NFHL flood zone + USGS elevation) for the
  // subject's real lat/lng, when one exists (see loadSiteGis() in
  // ai-report.tsx). Absent entirely — not just null fields — whenever no
  // real lat/lng exists for this property/county; never guessed. The
  // handler re-clamps every site factor's status against this exact field
  // after parsing (see enforceSiteFactorRealData below), so even if the AI
  // ignored the instruction and claimed a real finding anyway, the response
  // sent to the client can't say "Confirmed" without this being populated.
  siteGis?: {
    floodZone: { zone: string; label: string; inSFHA: boolean } | null;
    elevationFt: number | null;
    nearestHighwayMi: number | null;
    nearestRailMi: number | null;
  } | null;
  // Only for moduleId "improvement" — the real typical economic-life range
  // for this property's type (src/lib/improvement-condition.ts,
  // getTypicalEconomicLife()), grounding the AI's effective-age estimate in
  // an honest industry-general figure rather than an unmoored guess. Not
  // gated on anything (unlike evidenceImages) — always sent for this
  // module.
  economicLifeYears?: { min: number; max: number; typical: number } | null;
  // Only for moduleId "zoning" (Module 6) — the real CAD classification /
  // zoning string / legal description this app has, the comps'
  // classifications, and the file names of any zoning docs the user
  // uploaded. enforceZoningRealData gates each of the four aspects on
  // whether real data for it is present here — the AI can't claim an aspect
  // is "Confirmed" without the underlying value existing.
  zoningData?: {
    cadClassification: string | null;
    cadZoning: string | null;
    legalDescription: string | null;
    subdivision: string | null;
    comps: { classification: string | null; zoning: string | null }[];
    uploadedDocs: string[];
  };
  // Only for moduleId "income" (Module 7) — the owner-confirmed income
  // figures and the deterministically-computed EGI/NOI/indicated value from
  // src/lib/income-approach.ts. The AI only *explains* these numbers; it
  // never produces a revenue, expense, NOI, or cap-rate figure.
  // enforceIncomeRealData forces an "inconclusive" verdict whenever the core
  // figures or a cap rate are missing here — the module never fills the gap
  // with a typical number.
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
  incomeIndicated?: {
    indicatedValue: number | null;
    gapPct: number | null;
    supports: string;
    confidencePct: number;
  } | null;
  // Question-mode fields (see Deno.serve below) — when `question` is set, this
  // request is a Q&A follow-up, not a module-analysis request.
  question?: string;
  priorModuleData?: unknown;
  // Real, user-confirmed exclusions (see module-overrides.ts and
  // src/lib/module-overrides.ts). notApplicableFactors/notApplicableComponents
  // hard-clamp that exact site factor / building component's status server-side
  // (enforceSiteFactorRealData / enforceBuildingComponentRealData below) —
  // never AI-decided. notApplicableContext is prose context appended to the
  // prompt for strategy/evidence/executive so their free-text reasoning and
  // missing-evidence lists stay consistent with what the user has already
  // confirmed isn't available — steering only, not hard-enforced, since those
  // fields are AI-authored text, not a fixed schema this handler can reclamp.
  notApplicableFactors?: string[];
  notApplicableComponents?: string[];
  notApplicableContext?: string[];
};

const PREAMBLE = `You are CorvusPT's AI property tax analyst for Texas commercial properties.
Given only the official CAD (county appraisal district) record below, generate the requested
report module.

Reason only from what's given plus general knowledge of Texas commercial property appraisal
practice. Do NOT invent specific comparable sale prices, specific building square footage,
specific site defects, or a specific effective age unless real grounding for it (e.g. real
attached photos, a real site-condition data point) was actually given below — that grounding
won't exist for most calls, so treat "none of that was provided" as the default. Where this
module would normally need data this record doesn't include (actual comparable sales, a site
inspection, a building condition survey), give general guidance and a checklist of what to
gather instead of fabricated specific findings.

${PROSE_STYLE}`;

// The 5 fixed valuation strategies Module 2 ranks, 1:1 with the modules that
// investigate each one (see STRATEGY_MODULE_MAP) — matches the reference design's
// named strategy list exactly. A 6th "Other: <label>" entry is allowed (validated by
// isValidStrategyName below) only for a genuinely distinct argument, never padded to
// hit a count.
const STRATEGY_NAMES = [
  "Comparable Sales",
  "Site Condition",
  "Improvement Condition",
  "Income Approach",
  "Zoning / Classification",
];

const STRATEGY_MODULE_MAP: Record<string, string> = {
  "Comparable Sales": "comps",
  "Site Condition": "site",
  "Improvement Condition": "improvement",
  "Income Approach": "income",
  "Zoning / Classification": "zoning",
};

function isValidStrategyName(name: string): boolean {
  return STRATEGY_NAMES.includes(name) || /^Other: .{1,40}$/.test(name);
}

type ModuleSpec = {
  instruction: string;
  schema: string;
  parse: (parsed: Record<string, unknown>) => unknown;
};

const checklist = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 4) : [];

// Clamps an AI-provided 0-100 score, falling back to a neutral midpoint
// (rather than 0, which would visually read as "no issue found" — the
// opposite of "the AI didn't return a usable number") when missing/invalid.
const score100 = (v: unknown, fallback = 50): number =>
  Math.max(0, Math.min(100, Math.round(Number(v)) || fallback));

// Same clamp, but null (not a fallback midpoint) when the AI didn't return
// a usable number — for fields where "unknown" must stay honestly unknown
// rather than defaulting to 50 (e.g. Module 5's obsolescence percentages,
// which feed a real depreciation calculation client-side and would silently
// corrupt it if a missing value read as "50%").
const score100OrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null;

const strList = (v: unknown, max: number, len: number): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => x.slice(0, len))
        .slice(0, max)
    : [];

const str = (v: unknown, len: number): string => (typeof v === "string" ? v.slice(0, len) : "");

const strategies = (v: unknown) =>
  Array.isArray(v)
    ? v
        .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
        .map((x) => {
          const name = str(x.name, 40);
          return {
            name,
            strengthScore: score100(x.strengthScore),
            primaryReason: str(x.primaryReason, 80),
            whySelected: str(x.whySelected, 300),
            supportingFindings: str(x.supportingFindings, 300),
            valuationRelevance: str(x.valuationRelevance, 200),
            existingEvidence: strList(x.existingEvidence, 6, 100),
            missingEvidence: strList(x.missingEvidence, 6, 100),
            confidencePct: score100(x.confidencePct),
            recommendedInvestigation: str(x.recommendedInvestigation, 200),
            relatedModules: name in STRATEGY_MODULE_MAP ? [STRATEGY_MODULE_MAP[name]] : [],
            dataSufficient: x.dataSufficient !== false,
          };
        })
        .filter((s) => s.name.length > 0 && isValidStrategyName(s.name))
        .sort((a, b) => b.strengthScore - a.strengthScore)
        .slice(0, 6)
    : [];

const evidenceDocumentSuggestions = (
  v: unknown,
): { documentName: string; whatToInclude: string; whereToObtain: string }[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
        .map((x) => ({
          documentName: str(x.documentName, 70),
          whatToInclude: str(x.whatToInclude, 160),
          whereToObtain: str(x.whereToObtain, 160),
        }))
        .filter((x) => x.documentName.length > 0)
        .slice(0, 4)
    : [];

const evidenceItems = (
  v: unknown,
): {
  item: string;
  importance: "High" | "Low";
  availability: "High" | "Low";
  documentSuggestions: { documentName: string; whatToInclude: string; whereToObtain: string }[];
}[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
        .map((x) => ({
          item: String(x.item ?? "").slice(0, 120),
          importance: x.importance === "High" ? ("High" as const) : ("Low" as const),
          availability: x.availability === "High" ? ("High" as const) : ("Low" as const),
          documentSuggestions: evidenceDocumentSuggestions(x.documentSuggestions),
        }))
        .filter((x) => x.item.length > 0)
        .slice(0, 6)
    : [];

// Module 10 (executive) parsers — real modules only, so a bad/invented
// relatedModule value from the AI can never deep-link the UI somewhere
// nonsensical.
const RELATED_MODULE_IDS = ["comps", "site", "improvement", "zoning", "income", "evidence"];
const relatedModule = (v: unknown): string | null =>
  typeof v === "string" && RELATED_MODULE_IDS.includes(v) ? v : null;

const RECOMMENDED_ACTIONS = [
  "Proceed with Protest",
  "Proceed with Protest After Completing Recommended Evidence",
  "Additional Information Needed Before Proceeding",
  "Limited Protest Opportunity Based on Available Information",
];
const isValidRecommendedAction = (v: unknown): v is string =>
  typeof v === "string" && RECOMMENDED_ACTIONS.includes(v);

const majorFindings = (
  v: unknown,
): { finding: string; whyItMatters: string; relatedModule: string | null }[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
        .map((x) => ({
          finding: str(x.finding, 100),
          whyItMatters: str(x.whyItMatters, 200),
          relatedModule: relatedModule(x.relatedModule),
        }))
        .filter((x) => x.finding.length > 0)
        .slice(0, 5)
    : [];

const missingInformation = (
  v: unknown,
): { item: string; severity: "Critical" | "Important" | "Supporting" }[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
        .map((x) => ({
          item: str(x.item, 120),
          severity:
            x.severity === "Critical" || x.severity === "Important"
              ? (x.severity as "Critical" | "Important")
              : ("Supporting" as const),
        }))
        .filter((x) => x.item.length > 0)
        .slice(0, 8)
    : [];

const DEFENSE_QA_STATUSES = [
  "Supported",
  "Partially Supported",
  "Evidence Needed",
  "User Input Needed",
];
const defenseQA = (
  v: unknown,
): {
  question: string;
  suggestedAnswer: string;
  status: "Supported" | "Partially Supported" | "Evidence Needed" | "User Input Needed";
  relatedModule: string | null;
}[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
        .map((x) => ({
          question: str(x.question, 160),
          suggestedAnswer: str(x.suggestedAnswer, 300),
          status: DEFENSE_QA_STATUSES.includes(x.status as string)
            ? (x.status as
                "Supported" | "Partially Supported" | "Evidence Needed" | "User Input Needed")
            : ("User Input Needed" as const),
          relatedModule: relatedModule(x.relatedModule),
        }))
        .filter((x) => x.question.length > 0 && x.suggestedAnswer.length > 0)
        .slice(0, 6)
    : [];

// Module 4 (site) — the 16 factors from the spec, in a fixed order. Enforced
// as an allow-list (not left to the AI to name/omit/invent categories) so
// the UI's table always has exactly 16 rows in a stable order. Highway
// Proximity/Railroad Proximity are the two newest factors — real distances
// from site-gis's OSM Overpass lookup, same real-data discipline as
// Floodplain/Grade (see enforceSiteFactorRealData below).
const SITE_FACTORS = [
  "Floodplain",
  "Easements",
  "Drainage",
  "Sewer",
  "Water Availability",
  "Buildability",
  "Ponds",
  "Streams",
  "Road Frontage",
  "Visibility",
  "Traffic Counts / VPD",
  "Grade",
  "Topography",
  "Access Limitations",
  "Highway Proximity",
  "Railroad Proximity",
] as const;
type SiteFactorName = (typeof SITE_FACTORS)[number];
type SiteFactorStatus = "Confirmed" | "Partial Data" | "Additional Data Needed" | "Not Applicable";
type SiteFactorSeverity = "High" | "Moderate" | "Low" | "Unknown";
type SiteFactorConfidence = "High" | "Moderate" | "Low";
type SiteFactor = {
  factor: SiteFactorName;
  status: SiteFactorStatus;
  finding: string;
  severity: SiteFactorSeverity;
  confidence: SiteFactorConfidence;
  potentialImpact: string;
  evidenceNeeded: string | null;
};
const SITE_FACTOR_STATUSES: SiteFactorStatus[] = [
  "Confirmed",
  "Partial Data",
  "Additional Data Needed",
];
const SITE_FACTOR_SEVERITIES: SiteFactorSeverity[] = ["High", "Moderate", "Low", "Unknown"];
const SITE_FACTOR_CONFIDENCES: SiteFactorConfidence[] = ["High", "Moderate", "Low"];

// First pass — validates the AI's raw factor array into exactly 16 typed
// entries (one per SITE_FACTORS name, in order), defaulting anything
// missing/malformed to a safe "Additional Data Needed" row. Does NOT yet
// know about real siteGis data — see enforceSiteFactorRealData below, which
// runs after this in the request handler (spec.parse only receives the AI's
// own JSON, not the original request input, matching every other module).
function siteFactors(v: unknown): SiteFactor[] {
  const byName = new Map<string, Record<string, unknown>>();
  if (Array.isArray(v)) {
    for (const x of v) {
      if (
        typeof x === "object" &&
        x !== null &&
        typeof (x as Record<string, unknown>).factor === "string"
      ) {
        byName.set((x as Record<string, unknown>).factor as string, x as Record<string, unknown>);
      }
    }
  }
  return SITE_FACTORS.map((factor) => {
    const x = byName.get(factor) ?? {};
    const status = SITE_FACTOR_STATUSES.includes(x.status as SiteFactorStatus)
      ? (x.status as SiteFactorStatus)
      : "Additional Data Needed";
    return {
      factor,
      status,
      finding:
        str(x.finding, 90) ||
        (status === "Additional Data Needed" ? "Additional data needed to assess." : ""),
      severity: SITE_FACTOR_SEVERITIES.includes(x.severity as SiteFactorSeverity)
        ? (x.severity as SiteFactorSeverity)
        : "Unknown",
      confidence: SITE_FACTOR_CONFIDENCES.includes(x.confidence as SiteFactorConfidence)
        ? (x.confidence as SiteFactorConfidence)
        : "Moderate",
      potentialImpact: str(x.potentialImpact, 70),
      evidenceNeeded: str(x.evidenceNeeded, 90) || null,
    };
  });
}

// Second pass — the real enforcement. Runs in the request handler (has
// access to the original input.siteGis, unlike spec.parse). Floodplain can
// only read "Confirmed" when a real FEMA zone was actually fetched for this
// property; Grade can only read "Partial Data" (never "Confirmed" — a
// single elevation point is not a contour survey) when a real USGS
// elevation was fetched; Highway Proximity/Railroad Proximity can only read
// "Confirmed" when a real OSM-measured distance came back (site-gis's
// Overpass lookup is a real but best-effort/sometimes-slow free API — see
// its own comments — so this is null more often than the FEMA/USGS fields
// are); every other factor is hard-clamped to "Additional Data Needed" with
// "Low" confidence no matter what the AI returned — this app has no real
// source for any of them yet, and the AI's own discipline alone isn't
// trusted to guarantee that. notApplicable is a real, user-confirmed
// exclusion (see module-overrides.ts) — checked LAST so it can never
// suppress an actual real finding: a factor with a genuine real-data source
// above still wins even if it's also (stale-)listed here.
function enforceSiteFactorRealData(
  factors: SiteFactor[],
  siteGis: ModulesInput["siteGis"],
  notApplicable: string[],
): SiteFactor[] {
  return factors.map((f) => {
    if (f.factor === "Floodplain") {
      if (siteGis?.floodZone) return { ...f, status: "Confirmed" };
    } else if (f.factor === "Grade") {
      if (siteGis?.elevationFt != null) return { ...f, status: "Partial Data" };
    } else if (f.factor === "Highway Proximity") {
      if (siteGis?.nearestHighwayMi != null) return { ...f, status: "Confirmed" };
    } else if (f.factor === "Railroad Proximity") {
      if (siteGis?.nearestRailMi != null) return { ...f, status: "Confirmed" };
    }
    if (notApplicable.includes(f.factor)) {
      return {
        ...f,
        status: "Not Applicable",
        finding: "Marked not applicable — user confirmed no document is available for this factor.",
        evidenceNeeded: null,
      };
    }
    return { ...f, status: "Additional Data Needed", confidence: "Low" };
  });
}

// Module 6 (zoning) — the same honest-data enforcement as Module 4. The app
// only really has the CAD classification (property type) and, for the
// TrueProdigy/BIS counties, a zoning string; it can't observe actual use or
// read a zoning ordinance. So:
//   - CAD Classification -> "Confirmed" only if the real value exists.
//   - Zoning District -> "Confirmed" only if a real zoning string exists.
//   - Actual Use / Permitted Use -> never better than "Partial Data", and
//     only that when the user uploaded a doc for it; else "Additional Data
//     Needed".
// If nothing real is present for any aspect, the module must not assert a
// mismatch it can't see: force matches -> "uncertain", clear discrepancies,
// and replace valuationRelevance with an honest "not enough data" line.
type ZoningResult = {
  matches: "consistent" | "inconsistent" | "uncertain";
  aspects: {
    label: "CAD Classification" | "Actual Use" | "Zoning District" | "Permitted Use";
    value: string;
    status: "Confirmed" | "Partial Data" | "Additional Data Needed";
    source: string;
  }[];
  discrepancies: unknown[];
  valuationRelevance: string;
};

function enforceZoningRealData(
  result: ZoningResult,
  zoningData: ModulesInput["zoningData"],
): ZoningResult {
  const hasClass = !!zoningData?.cadClassification?.trim();
  const hasZoning = !!zoningData?.cadZoning?.trim();
  const docs = (zoningData?.uploadedDocs ?? []).join(" ").toLowerCase();
  const uploadedFor = (label: string) => {
    if (docs.length === 0) return false;
    if (label === "Actual Use") return /use|lease|photo|occup/.test(docs);
    if (label === "Permitted Use") return /zon|ordinance|permit|land.?use/.test(docs);
    return true;
  };

  const aspects = result.aspects.map((a) => {
    if (a.label === "CAD Classification") {
      return hasClass
        ? { ...a, status: "Confirmed" as const, value: zoningData!.cadClassification!.trim() }
        : { ...a, status: "Additional Data Needed" as const, source: "Upload your CAD notice" };
    }
    if (a.label === "Zoning District") {
      return hasZoning
        ? { ...a, status: "Confirmed" as const, value: zoningData!.cadZoning!.trim() }
        : {
            ...a,
            status: "Additional Data Needed" as const,
            source: "Upload a zoning letter or GIS map",
          };
    }
    // Actual Use / Permitted Use
    if (uploadedFor(a.label)) {
      return { ...a, status: a.status === "Confirmed" ? ("Partial Data" as const) : a.status };
    }
    return {
      ...a,
      status: "Additional Data Needed" as const,
      source:
        a.label === "Actual Use"
          ? "Upload photos, a lease, or use records"
          : "Upload zoning / land-use documents",
    };
  });

  const anyReal = aspects.some((a) => a.status !== "Additional Data Needed");
  if (!anyReal) {
    return {
      ...result,
      aspects,
      matches: "uncertain",
      discrepancies: [],
      valuationRelevance:
        "Not enough classification, zoning, or use data on file yet to judge whether there is a discrepancy or any valuation impact.",
    };
  }
  return { ...result, aspects };
}

// Module 7 (income) — honest-data enforcement, same discipline as Modules
// 4/5/6. Every dollar figure and the cap rate are computed client-side from
// owner-confirmed data (src/lib/income-approach.ts). If the core figures or a
// usable cap rate aren't present in the request, the module must not state a
// verdict it can't support: force "inconclusive", replace the comparison /
// cap-rate narrative with an honest "no data yet" line, and make
// missingInformation the concrete upload list. Also: the verdict can never be
// non-inconclusive when there is no computed indicated value to compare.
type IncomeResult = {
  supportsCadValue: "supports" | "does-not-support" | "inconclusive";
  cadComparisonNarrative: string;
  capRateBasis: string;
  missingInformation: string[];
  [k: string]: unknown;
};

function enforceIncomeRealData(result: IncomeResult, input: ModulesInput): IncomeResult {
  const f = input.incomeFigures;
  const hasCoreFigures =
    !!f && f.grossPotentialIncome != null && f.vacancyPct != null && f.operatingExpenses != null;
  const hasCapRate = !!input.capRate?.pct && input.capRate.pct > 0;
  const hasIndicated = input.incomeIndicatedValue != null;

  if (hasCoreFigures && hasCapRate && hasIndicated) {
    // Real data present — trust the parsed narrative, but still never let the
    // model claim support without a computed value behind it.
    return result;
  }

  const needed: string[] = [];
  if (!hasCoreFigures) {
    needed.push("Trailing-12 profit & loss / operating statement", "Current rent roll");
  }
  if (!hasCapRate) {
    needed.push("Capitalization rate — a fee appraisal that states one, or your own input");
  }
  const existing = new Set((result.missingInformation ?? []).map((s) => s.toLowerCase()));
  const missingInformation = [
    ...needed.filter((s) => !existing.has(s.toLowerCase())),
    ...(result.missingInformation ?? []),
  ].slice(0, 8);

  return {
    ...result,
    supportsCadValue: "inconclusive",
    cadComparisonNarrative:
      "The income approach can't be completed yet — upload the financial records and provide a capitalization rate, then this will compare the income-indicated value with the CAD value.",
    capRateBasis: hasCapRate
      ? (result.capRateBasis as string)
      : "No capitalization rate on file yet — upload an appraisal that states one, or enter a rate.",
    missingInformation,
  };
}

// Module 5 (improvement) — the 4 fixed building components, in a fixed
// order. Same allow-list discipline as SITE_FACTORS: the AI can't omit or
// invent a row, so the UI's 4-row layout is always stable.
const BUILDING_COMPONENTS = ["Roof", "HVAC", "Exterior", "Interior"] as const;
type BuildingComponentName = (typeof BUILDING_COMPONENTS)[number];
type BuildingComponentCondition = "Good" | "Fair" | "Poor" | "Unknown";
type BuildingComponent = {
  component: BuildingComponentName;
  hasPhoto: boolean;
  notApplicable: boolean;
  condition: BuildingComponentCondition;
  actionNeeded: string | null;
  notes: string;
};
const BUILDING_COMPONENT_CONDITIONS: BuildingComponentCondition[] = [
  "Good",
  "Fair",
  "Poor",
  "Unknown",
];

// First pass — validates the AI's raw array into exactly 4 typed entries.
// Does not yet know whether any evidence images were actually sent (that's
// only visible in the request handler, not here) — see
// enforceBuildingComponentRealData below.
function buildingComponents(v: unknown): BuildingComponent[] {
  const byName = new Map<string, Record<string, unknown>>();
  if (Array.isArray(v)) {
    for (const x of v) {
      if (
        typeof x === "object" &&
        x !== null &&
        typeof (x as Record<string, unknown>).component === "string"
      ) {
        byName.set(
          (x as Record<string, unknown>).component as string,
          x as Record<string, unknown>,
        );
      }
    }
  }
  return BUILDING_COMPONENTS.map((component) => {
    const x = byName.get(component) ?? {};
    const hasPhoto = x.hasPhoto === true;
    // Belt-and-suspenders: the model's own "no photo" admission always wins
    // over a stray non-"Unknown" condition it might have filled in anyway.
    const condition = !hasPhoto
      ? "Unknown"
      : BUILDING_COMPONENT_CONDITIONS.includes(x.condition as BuildingComponentCondition)
        ? (x.condition as BuildingComponentCondition)
        : "Unknown";
    return {
      component,
      hasPhoto,
      notApplicable: false,
      condition,
      actionNeeded: hasPhoto ? str(x.actionNeeded, 60) || null : null,
      notes: hasPhoto ? str(x.notes, 70) : "",
    };
  });
}

// Second pass — the real enforcement, run in the request handler where
// input.evidenceImages is visible (spec.parse only ever sees the AI's raw
// JSON, matching every other module). When literally zero photos were
// sent, every component is hard-clamped to "no photo" regardless of what
// the AI returned — this app has nothing real to show it, and the model's
// own discipline alone isn't trusted to guarantee that. notApplicable is a
// real, user-confirmed exclusion (see module-overrides.ts) — only applied
// when that component still has no real photo, so an actual uploaded photo
// always wins over a stale override.
function enforceBuildingComponentRealData(
  components: BuildingComponent[],
  hadAnyPhotos: boolean,
  notApplicable: string[],
): BuildingComponent[] {
  const clamped = hadAnyPhotos
    ? components
    : components.map((c) => ({
        ...c,
        hasPhoto: false,
        condition: "Unknown" as const,
        actionNeeded: null,
        notes: "",
      }));
  return clamped.map((c) =>
    !c.hasPhoto && notApplicable.includes(c.component) ? { ...c, notApplicable: true } : c,
  );
}

const MODULE_SPECS: Record<string, ModuleSpec> = {
  strategy: {
    instruction:
      "Evaluate up to 5 fixed valuation strategies for this property — Comparable Sales, Site " +
      "Condition, Improvement Condition, Income Approach, and Zoning / Classification — plus, " +
      "only if a genuinely distinct argument applies beyond those 5, one additional " +
      '"Other: <label>" entry (do not invent an Other entry just to add a 6th). For EACH ' +
      "strategy, weigh its opportunity magnitude, your confidence in the underlying data, how " +
      "available supporting evidence typically is, how reliable this method is for this property " +
      "type, this property type's relevance to the argument, and the quality of information you " +
      "actually have — blend those into one 0-100 Strategy Strength Score. Rank strategies " +
      "strongest first. For any strategy where you genuinely don't have enough information to " +
      "score it responsibly, set dataSufficient to false and list what's missing rather than " +
      "guessing a number.",
    schema:
      '{"strategies": [{"name": "<Comparable Sales | Site Condition | Improvement Condition | ' +
      'Income Approach | Zoning / Classification | Other: label>", "strengthScore": <integer ' +
      '0-100>, "primaryReason": "<short phrase>", "whySelected": "<ONE short sentence, max ' +
      '~15 words>", "supportingFindings": "<ONE short sentence, max ~15 words>", ' +
      '"valuationRelevance": "<ONE short sentence, max ~12 words>", ' +
      '"existingEvidence": ["<short>", ...], "missingEvidence": ["<short>", ...], ' +
      '"confidencePct": <integer 0-100>, "recommendedInvestigation": "<ONE short sentence, max ' +
      '~12 words>", "dataSufficient": <true|false>}, ...], "topStrategySummary": "<ONE short ' +
      'sentence, max ~15 words, naming the top 1-2 strategies>"}',
    parse: (p) => ({
      strategies: strategies(p.strategies),
      topStrategySummary: str(p.topStrategySummary, 140),
    }),
  },
  comps: {
    instruction:
      "Give guidance on comparable-property and equity-comp evidence relevant to this property " +
      "type and county. For a CAD comp (no 'saleVerified' flag) this is an assessed-value " +
      "comparable — never call it a 'sale' or imply a sale price. A comp marked userAdded with " +
      "saleVerified true came from a document the owner uploaded and DOES have a real sale price. " +
      "Each comp above has a stable 'key'. From the comps given: (1) pick the strongest 3-5 as " +
      "recommendedKeys — most similar by real value/distance/land-size/type differences, most " +
      "reliable source; never pick a comp already marked excluded. (2) For EACH comp key, give a " +
      "verdict of 'use' or 'exclude' and a one-line reason citing only real differences given " +
      "(e.g. 'far larger lot', 'value 40% above subject', 'half a mile away', 'different use " +
      "code'). (3) protestRecommendation: 1-2 sentences on how to actually use this comp set in " +
      "the protest hearing. Never invent a property, address, key, or number not given above.",
    schema:
      `{"guidance": "<ONE short sentence, max ~18 words — a headline, the checklist below carries ` +
      `the detail>", "checklist": ["<short item>", ...], "recommendedUse": "<ONE to two short ` +
      `sentences, max ~30 words total — omit/empty string entirely if no real top comps were given ` +
      `above>", "recommendedKeys": ["<key>", ...] (3-5, each MUST be one of the keys given above), ` +
      `"perComp": [{"key": "<key given above>", "verdict": "use | exclude", "reason": "<max ~16 ` +
      `words, real differences only>"}, ...], "protestRecommendation": "<ONE to two short sentences, ` +
      `max ~35 words — empty string if no real comps were given>"}`,
    parse: (p) => ({
      guidance: str(p.guidance, 160),
      checklist: checklist(p.checklist),
      // 320, not the ~200 chars "30 words" implies — confirmed live the
      // model's real two-sentence output regularly ran a bit over its own
      // word-count instruction, and a hard character slice mid-sentence
      // read as a broken/cut-off UI, not just "a bit long." Generous
      // headroom over the target is safer here than a tight truncation.
      recommendedUse: str(p.recommendedUse, 320),
      // recommendedKeys / perComp are clamped to the keys actually sent in
      // the handler below (spec.parse has no access to input.topComps).
      recommendedKeys: strList(p.recommendedKeys, 5, 64),
      perComp: Array.isArray(p.perComp)
        ? p.perComp
            .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
            .map((x) => ({
              key: str(x.key, 64),
              verdict: x.verdict === "exclude" ? "exclude" : "use",
              reason: str(x.reason, 160),
            }))
            .filter((x) => x.key.length > 0)
            .slice(0, 40)
        : [],
      protestRecommendation: str(p.protestRecommendation, 320),
    }),
  },
  site: {
    instruction:
      "Assess this property's site conditions across exactly these 16 factors, in this exact " +
      "order: Floodplain, Easements, Drainage, Sewer, Water Availability, Buildability, Ponds, " +
      "Streams, Road Frontage, Visibility, Traffic Counts / VPD, Grade, Topography, Access " +
      "Limitations, Highway Proximity, Railroad Proximity. Only Floodplain, Grade, Highway " +
      "Proximity, and Railroad Proximity can ever be backed by real data (given above, when " +
      "present) — for every other factor you have no real source, so briefly explain what the " +
      "factor is, why it could matter for THIS property type/value, and what to upload to " +
      "assess it (a plat, a drainage plan, a utility letter, a traffic study, a topo survey, " +
      "etc.); never claim a specific site condition you weren't given real data for. For " +
      "Floodplain, state the real zone/Special Flood Hazard Area status given above; for Grade, " +
      "state the real elevation given above but note a single point isn't a full topographic " +
      "assessment; for Highway Proximity and Railroad Proximity, state the real distance given " +
      "above (if given) and note this as a potential noise/traffic/access factor an appraiser " +
      "may not have adjusted for — if no real distance was given for either, treat it like any " +
      "other undocumented factor. Also give an overall 0-100 documentation-priority score for " +
      "how worthwhile pursuing site-condition evidence looks for this property (its value " +
      "profile and property type), and a one-sentence key finding grounded only in whichever " +
      "factors have real/partial data — say plainly that more data is needed if nothing real " +
      "was found, never assert a valuation impact you can't back with a real fact.",
    schema:
      `{"guidance": "<ONE short sentence, max ~18 words>", ` +
      `"factors": [{"factor": "<one of the 16 exact names above>", "status": "<Confirmed | ` +
      `Partial Data | Additional Data Needed>", "finding": "<short factual statement, max ~10 ` +
      `words>", "severity": "<High | Moderate | Low | Unknown>", "confidence": "<High | ` +
      `Moderate | Low>", "potentialImpact": "<short phrase, max ~8 words>", "evidenceNeeded": ` +
      `"<short phrase, or null if nothing further is needed>"}, ...] (exactly 16 entries, one ` +
      `per factor, in the order listed above), ` +
      `"keyFinding": "<max 2 short sentences>", "priorityScore": <integer 0-100>}`,
    parse: (p) => ({
      guidance: str(p.guidance, 160),
      // Real-data enforcement (Floodplain/Grade clamped to what siteGis
      // actually gave, every other factor hard-clamped to "Additional Data
      // Needed") happens in the request handler via
      // enforceSiteFactorRealData — this parse() only has the AI's raw
      // JSON, not the original input, matching every other module's parse.
      factors: siteFactors(p.factors),
      // 320, not the ~180 chars "2 short sentences" implies — same fix
      // comps.recommendedUse already needed: confirmed live the model's
      // real output regularly ran a bit over its own instruction, and a
      // hard character slice mid-sentence reads as a broken/cut-off UI, not
      // just "a bit long." Generous headroom over the target is safer than
      // a tight cut.
      keyFinding: str(p.keyFinding, 320),
      priorityScore: score100(p.priorityScore),
    }),
  },
  improvement: {
    instruction:
      "Assess this property's building condition across exactly these 4 components, in this " +
      "exact order: Roof, HVAC, Exterior, Interior. Set hasPhoto true for a component ONLY when " +
      "an attached photo/document actually shows it — if none does, set hasPhoto false and leave " +
      "condition/actionNeeded/notes at their defaults; never guess a condition for a component " +
      "you can't actually see. For a component you DO have a real photo of, state condition " +
      "(Good/Fair/Poor) and actionNeeded (e.g. Repair Needed, Replacement, Maintenance, or null " +
      "if nothing is needed) based only on what's visible. Also estimate effectiveAgeYears ONLY " +
      "if photos/documents give a real basis for it (visible wear, stated renovation history, " +
      "etc.) — ground it using the typical economic life range given above, never invent an age " +
      "from property type or value alone; leave it null with an honest effectiveAgeBasis " +
      "otherwise. Same discipline for functionalObsolescencePct (outdated layout/systems/design " +
      "visible in what was given) and externalObsolescencePct (market/locational factors you can " +
      "reasonably infer from the record) — null with an honest basis when there's no real " +
      "grounding for either. Also give an overall 0-100 documentation-priority score for how " +
      "worthwhile pursuing improvement-condition evidence looks for this property, and a " +
      "one-sentence key finding grounded only in whichever components/metrics have real data — " +
      "say plainly that more data is needed if nothing real was found.",
    schema:
      `{"guidance": "<ONE short sentence, max ~18 words>", ` +
      `"buildingComponents": [{"component": "<one of: Roof | HVAC | Exterior | Interior>", ` +
      `"hasPhoto": <true|false>, "condition": "<Good | Fair | Poor | Unknown>", "actionNeeded": ` +
      `"<short phrase, e.g. Repair Needed | Replacement | Maintenance, or null>", "notes": ` +
      `"<max ~8 words>"}, ...] (exactly 4 entries, in the order listed above), ` +
      `"effectiveAgeYears": <number, or null if not reliably supported>, ` +
      `"effectiveAgeBasis": "<max ~10 words, or 'Additional Data Needed — upload property ` +
      `photos' if the value above is null>", ` +
      `"functionalObsolescencePct": <integer 0-100, or null>, ` +
      `"functionalObsolescenceBasis": "<max ~10 words>", ` +
      `"externalObsolescencePct": <integer 0-100, or null>, ` +
      `"externalObsolescenceBasis": "<max ~10 words>", ` +
      `"keyFinding": "<max 2 short sentences>", "priorityScore": <integer 0-100>}`,
    parse: (p) => {
      const hasAge =
        typeof p.effectiveAgeYears === "number" && Number.isFinite(p.effectiveAgeYears);
      return {
        guidance: str(p.guidance, 160),
        // Real-data enforcement (every component clamped to "no photo" when
        // zero evidence images were sent at all) happens in the request
        // handler via enforceBuildingComponentRealData — this parse() only
        // has the AI's raw JSON, matching every other module's parse.
        buildingComponents: buildingComponents(p.buildingComponents),
        effectiveAgeYears: hasAge ? Math.max(0, Math.round(p.effectiveAgeYears as number)) : null,
        effectiveAgeBasis: str(p.effectiveAgeBasis, 90),
        functionalObsolescencePct: score100OrNull(p.functionalObsolescencePct),
        functionalObsolescenceBasis: str(p.functionalObsolescenceBasis, 90),
        externalObsolescencePct: score100OrNull(p.externalObsolescencePct),
        externalObsolescenceBasis: str(p.externalObsolescenceBasis, 90),
        keyFinding: str(p.keyFinding, 320),
        priorityScore: score100(p.priorityScore),
      };
    },
  },
  zoning: {
    instruction:
      "Line up this property's CAD Classification, Actual Use, Zoning District, and Permitted Use " +
      "from the real data given (zoningData). Then, keeping THREE things strictly separate: " +
      "(1) DETECTED DISCREPANCY — describe any mismatch BETWEEN two of the four aspects, factually, " +
      "with a confidence level; a discrepancy is descriptive only. " +
      "(2) VALUATION RELEVANCE — a SEPARATE judgement: does the mismatch plausibly bear on value or " +
      "exemptions? If the impact is unclear or none, say so plainly. A zoning/classification " +
      "mismatch is NOT by itself evidence of overvaluation — never phrase it as if it were. " +
      "(3) EVIDENCE REQUIRED — what documents would substantiate the discrepancy or the valuation " +
      "point (site photos, use/lease records, a zoning verification letter, permit history, etc.). " +
      "Also: list any exemptions or special-use valuations the owner could raise with the ARB IF " +
      "requirements are met (agricultural / open-space 1-d-1, special appraisal, non-profit, " +
      "Freeport, pollution-control) — only where plausibly applicable, empty array otherwise; " +
      "note any deed / easement / CC&R / development restrictions visible in the data (else say " +
      "none were found in the data given); comment in one sentence on whether the comparable " +
      "properties' classifications look consistent with this one; and classify this property into " +
      "exactly one category. Never invent a zoning code, ordinance, restriction, or use not present " +
      'in the data. For an aspect with no real value in zoningData, use "—" and status ' +
      '"Additional Data Needed".',
    schema:
      `{"matches": "<consistent | inconsistent | uncertain>", ` +
      `"assessment": "<ONE short sentence, max ~18 words — the headline verdict>", ` +
      `"typicalClassification": "<2-4 words, the CAD classification typically expected>", ` +
      `"category": "<one of: Office | Retail | Neighborhood Services | Commercial | Agricultural | Rural | Non-profit | Other>", ` +
      `"aspects": [{"label": "<CAD Classification | Actual Use | Zoning District | Permitted Use>", ` +
      `"value": "<the real value or '—'>", "status": "<Confirmed | Partial Data | Additional Data Needed>", ` +
      `"source": "<max ~8 words — where this came from, or what to upload>"}] (exactly these 4, in this order), ` +
      `"discrepancies": [{"between": "<Aspect A ↔ Aspect B>", "detail": "<max ~22 words, factual, no 'therefore overvalued'>", ` +
      `"confidence": "<High | Moderate | Low>"}] (empty array if none), ` +
      `"valuationRelevance": "<ONE to two sentences — the SEPARATE value/exemption judgement, or 'No clear valuation impact from classification alone.'>", ` +
      `"possibleExemptions": ["<short phrase>", ...] (empty if none), ` +
      `"evidenceRequired": ["<short phrase>", ...], ` +
      `"restrictions": "<one sentence on deed/easement/CC&R/development restrictions in the data, or 'None found in the data given.'>", ` +
      `"comparableClassifications": "<ONE sentence on comp classification consistency>"}`,
    parse: (p) => {
      const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fb: T): T =>
        typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fb;
      const ASPECT_LABELS = [
        "CAD Classification",
        "Actual Use",
        "Zoning District",
        "Permitted Use",
      ] as const;
      const rawAspects = Array.isArray(p.aspects) ? p.aspects : [];
      const aspects = ASPECT_LABELS.map((label) => {
        const found = rawAspects.find(
          (a): a is Record<string, unknown> =>
            typeof a === "object" && a !== null && a.label === label,
        );
        return {
          label,
          value: str(found?.value, 80) || "—",
          status: oneOf(
            found?.status,
            ["Confirmed", "Partial Data", "Additional Data Needed"] as const,
            "Additional Data Needed",
          ),
          source: str(found?.source, 80),
        };
      });
      const discrepancies = (Array.isArray(p.discrepancies) ? p.discrepancies : [])
        .filter((d): d is Record<string, unknown> => typeof d === "object" && d !== null)
        .map((d) => ({
          between: str(d.between, 60),
          detail: str(d.detail, 200),
          confidence: oneOf(d.confidence, ["High", "Moderate", "Low"] as const, "Low"),
        }))
        .filter((d) => d.between.length > 0)
        .slice(0, 4);
      return {
        matches: oneOf(
          p.matches,
          ["consistent", "inconsistent", "uncertain"] as const,
          "uncertain",
        ),
        assessment: str(p.assessment, 160),
        typicalClassification: str(p.typicalClassification, 40),
        category: oneOf(
          p.category,
          [
            "Office",
            "Retail",
            "Neighborhood Services",
            "Commercial",
            "Agricultural",
            "Rural",
            "Non-profit",
            "Other",
          ] as const,
          "Other",
        ),
        aspects,
        discrepancies,
        valuationRelevance: str(p.valuationRelevance, 400),
        possibleExemptions: strList(p.possibleExemptions, 5, 120),
        evidenceRequired: strList(p.evidenceRequired, 6, 120),
        restrictions: str(p.restrictions, 300),
        comparableClassifications: str(p.comparableClassifications, 240),
      };
    },
  },
  income: {
    instruction:
      "You are given a commercial property's OWNER-CONFIRMED income figures and the " +
      "already-computed EGI, NOI, and income-approach indicated value (all in the record above, " +
      "under 'Income approach'). DO NOT recompute or invent ANY number — no revenue, expense, " +
      "vacancy rate, NOI, or capitalization rate. Your job is to EXPLAIN the figures given. " +
      "State the basis for the vacancy percentage used, and say whether the operating-expense " +
      "ratio looks typical for this property type (general appraisal knowledge only — never cite " +
      "a specific comparable figure you were not given). State where the cap rate came from " +
      "(owner-entered vs an appraisal) and, if you know a typical market range for this property " +
      "type and region as general knowledge, give it as context only. Compare the indicated " +
      "value to the CAD value and, if a comparable-sales range is given, to that range; then " +
      "classify support as exactly one of: supports (income indicated value is at or above the " +
      "CAD value), does-not-support (income indicates a materially lower value than the CAD), " +
      "inconclusive. List the key assumptions made, the data sources used, an honest one-line " +
      "confidence note, and the specific additional documents that would materially improve this " +
      "analysis. If the record says the figures or the cap rate are missing, set supportsCadValue " +
      "to 'inconclusive', keep every narrative field brief, and put the needed documents in " +
      "missingInformation — never fill a gap with a typical number.",
    schema:
      `{"assessment": "<ONE short sentence, max ~18 words — the headline verdict>", ` +
      `"supportsCadValue": "<supports | does-not-support | inconclusive>", ` +
      `"cadComparisonNarrative": "<1-2 sentences comparing the income indicated value to the CAD ` +
      `value (and comps range if given); no restating raw numbers the tiles already show>", ` +
      `"vacancyBasis": "<max ~20 words — basis for the vacancy % used, or 'Owner-provided; no ` +
      `market basis on file.'>", ` +
      `"opexBasis": "<max ~24 words — whether the operating-expense ratio looks typical for this ` +
      `property type>", ` +
      `"capRateBasis": "<max ~24 words — where the cap rate came from and any general market-range ` +
      `context>", ` +
      `"assumptions": ["<short phrase>", ...] (max 8, empty if none), ` +
      `"sources": ["<short phrase>", ...] (max 8), ` +
      `"confidenceNote": "<ONE short sentence on data quality/completeness>", ` +
      `"missingInformation": ["<short phrase>", ...] (max 8), ` +
      `"lineItemNotes": [{"line": "<Gross Potential Income | Vacancy | Effective Gross Income | ` +
      `Operating Expenses | Net Operating Income | Cap Rate | Indicated Value>", "note": "<max ` +
      `~18 words>"}, ...] (only where a note adds something, max 8)}`,
    parse: (p) => {
      const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fb: T): T =>
        typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fb;
      const lineItemNotes = (Array.isArray(p.lineItemNotes) ? p.lineItemNotes : [])
        .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
        .map((x) => ({ line: str(x.line, 40), note: str(x.note, 160) }))
        .filter((x) => x.line.length > 0 && x.note.length > 0)
        .slice(0, 8);
      return {
        assessment: str(p.assessment, 160),
        supportsCadValue: oneOf(
          p.supportsCadValue,
          ["supports", "does-not-support", "inconclusive"] as const,
          "inconclusive",
        ),
        cadComparisonNarrative: str(p.cadComparisonNarrative, 400),
        vacancyBasis: str(p.vacancyBasis, 200),
        opexBasis: str(p.opexBasis, 240),
        capRateBasis: str(p.capRateBasis, 240),
        assumptions: strList(p.assumptions, 8, 140),
        sources: strList(p.sources, 8, 120),
        confidenceNote: str(p.confidenceNote, 220),
        missingInformation: strList(p.missingInformation, 8, 140),
        lineItemNotes,
      };
    },
  },
  evidence: {
    instruction:
      "Produce a prioritized evidence checklist for the protest packet. For each item, judge its " +
      "importance to the case (High/Low) and how readily available it typically is to a property " +
      "owner (High/Low) — this powers a priority-quadrant view, so favor items that actually differ " +
      "on these two axes rather than marking everything High/High. importance is High only for an " +
      "item that would materially change the strategy/value argument if missing, Low otherwise; " +
      "availability is High only for something the owner already has or can obtain with no real " +
      "effort (a photo, a bill), Low for something that takes real work to get (a certified " +
      "appraisal, a rent roll). This checklist feeds a real completeness score shown to the user — " +
      "given the same property record, always select the same real evidence types and classify them " +
      "the same way, not a different list each time. For EACH item, also give 1-3 concrete " +
      "documentSuggestions the owner could actually upload to satisfy it: documentName is a short " +
      'real document type (e.g. "Independent Fee Appraisal Report", "Site Photos — Utility ' +
      'Meter Locations"), whatToInclude is one plain sentence on what the document should actually ' +
      "show or state, and whereToObtain names a REAL, GENERAL source type for this kind of document " +
      "— never a specific company/URL/portal you can't verify — using only these kinds of sources: " +
      "the county appraisal district (CAD) website or office, a licensed land surveyor, a licensed " +
      "property appraiser (MAI), the property owner's own records, the city or county " +
      "planning/zoning department, a general contractor or licensed inspector, or the owner's own " +
      "camera/phone (for photos). Never invent a specific named vendor, website, or phone number.",
    schema:
      `{"items": [{"item": "<short item>", "importance": "<High | Low>", "availability": "<High | Low>", ` +
      `"documentSuggestions": [{"documentName": "<short document type>", "whatToInclude": ` +
      `"<one sentence>", "whereToObtain": "<a general real source type>"}, ...]}, ...]}`,
    parse: (p) => ({ items: evidenceItems(p.items) }),
  },
  executive: {
    instruction:
      "You are writing the FINAL conclusion after reviewing this property's complete case — " +
      "not another independent module. Reconcile the real strategy, comparable-value, evidence, " +
      "and financial findings already given in the record above into one recommendation. Name " +
      "real strategies, comps, and evidence items from the record — never invent a different " +
      "one. If the record's own signals genuinely disagree with each other (e.g. a strong " +
      "strategy score alongside missing critical evidence, or a comps range that doesn't support " +
      "the stated savings), say so in conflictNote instead of silently picking a side; leave " +
      "conflictNote null when nothing actually conflicts. Do not guarantee an outcome, a specific " +
      "reduction, or protest success. For defenseQA, generate 4-6 property-specific questions an " +
      "appraisal district or ARB panel would realistically raise against THIS property's specific " +
      "strategy/comps/evidence — not a generic FAQ — each with a fact-based suggested answer " +
      "grounded only in the record. status is a real classification, not a feel — apply this rule " +
      "strictly, in order: Supported only when the record's own evidence/comps/strategy data " +
      "directly and fully backs the answer; Partially Supported when the record backs part of the " +
      "answer but a real gap remains; Evidence Needed when the record names the needed evidence " +
      "item but it isn't yet marked as uploaded/available; User Input Needed when answering fully " +
      "requires a fact this record doesn't contain at all. This score feeds a real readiness gauge " +
      "shown to the user — given the same record, always classify the same way, not a different " +
      "call each time. This page is a visual dashboard, not a report to read top to bottom — every " +
      "text field below is displayed next to real numbers/badges/gauges that already convey the " +
      "figures (score, value, confidence). Never restate a number or fact the record already gave " +
      "you; every field is the shortest possible phrase that adds NEW information a stat tile " +
      "can't show, not a sentence justifying or explaining the stat.",
    schema:
      `{"recommendedAction": "<one of: Proceed with Protest | Proceed with Protest After ` +
      `Completing Recommended Evidence | Additional Information Needed Before Proceeding | ` +
      `Limited Protest Opportunity Based on Available Information>", ` +
      `"recommendationExplanation": "<ONE short sentence, max ~15 words — the single most ` +
      `important reason only, never restating a $ or % figure>", ` +
      `"primaryStrategyExplanation": "<max ~10 words, a short phrase not a sentence — why this ` +
      `strategy, in a few words, or null if none is clearly supported>", ` +
      `"secondaryStrategyExplanation": "<max ~10 words, or null if no second strategy materially ` +
      `contributes>", ` +
      `"majorFindings": [{"finding": "<short title, max ~6 words>", "whyItMatters": "<max ~8 ` +
      `words>", "relatedModule": "<one of: comps | site | improvement | zoning | income | ` +
      `evidence | null>"}, ...] (3-5 items, most important first), ` +
      `"missingInformation": [{"item": "<short item>", "severity": "<Critical | Important | ` +
      `Supporting>"}, ...] (only real gaps, empty array if none), ` +
      `"recommendedProtestValue": <number, the real indicated value to argue for, or null if not ` +
      `reliably supported by the record>, ` +
      `"recommendedProtestValueBasis": "<max ~10 words, or 'Additional analysis required' if the ` +
      `value above is null>", ` +
      `"nextAction": "<ONE short sentence, max ~12 words, the single most important next step>", ` +
      `"conflictNote": "<1 short sentence describing a genuine conflict between the record's own ` +
      `signals, or null>", ` +
      `"defenseQA": [{"question": "<property-specific likely challenge>", "suggestedAnswer": ` +
      `"<max ~20 words, fact-based, using only the record>", "status": "<one of: Supported | ` +
      `Partially Supported | Evidence Needed | User Input Needed>", "relatedModule": "<one of: ` +
      `comps | site | improvement | zoning | income | evidence | null>"}, ...] (4-6 items)}`,
    parse: (p) => ({
      recommendedAction: isValidRecommendedAction(p.recommendedAction)
        ? p.recommendedAction
        : "Additional Information Needed Before Proceeding",
      recommendationExplanation: str(p.recommendationExplanation, 140),
      primaryStrategyExplanation: str(p.primaryStrategyExplanation, 90) || null,
      secondaryStrategyExplanation: str(p.secondaryStrategyExplanation, 90) || null,
      majorFindings: majorFindings(p.majorFindings),
      missingInformation: missingInformation(p.missingInformation),
      recommendedProtestValue:
        typeof p.recommendedProtestValue === "number" && Number.isFinite(p.recommendedProtestValue)
          ? p.recommendedProtestValue
          : null,
      recommendedProtestValueBasis: str(p.recommendedProtestValueBasis, 90),
      nextAction: str(p.nextAction, 160),
      conflictNote: str(p.conflictNote, 200) || null,
      defenseQA: defenseQA(p.defenseQA),
    }),
  },
};

// Shared by every module call and the Q&A question path — builds the plain-text
// "record" the model reasons over. Each optional block only appears when the
// client actually has that real data (comps fetched, ratio study covers this
// county/category, value history long enough to detect a jump, etc.) — nothing
// here is invented when the underlying data isn't available.
function buildRecord(input: ModulesInput): string {
  const lines: Array<string | false | undefined> = [
    input.address && `Address: ${input.address}`,
    input.cad && `Appraisal district: ${input.cad}`,
    input.propertyType && `Property type: ${input.propertyType}`,
    input.taxYear && `Tax year: ${input.taxYear}`,
    input.landValue != null && `Land value: $${input.landValue.toLocaleString()}`,
    input.improvementValue != null &&
      `Improvement value: $${input.improvementValue.toLocaleString()}`,
    input.totalValue != null && `Total assessed value: $${input.totalValue.toLocaleString()}`,
  ];

  if (input.siteGis) {
    const g = input.siteGis;
    const parts: string[] = [];
    if (g.floodZone) {
      parts.push(
        `Real FEMA flood zone at this property's exact location: Zone ${g.floodZone.zone} ` +
          `(${g.floodZone.label})${g.floodZone.inSFHA ? ", inside a Special Flood Hazard Area" : ", not in a Special Flood Hazard Area"}.`,
      );
    }
    if (g.elevationFt != null) {
      parts.push(
        `Real ground elevation at this exact point (USGS): ${Math.round(g.elevationFt)} ft — ` +
          `a single point, not a full topographic survey.`,
      );
    }
    if (g.nearestHighwayMi != null) {
      parts.push(
        `Real distance to the nearest major highway (OpenStreetMap): ${g.nearestHighwayMi.toFixed(2)} miles.`,
      );
    }
    if (g.nearestRailMi != null) {
      parts.push(
        `Real distance to the nearest rail line (OpenStreetMap): ${g.nearestRailMi.toFixed(2)} miles.`,
      );
    }
    if (parts.length > 0) {
      lines.push(
        `${parts.join(" ")} Use these exact real values — never invent a different zone, elevation, or distance.`,
      );
    }
  }
  if (input.economicLifeYears) {
    const e = input.economicLifeYears;
    lines.push(
      `Typical economic life for this property type (general industry guidance, not a ` +
        `precise or county-specific figure): ${e.min}-${e.max} years (${e.typical} typical). ` +
        `Only estimate an effective age if photos/documents actually show the building's real ` +
        `condition — ground it in what's visible, never in property type or value alone.`,
    );
  }
  if (input.compsSummary) {
    const c = input.compsSummary;
    lines.push(
      `Real comparable properties found nearby: ${c.count} (market value range ` +
        `$${c.min.toLocaleString()}-$${c.max.toLocaleString()}, median $${c.median.toLocaleString()})`,
    );
  }
  if (input.assessmentRatio) {
    const r = input.assessmentRatio;
    lines.push(
      `County Comptroller ratio study for this property type: median assessment ratio ` +
        `${r.medianPct}%, coefficient of dispersion ${r.cod.toFixed(1)}` +
        (r.codOverCeiling > 0
          ? ` (${r.codOverCeiling.toFixed(1)} points above the IAAO standard)`
          : " (within the IAAO standard)"),
    );
  }
  if (input.valueTrend?.jumpTriggered) {
    lines.push(
      `This property's assessed value jumped ${
        input.valueTrend.jumpPct != null
          ? `${Math.round(input.valueTrend.jumpPct * 100)}%`
          : "significantly"
      } beyond its own historical trend this year.`,
    );
  }
  if (input.evidenceFileNames && input.evidenceFileNames.length > 0) {
    lines.push(
      `Evidence documents already uploaded by the owner: ${input.evidenceFileNames.join(", ")}`,
    );
  }
  if (input.priorityContext && input.priorityContext.length > 0) {
    lines.push(
      `The Protest Strategy module already ranked this property's valuation arguments (0-100 ` +
        `strength scores): ${input.priorityContext.map((p) => `${p.strategy} ${p.score}`).join(", ")}. ` +
        `Weight your analysis and guidance accordingly.`,
    );
  }
  if (input.topComps && input.topComps.length > 0) {
    lines.push(
      `Real top comparable properties, ranked by similarity (use these exact ones by address — ` +
        `never invent a different comparable):\n` +
        input.topComps
          .map(
            (c, i) =>
              `${i + 1}. ${c.address} — ${c.distanceMi.toFixed(1)} mi, ` +
              `${c.marketValue != null ? `$${c.marketValue.toLocaleString()} assessed value` : "value not on file"}, ` +
              `${c.similarity}/100 similarity`,
          )
          .join("\n"),
    );
  }
  if (input.topStrategies && input.topStrategies.length > 0) {
    lines.push(
      `The Protest Strategy module already analyzed this case in full — use these exact real ` +
        `strategies and reasons, never invent a different one:\n` +
        input.topStrategies
          .map(
            (s, i) =>
              `${i + 1}. ${s.name} (strength ${s.strengthScore}/100)` +
              (s.primaryReason ? ` — ${s.primaryReason}` : "") +
              (s.whySelected ? `. Why: ${s.whySelected}` : "") +
              (s.existingEvidence && s.existingEvidence.length > 0
                ? `. Existing evidence: ${s.existingEvidence.join(", ")}`
                : "") +
              (s.missingEvidence && s.missingEvidence.length > 0
                ? `. Missing evidence: ${s.missingEvidence.join(", ")}`
                : ""),
          )
          .join("\n"),
    );
  }
  if (input.evidenceReadiness) {
    const e = input.evidenceReadiness;
    lines.push(
      `The Evidence Builder module already identified the case's real evidence gaps — ` +
        `${e.uploadedCount} file${e.uploadedCount === 1 ? "" : "s"} uploaded so far. ` +
        (e.criticalMissing.length > 0
          ? `Still missing (top priority): ${e.criticalMissing.join(", ")}. `
          : "No top-priority evidence gaps remain. ") +
        (e.importantMissing.length > 0
          ? `Also missing (lower priority): ${e.importantMissing.join(", ")}.`
          : ""),
    );
  }
  if (input.compsIndicated) {
    const c = input.compsIndicated;
    lines.push(
      `The Market Value module's real comparable-property analysis indicates a value range of ` +
        `$${c.min.toLocaleString()}-$${c.max.toLocaleString()} (median $${c.median.toLocaleString()})` +
        (c.gapPct != null
          ? `, ${c.gapPct > 0 ? "above" : "at or below"} this indicated range by ${Math.abs(c.gapPct)}%`
          : "") +
        (c.confidencePct != null ? `, ${c.confidencePct}/100 confidence` : "") +
        ". Use this exact range — never invent a different indicated value.",
    );
  }
  if (input.moduleId === "income" && input.incomeFigures) {
    const f = input.incomeFigures;
    const money = (v: number | null | undefined) =>
      v != null ? `$${Math.round(v).toLocaleString()}` : "not provided";
    const capPct = input.capRate?.pct;
    lines.push(
      `Income approach — OWNER-CONFIRMED figures and deterministically-computed results (do NOT ` +
        `recompute or invent any of these):\n` +
        `- Gross potential income (annual): ${money(f.grossPotentialIncome)}\n` +
        `- Other income (annual): ${money(f.otherIncome)}\n` +
        `- Vacancy / collection loss: ${f.vacancyPct != null ? `${f.vacancyPct}%` : "not provided"}\n` +
        `- Operating expenses (annual): ${money(f.operatingExpenses)}` +
        (f.opexRatioPct != null ? ` (${f.opexRatioPct}% of EGI)` : "") +
        `\n` +
        `- Effective gross income (computed): ${money(f.egiComputed)}\n` +
        `- Net operating income (computed): ${money(f.noiComputed)}\n` +
        `- Capitalization rate: ${capPct ? `${capPct}%` : "NOT PROVIDED"}` +
        (input.capRate?.source ? ` (source: ${input.capRate.source})` : "") +
        `\n` +
        `- Income-approach indicated value (NOI ÷ cap rate): ${money(input.incomeIndicatedValue)}\n` +
        `- Current CAD assessed value: ${money(input.cadValue)}` +
        (input.compsIndicatedRange
          ? `\n- Market Value module's comparable-sales range: $${Math.round(
              input.compsIndicatedRange.min,
            ).toLocaleString()}-$${Math.round(
              input.compsIndicatedRange.max,
            ).toLocaleString()} (median $${Math.round(
              input.compsIndicatedRange.median,
            ).toLocaleString()})`
          : "") +
        (f.rentableSqft != null ? `\n- Rentable area: ${f.rentableSqft.toLocaleString()} SF` : "") +
        (f.documentKinds.length > 0
          ? `\n- Source documents provided: ${f.documentKinds.join(", ")}`
          : `\n- No source documents provided yet.`),
    );
  }
  if (input.moduleId === "executive" && input.incomeIndicated?.indicatedValue != null) {
    const i = input.incomeIndicated;
    lines.push(
      `The Income Value module's real income-approach analysis indicates a value of ` +
        `$${Math.round(i.indicatedValue!).toLocaleString()}` +
        (i.gapPct != null
          ? `, ${i.gapPct > 0 ? "below" : "at or above"} the CAD value by ${Math.abs(i.gapPct)}%`
          : "") +
        ` (${i.supports}, ${i.confidencePct}/100 confidence). Weigh this alongside the ` +
        `comparable-sales indication — use this exact figure, never invent a different one.`,
    );
  }
  if (input.financialSummary) {
    const f = input.financialSummary;
    const m = (v: number | undefined) => (v != null ? `$${Math.round(v).toLocaleString()}` : null);
    lines.push(
      `The Estimated Savings module already calculated a real potential annual tax savings of ` +
        `$${f.savings.toLocaleString()} (${f.basis === "comps" ? "based on real comparable properties" : "based on real county/category adjustments"}` +
        (f.reductionPct != null ? `, ${f.reductionPct}% value reduction` : "") +
        (m(f.netBenefit)
          ? `; after an estimated protest cost of ${m(f.protestCost)} (${f.protestCostSource ?? "estimated"}), the net benefit is ${m(f.netBenefit)}` +
            (f.savingsToCostMultiple != null
              ? `, a ${f.savingsToCostMultiple}x savings-to-cost multiple`
              : "") +
            (f.roiPct != null ? `, ${f.roiPct}% ROI` : "")
          : "") +
        (f.indicatedRange
          ? `; comparable-sales indicated value range ${m(f.indicatedRange.low)}-${m(f.indicatedRange.high)}`
          : "") +
        (f.financialConfidence ? `; financial confidence ${f.financialConfidence}` : "") +
        `). Use these exact figures — never recalculate or invent a different savings number. ` +
        `Weigh the net benefit and financial confidence, not just the gross savings.`,
    );
  }
  if (input.preFilingStatus) {
    lines.push(
      input.preFilingStatus.missingBlocking.length > 0
        ? `A protest case is on file for this property, but filing is currently blocked on: ` +
            `${input.preFilingStatus.missingBlocking.join(", ")}.`
        : `A protest case is on file for this property and it is ready to file — no blocking ` +
            `information is missing.`,
    );
  }

  return lines.filter((l): l is string => typeof l === "string").join("\n");
}

// Shared Gemini call + JSON-response parsing for both the module-analysis path and
// the Q&A question path. Throws an Error with a `status` property set to 429 when
// Gemini itself is rate-limited, so the caller can propagate that status instead of
// a generic 500.
type GeminiPart = { text: string } | { inline_data: { mime_type: string; data: string } };

// No timeout on this fetch at all before this — a slow/hung Gemini response
// just hung the edge function indefinitely, which is what actually surfaced
// as modules stuck on "Analyzing" forever (confirmed live: latency to Gemini
// is genuinely volatile right now — a trivial ping ranged from ~2s to 30s+
// with nothing on our end to explain the difference; this is congestion on
// Gemini's serving infrastructure, not something fixable by a prompt/config
// change here). 20s bounds the worst case to something the client can retry
// against instead of waiting forever — see the 504 handling below and the
// matching retry-on-504 in src/lib/edge-functions.ts (previously only
// retried 429).
const GEMINI_TIMEOUT_MS = 20_000;

async function generateJson(
  apiKey: string,
  system: string,
  parts: GeminiPart[],
  // Bounded, not left dynamic/unset — a fixed budget removes one source of
  // worst-case blowup (an unset budget lets the model choose its own,
  // unpredictable spend) and costs nothing when Gemini is responding
  // normally. This model rejects a budget of exactly 0 with a 400, so 512
  // is the smallest confirmed-working value — the default every module used
  // until "executive" needed real reconciliation across several other
  // modules' outputs plus property-specific Q&A generation, genuinely more
  // reasoning than a single-topic module's short schema.
  thinkingBudget = 512,
): Promise<Record<string, unknown>> {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget },
      // 0, not left at Gemini's default (~1) — several downstream numbers
      // (Module 10's Case Assessment / Defense Readiness gauges) are real
      // deterministic formulas over classification fields the model itself
      // assigns (evidence importance/availability, defenseQA status); at
      // default sampling those classifications visibly drifted between two
      // calls against the *same* underlying record, so a gauge could swing
      // 20+ points with nothing about the actual case having changed. 0
      // makes token selection always-greedy — not a mathematical guarantee
      // of byte-identical output every time, but it removes sampling as a
      // source of variance, leaving only genuine differences in the record
      // fed in to move these numbers.
      temperature: 0,
    },
  };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      const timeoutErr = new Error("AI response timed out. Please try again.") as Error & {
        status?: number;
      };
      timeoutErr.status = 504;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(t);
  }

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 429) {
      const err = new Error("AI is rate-limited. Please retry in a moment.") as Error & {
        status?: number;
      };
      err.status = 429;
      throw err;
    }
    throw new Error(`Gemini API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const raw = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : {};
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const input = (await req.json()) as ModulesInput;
    if (!input.totalValue) {
      return new Response(JSON.stringify({ error: "totalValue is required" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

    const record = buildRecord(input);

    // Q&A follow-up path — see askModuleQuestion() in src/lib/ai-report-modules.ts.
    // Grounded in the same record plus whatever analysis that module has already
    // generated (priorModuleData), not a fresh unrelated analysis.
    if (typeof input.question === "string" && input.question.trim()) {
      const priorText =
        input.priorModuleData != null
          ? `\n\nThis module's current analysis (already generated):\n${JSON.stringify(input.priorModuleData).slice(0, 4000)}`
          : "";
      const system =
        `${PREAMBLE}\n\nThe user is looking at the "${input.moduleId ?? "this"}" report module ` +
        "and asked a follow-up question about it. Answer directly in 2-4 sentences, grounded " +
        "only in the record and analysis below plus general knowledge of Texas commercial " +
        "property appraisal practice. If the answer genuinely isn't knowable from what's given, " +
        "say so rather than guessing.\n\nReturn ONLY a JSON object with exactly this shape:\n" +
        '{"answer": "<2-4 sentences>"}';
      const parsed = await generateJson(apiKey, system, [
        { text: `${record}${priorText}\n\nQuestion: ${input.question.trim().slice(0, 500)}` },
      ]);
      const answer = typeof parsed.answer === "string" ? parsed.answer.slice(0, 1200) : "";
      return new Response(JSON.stringify({ answer }), { status: 200, headers: corsHeaders });
    }

    const spec = input.moduleId ? MODULE_SPECS[input.moduleId] : undefined;
    if (!spec) {
      return new Response(JSON.stringify({ error: "unknown or missing moduleId" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    // Evidence images are only meaningful for the improvement-condition module —
    // filtered to real image/PDF data URLs and capped defensively even though the
    // client already caps at 4 (defense in depth, not trusting client-side limits).
    const evidenceParts =
      input.moduleId === "improvement" && Array.isArray(input.evidenceImages)
        ? input.evidenceImages
            .filter(
              (e): e is { mimeType: string; dataUrl: string } =>
                !!e.mimeType &&
                !!e.dataUrl &&
                (e.mimeType.startsWith("image/") || e.mimeType === "application/pdf"),
            )
            .slice(0, 4)
            .map((e) => ({
              inline_data: { mime_type: e.mimeType, data: e.dataUrl.split(",", 2)[1] ?? "" },
            }))
        : [];

    let instruction = spec.instruction;
    // Prose-only steering — see notApplicableContext's own comment above.
    // Only meaningful for the modules that write free-text findings/missing-
    // evidence lists about the whole case (site/improvement instead get the
    // hard, schema-level enforcement in enforceSiteFactorRealData /
    // enforceBuildingComponentRealData above).
    if (
      Array.isArray(input.notApplicableContext) &&
      input.notApplicableContext.length > 0 &&
      (input.moduleId === "strategy" ||
        input.moduleId === "evidence" ||
        input.moduleId === "executive")
    ) {
      instruction +=
        " The user has explicitly confirmed the following are not applicable to this property " +
        "or protest, because no such document/data exists to provide — treat them as excluded, " +
        "not as a missing item to chase, and do not recommend gathering them: " +
        input.notApplicableContext.join("; ");
    }
    if (evidenceParts.length > 0) {
      instruction +=
        " Photos and/or documents of the property's actual condition are attached below as " +
        "images — base your assessment specifically on what is visible or stated in them " +
        "(e.g. visible wear, deferred maintenance, damage, renovation quality), citing concrete " +
        "observations, rather than only general guidance. If something isn't visible or stated " +
        "in the attachments, say so rather than guessing.";
    }

    const system = `${PREAMBLE}\n\n${instruction}\n\nReturn ONLY a JSON object with exactly this shape:\n${spec.schema}`;

    const parsed = await generateJson(
      apiKey,
      system,
      [{ text: record }, ...evidenceParts],
      input.moduleId === "executive" ? 1536 : undefined,
    );
    const result = spec.parse(parsed ?? {});
    // Real-data enforcement for Module 4 — see enforceSiteFactorRealData's
    // own comment. Runs here, not inside spec.parse, because only the
    // handler has the original request input (input.siteGis).
    if (input.moduleId === "site") {
      (result as { factors: SiteFactor[] }).factors = enforceSiteFactorRealData(
        (result as { factors: SiteFactor[] }).factors,
        input.siteGis,
        Array.isArray(input.notApplicableFactors) ? input.notApplicableFactors : [],
      );
    }
    // Real-data enforcement for Module 5 — see
    // enforceBuildingComponentRealData's own comment. evidenceParts.length
    // (not input.evidenceImages.length) is the real signal: it's already
    // filtered down to only genuine image/PDF data URLs.
    if (input.moduleId === "improvement") {
      (result as { buildingComponents: BuildingComponent[] }).buildingComponents =
        enforceBuildingComponentRealData(
          (result as { buildingComponents: BuildingComponent[] }).buildingComponents,
          evidenceParts.length > 0,
          Array.isArray(input.notApplicableComponents) ? input.notApplicableComponents : [],
        );
    }
    // Real-data enforcement for Module 6 — see enforceZoningRealData. Runs
    // here (not in spec.parse) because only the handler has input.zoningData.
    if (input.moduleId === "zoning") {
      const z = enforceZoningRealData(result as ZoningResult, input.zoningData);
      (result as ZoningResult).aspects = z.aspects;
      (result as ZoningResult).matches = z.matches;
      (result as ZoningResult).discrepancies = z.discrepancies;
      (result as ZoningResult).valuationRelevance = z.valuationRelevance;
    }
    // Real-data enforcement for Module 7 — see enforceIncomeRealData. The AI
    // never produces a dollar figure or cap rate; when the owner-confirmed
    // figures or a cap rate are missing, the verdict is forced to
    // "inconclusive" and the narrative replaced with an honest "no data yet"
    // line. Runs here because only the handler has input.incomeFigures.
    if (input.moduleId === "income") {
      Object.assign(result as IncomeResult, enforceIncomeRealData(result as IncomeResult, input));
    }
    // Real-data enforcement for Module 3 — the model can only ever recommend
    // or judge a comp that was actually sent to it. Clamp every key it
    // returned to the input set, drop duplicates, and if it didn't produce
    // at least 3 usable recommendations fall back to the top-by-similarity
    // non-excluded keys the client already ranked (never invent one).
    if (input.moduleId === "comps") {
      const r = result as {
        recommendedKeys: string[];
        perComp: { key: string; verdict: "use" | "exclude"; reason: string }[];
      };
      const sent = Array.isArray(input.topComps) ? input.topComps : [];
      const validKeys = new Set(sent.map((c) => c.key));
      r.recommendedKeys = [...new Set(r.recommendedKeys.filter((k) => validKeys.has(k)))].slice(
        0,
        5,
      );
      const seen = new Set<string>();
      r.perComp = r.perComp.filter((pc) => {
        if (!validKeys.has(pc.key) || seen.has(pc.key)) return false;
        seen.add(pc.key);
        return true;
      });
      if (r.recommendedKeys.length < 3) {
        r.recommendedKeys = sent
          .filter((c) => !c.excluded)
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, 5)
          .map((c) => c.key);
      }
    }
    return new Response(JSON.stringify(result), { status: 200, headers: corsHeaders });
  } catch (err) {
    const errStatus = (err as { status?: number } | null)?.status;
    const status = errStatus === 429 || errStatus === 504 ? errStatus : 500;
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "unknown error" }),
      { status, headers: corsHeaders },
    );
  }
});
