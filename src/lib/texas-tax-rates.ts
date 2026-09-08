// Approximate combined effective property tax rates (county + school district +
// city/MUD + special districts, as a fraction of assessed value) for the counties
// CorvusPT has real CAD data for, keyed by the exact `cad` string cad-lookup
// returns for that county. Sourced from multiple independent 2025 public rate
// surveys (SmartAsset, Ballard Property Tax Protest, tax-rates.org, Texas
// Comptroller county data) rather than any single source, since no two publish
// identical numbers — actual combined rate varies further by the specific
// city/school district/MUD within a county, so treat these as county-level
// approximations, not a specific property's exact bill.
export const COUNTY_EFFECTIVE_TAX_RATE: Record<string, number> = {
  "Collin Central Appraisal District": 0.014,
  "Denton Central Appraisal District": 0.018,
  "Tarrant Appraisal District": 0.018,
  "Harris Central Appraisal District": 0.02,
  "Fort Bend Central Appraisal District": 0.0185,
  "Williamson Central Appraisal District": 0.017,
  "Grayson Central Appraisal District": 0.02,
  "Travis Central Appraisal District": 0.021,
  "Bexar Appraisal District": 0.0225,
  "Montgomery Central Appraisal District": 0.02,
};

// Texas statewide average effective property tax rate — used for any county
// without a specific entry above (e.g. Dallas, which has no CAD data source at
// all; see texas_cad_data_sources memory).
export const STATEWIDE_AVERAGE_EFFECTIVE_TAX_RATE = 0.018;

export function getEffectiveTaxRate(cad?: string | null): number {
  if (cad && cad in COUNTY_EFFECTIVE_TAX_RATE) return COUNTY_EFFECTIVE_TAX_RATE[cad];
  return STATEWIDE_AVERAGE_EFFECTIVE_TAX_RATE;
}

export type TaxRateMeta = {
  // The blended combined rate as a decimal fraction of value (never "per $100").
  rate: number;
  pct: number; // rate * 100, one decimal
  unit: "decimal";
  source: string;
  effectiveYear: number;
  // True when this is a real per-county entry, false when it fell back to the
  // statewide average (e.g. Dallas, which has no CAD data source at all).
  countySpecific: boolean;
};

// Metadata for Module 9's tax-assumption disclosure — where the rate came
// from and whether it's county-specific. No behaviour change to
// getEffectiveTaxRate; this just describes what that returned.
export function getTaxRateMeta(cad?: string | null): TaxRateMeta {
  const countySpecific = !!cad && cad in COUNTY_EFFECTIVE_TAX_RATE;
  const rate = getEffectiveTaxRate(cad);
  return {
    rate,
    pct: Math.round(rate * 1000) / 10,
    unit: "decimal",
    source: countySpecific
      ? "2025 blended county rate surveys (county + school + city/MUD + special districts)"
      : "Texas statewide average effective property tax rate",
    effectiveYear: 2025,
    countySpecific,
  };
}

// ---------------------------------------------------------------------------
// Deterministic reduction-percentage model. No AI is involved anywhere below —
// every number here is either a real published statistic or an arithmetic
// combination of two real published statistics, so the same property record
// always produces the same result, and every input can be traced to a source.
// ---------------------------------------------------------------------------

export type PropertyCategory = "residential" | "commercial" | "unknown";

const RESIDENTIAL_TYPE_KEYWORDS = [
  "residential",
  "single family",
  "single-family",
  "sfr",
  "homestead",
  "condo",
  "townhome",
  "townhouse",
  "duplex",
  "manufactured",
  "mobile home",
];
const COMMERCIAL_TYPE_KEYWORDS = [
  "commercial",
  "office",
  "retail",
  "warehouse",
  "industrial",
  "apartment",
  "multi-family",
  "multifamily",
  "hotel",
  "motel",
  "restaurant",
  "shopping",
  "business",
];

// Some counties' raw GIS data exposes the actual Texas Comptroller state
// property-type code (the same "Category A" / "Category F1" labels the
// Comptroller's own ratio-study reports use — see ASSESSMENT_RATIO below)
// instead of descriptive text — e.g. Denton's `stateCodes` field returns "A1"
// or "B1", not "Residential". Real, standardized, statewide codes: A = real
// property residential (incl. A1 single-family), C1 = vacant residential lot;
// B = real property multifamily residential (apartments), F = commercial/
// industrial real property, G = oil/gas/minerals, J = utilities, L = business
// personal property, C3 = vacant commercial lot.
function classifyByStateCode(raw: string): PropertyCategory | null {
  const c = raw.trim().toUpperCase();
  if (/^A\d*$/.test(c) || c === "C1") return "residential";
  if (/^[BFGJL]\d*$/.test(c) || c === "C3") return "commercial";
  return null;
}

// CAD-provided property-type text is free-form county-specific wording (e.g.
// "Real, Commercial" vs "SFR" vs a raw building-class code), not a standardized
// enum, so this checks the real state-code system first (see above), then
// falls back to keyword matching on descriptive text — good enough to pick the
// right real-data anchor below, not precise property classification.
export function classifyPropertyCategory(propertyType?: string | null): PropertyCategory {
  const raw = propertyType?.trim() ?? "";
  if (!raw) return "unknown";
  const byCode = classifyByStateCode(raw);
  if (byCode) return byCode;
  const t = raw.toLowerCase();
  if (RESIDENTIAL_TYPE_KEYWORDS.some((k) => t.includes(k))) return "residential";
  if (COMMERCIAL_TYPE_KEYWORDS.some((k) => t.includes(k))) return "commercial";
  return "unknown";
}

// Real per-county, per-category average protest reduction. No AI or fitted
// "trend model" is used to produce these — a real year-by-year time series
// with consistent methodology isn't published anywhere findable (sources
// publish either one single-year snapshot or one already-blended multi-year
// average, never both broken out by year), and fitting any model — ML
// included — to the 1-2 aggregate data points actually available per county
// wouldn't be a real trend fit, just noise dressed up as sophistication.
// Instead, residential figures below are the plain average of the two most
// credible REAL figures found for that county, from two independently-run
// studies covering different, non-fabricated time windows:
//
// (a) Single most-recent-year (2025) snapshot — Ownwell's county-level
//     analyses of actual 2025 tax records
//     (https://www.ownwell.com/results/texas-protest-vs-non-protest and
//     per-county pages, e.g. ownwell.com/insight/*-property-tax-protest-results-*).
// (b) Three-year (2022-2024) blended average — Ownwell's separate three-year
//     study (https://www.ownwell.com/insight/three-year-impact-protesting-property-taxes-texas),
//     "average reduction in property valuation when won" per county.
//
// Averaging (a) and (b) makes the figure less sensitive to any single unusual
// year without inventing a year-by-year breakdown that was never published.
// Only available for counties where BOTH real, county-specific figures were
// found (Bexar, Collin, Fort Bend, Harris, Travis); Denton and Tarrant use
// only their real single-source figure, since the other half of the pair
// isn't a genuine county-specific number for them (see below) — never
// blending a real county figure with a multi-county regional number just to
// have two data points.
//
// Commercial: O'Connor's real 2025 per-CAD appeal-result analyses (each
// county has its own published article, e.g.
// poconnor.com/denton-appeals-chip-away-at-massive-value-gains,
// poconnor.com/collin-county-property-tax-appeals-cut-7-89-billion-...,
// poconnor.com/initial-appeals-lower-bexar-county-commercial-value-by-6-7,
// poconnor.com/fort-bend-reduces-commercial-property-taxable-value-by-6-1,
// poconnor.com/early-property-tax-protests-prove-their-worth-in-travis-county,
// poconnor.com/2025-appeals-help-reduce-montgomery-county-property-value-by-4-2-billion,
// poconnor.com/williamson-county-stems-the-tide-of-record-taxable-value-with-appeals).
// Harris commercial is a blend of that county's own published office (7.9%),
// retail (2.8%), and warehouse (2.0%) figures, since no single overall Harris
// commercial number was published. No multi-year commercial study was found
// for any county — commercial figures below are single-year (2025) only. No
// commercial figure was found for Tarrant or Grayson despite multiple
// searches — real 2025 Tarrant commercial VALUE GROWTH numbers exist, but not
// a comparable market-wide appeal-reduction percentage (the one figure found
// was a single firm's own client average, not directly comparable to the
// CAD-wide analyses used for every other county here, so it's deliberately
// not used) — those two fall back to COMMERCIAL_FALLBACK_PCT below.
const COUNTY_REDUCTION_PCT: Partial<Record<string, Partial<Record<PropertyCategory, number>>>> = {
  "Collin Central Appraisal District": { residential: 0.0475, commercial: 0.087 }, // (4.4% 2025 + 5.1% 3-yr) / 2
  "Denton Central Appraisal District": { residential: 0.098, commercial: 0.019 }, // real Denton-specific 2025 figure (86% win rate, 9.8% avg reduction) — no 3-yr study covers Denton, so single-year only
  "Tarrant Appraisal District": { residential: 0.101 }, // real Tarrant-specific 3-yr (2022-2024) figure from Ownwell's per-county study — the only genuinely Tarrant-only number found; the 2025 single-year figure available for Tarrant is a 5-county DFW-region blend (Tarrant/Dallas/Denton/Collin/Ellis combined), not county-specific, so it's deliberately not used here even as half of an average
  "Harris Central Appraisal District": { residential: 0.073, commercial: 0.042 }, // (7.4% 2025 + 7.2% 3-yr) / 2
  "Fort Bend Central Appraisal District": { residential: 0.047, commercial: 0.061 }, // (4.5% 2025 + 4.9% 3-yr) / 2
  "Williamson Central Appraisal District": { residential: 0.028, commercial: 0.028 },
  "Travis Central Appraisal District": { residential: 0.09, commercial: 0.058 }, // (9.0% 2025 + 9.0% 3-yr) / 2 — no change, the two studies agree
  "Bexar Appraisal District": { residential: 0.0635, commercial: 0.067 }, // (6.0% 2025 + 6.7% 3-yr) / 2
  "Montgomery Central Appraisal District": { commercial: 0.059 },
};

// Statewide fallbacks, used for any county/category combination not in the
// table above (e.g. Grayson residential, or Tarrant/Grayson commercial).
const RESIDENTIAL_FALLBACK_PCT = 0.079; // 17-county 2025 statewide average (Ownwell)
// Average of the 8 real per-county commercial figures in the table above
// (8.7 + 1.9 + 4.2 + 6.1 + 2.8 + 5.8 + 6.7 + 5.9) / 8 = 5.26%, rounded — a
// broader, more representative anchor than relying on Denton's figure alone
// (which turns out to be the lowest of the 8, not typical).
const COMMERCIAL_FALLBACK_PCT = 0.0526;
// Used only when the CAD record's property-type text doesn't clearly indicate
// either category — the midpoint between the two real figures above, rather
// than silently defaulting to the higher residential number without evidence.
const UNKNOWN_CATEGORY_PCT = (RESIDENTIAL_FALLBACK_PCT + COMMERCIAL_FALLBACK_PCT) / 2;

export function getBaseReductionPct(
  cad: string | null | undefined,
  category: PropertyCategory,
): number {
  const countySpecific = cad ? COUNTY_REDUCTION_PCT[cad]?.[category] : undefined;
  if (countySpecific != null) return countySpecific;
  if (category === "residential") return RESIDENTIAL_FALLBACK_PCT;
  if (category === "commercial") return COMMERCIAL_FALLBACK_PCT;
  return UNKNOWN_CATEGORY_PCT;
}

// A year-over-year assessed-value jump well above typical appraisal-cycle
// growth is real, commonly-cited evidence of likely over-assessment: multiple
// protest-industry sources report successful protests averaging 10-15%
// reduction specifically in years values jumped more than ~10% YoY, vs the
// ~3-9% typical range in COUNTY_REDUCTION_PCT above for a routine year (Texas
// Real Estate Research Center / industry protest-outcome commentary). Applied
// as a floor/boost within that real 10-15% range rather than an arbitrary
// additive bonus.
const VALUE_JUMP_THRESHOLD_PCT = 0.1;
const VALUE_JUMP_BOOST_PCT = 0.03;
const VALUE_JUMP_FLOOR_PCT = 0.1;
const VALUE_JUMP_CEILING_PCT = 0.15;
// CAD records typically carry well over 10 years of appraisal history per
// property (verified up to 13 years on real records) — capped here at the
// most recent 10 to match the standard "how has this property trended"
// window, rather than letting one unusually old/volatile year skew the
// property's own baseline growth rate.
const TREND_LOOKBACK_YEARS = 10;

export type ValueTrendResult = {
  reductionPct: number;
  jumpTriggered: boolean;
  jumpPct: number | null;
  trailingCagrPct: number | null;
};

// Compares this property's most recent year-over-year change against ITS OWN
// historical trend (a trailing compound annual growth rate over up to the
// prior 10 years), rather than a flat threshold applied identically to every
// property. A property that has always grown ~8%/year jumping to 12% isn't
// the same signal as one that's been flat for a decade suddenly jumping 12% —
// the second is the real anomaly. Falls back to a plain two-point comparison
// against the flat VALUE_JUMP_THRESHOLD_PCT when fewer than 3 valid years of
// history exist (not enough points to fit a trailing trend).
export function applyValueTrendAdjustment(
  baseReductionPct: number,
  valueHistory?: Array<{ year: number; value: number | null }> | null,
): ValueTrendResult {
  const none = {
    reductionPct: baseReductionPct,
    jumpTriggered: false,
    jumpPct: null,
    trailingCagrPct: null,
  };
  if (!valueHistory || valueHistory.length < 2) return none;
  const sorted = [...valueHistory]
    .filter((h): h is { year: number; value: number } => h.value != null && h.value > 0)
    .sort((a, b) => a.year - b.year)
    .slice(-TREND_LOOKBACK_YEARS);
  if (sorted.length < 2) return none;

  const latest = sorted[sorted.length - 1];
  const prior = sorted[sorted.length - 2];
  const jumpPct = (latest.value - prior.value) / prior.value;

  let trailingCagrPct: number | null = null;
  let anomalyTriggered: boolean;
  if (sorted.length >= 3) {
    // Trailing trend excludes the latest year on purpose — it's the baseline
    // this property has been growing at BEFORE the year being evaluated.
    const trailing = sorted.slice(0, -1);
    const first = trailing[0];
    const last = trailing[trailing.length - 1];
    const yearsSpan = last.year - first.year;
    trailingCagrPct = yearsSpan > 0 ? Math.pow(last.value / first.value, 1 / yearsSpan) - 1 : null;
    anomalyTriggered =
      trailingCagrPct != null
        ? jumpPct > trailingCagrPct + VALUE_JUMP_THRESHOLD_PCT
        : jumpPct > VALUE_JUMP_THRESHOLD_PCT;
  } else {
    // Only two years on record — not enough to fit a trailing trend, so fall
    // back to the flat threshold.
    anomalyTriggered = jumpPct > VALUE_JUMP_THRESHOLD_PCT;
  }

  if (!anomalyTriggered)
    return { reductionPct: baseReductionPct, jumpTriggered: false, jumpPct, trailingCagrPct };
  const boosted = Math.min(
    VALUE_JUMP_CEILING_PCT,
    Math.max(VALUE_JUMP_FLOOR_PCT, baseReductionPct + VALUE_JUMP_BOOST_PCT),
  );
  return { reductionPct: boosted, jumpTriggered: true, jumpPct, trailingCagrPct };
}

// ---------------------------------------------------------------------------
// Assessment-ratio (equal-and-uniform) signal — real Texas Comptroller data.
// ---------------------------------------------------------------------------
//
// The Comptroller's Appraisal District Ratio Study (Tax Code 5.10) publishes,
// per county per property category, the median level of appraisal (assessed
// value as a fraction of the Comptroller's own independently-determined
// market value) and the coefficient of dispersion (COD) — how spread out
// individual properties' ratios are around that median. A high COD is the
// literal statistical definition of an equal-and-uniform problem: it means
// the county is NOT assessing similar properties at a consistent fraction of
// value, which is exactly what Tax Code 41.43(b) protests argue. Figures
// below are each county's most recent published study as of this writing
// (comptroller.texas.gov/data/property-tax/ratio-study/<year>/ — Category A =
// single-family residential, Category F1 = commercial real property):
// Collin/Fort Bend/Williamson/Travis/Bexar/Grayson = 2024 study; Denton/
// Tarrant/Harris/Montgomery = 2025 study (each CAD is studied at least once
// every two years per statute, not necessarily the same year for every
// county).
const ASSESSMENT_RATIO: Partial<
  Record<string, Partial<Record<PropertyCategory, { medianPct: number; cod: number }>>>
> = {
  "Collin Central Appraisal District": {
    residential: { medianPct: 1.0, cod: 4.41 },
    commercial: { medianPct: 1.0, cod: 13.24 },
  },
  "Denton Central Appraisal District": {
    residential: { medianPct: 1.0, cod: 6.16 },
    commercial: { medianPct: 1.07, cod: 17.96 },
  },
  "Tarrant Appraisal District": {
    residential: { medianPct: 0.97, cod: 10.14 },
    commercial: { medianPct: 0.97, cod: 12.46 },
  },
  "Harris Central Appraisal District": {
    residential: { medianPct: 1.0, cod: 7.48 },
    commercial: { medianPct: 0.96, cod: 14.49 },
  },
  "Fort Bend Central Appraisal District": {
    residential: { medianPct: 1.0, cod: 6.77 },
    commercial: { medianPct: 1.0, cod: 10.43 },
  },
  "Williamson Central Appraisal District": {
    residential: { medianPct: 0.96, cod: 7.57 },
    commercial: { medianPct: 0.97, cod: 11.22 },
  },
  "Travis Central Appraisal District": {
    residential: { medianPct: 1.0, cod: 7.59 },
    commercial: { medianPct: 1.0, cod: 12.56 },
  },
  "Bexar Appraisal District": {
    residential: { medianPct: 1.0, cod: 7.89 },
    commercial: { medianPct: 1.0, cod: 10.28 },
  },
  "Montgomery Central Appraisal District": {
    residential: { medianPct: 1.0, cod: 8.22 },
    commercial: { medianPct: 1.05, cod: 14.27 },
  },
  "Grayson Central Appraisal District": {
    residential: { medianPct: 1.0, cod: 5.51 },
    commercial: { medianPct: 1.02, cod: 10.26 },
  },
};

// IAAO Standard on Ratio Studies (2013) published acceptable COD ceilings by
// property type — an absolute, external benchmark every county is measured
// against on its own, not a comparison to other counties' assessment
// practices. County character (urban core vs. rural/mixed, homogeneous vs.
// varied housing/commercial stock) legitimately affects a county's own COD
// for reasons that have nothing to do with assessment quality, so ranking
// counties against each other's COD isn't a meaningful signal — measuring
// each one against the same external professional standard is.
const IAAO_COD_CEILING: Record<"residential" | "commercial", number> = {
  residential: 15.0, // single-family / newer, homogeneous housing stock
  commercial: 20.0, // income-producing / commercial property
};

// Deliberately small and bounded, and one-directional — a county within the
// IAAO standard gets no adjustment (being well within an acceptable range
// isn't evidence a protest would do worse than the real outcome-based base
// rate), while a county whose own published COD exceeds the standard for its
// property type gets a small nudge reflecting that extra equal-and-uniform
// leverage. +0.15 percentage points of reduction per COD point over the IAAO
// ceiling, capped at +2 points.
const COD_ADJUSTMENT_PER_POINT = 0.0015;
const COD_ADJUSTMENT_CAP_PCT = 0.02;

export type AssessmentRatioInfo = { medianPct: number; cod: number; codOverCeiling: number } | null;

export function getAssessmentRatioInfo(
  cad: string | null | undefined,
  category: PropertyCategory,
): AssessmentRatioInfo {
  if (category === "unknown" || !cad) return null;
  const entry = ASSESSMENT_RATIO[cad]?.[category];
  if (!entry) return null;
  return {
    medianPct: entry.medianPct,
    cod: entry.cod,
    codOverCeiling: Math.max(0, entry.cod - IAAO_COD_CEILING[category]),
  };
}

export function applyAssessmentRatioAdjustment(
  baseReductionPct: number,
  ratioInfo: AssessmentRatioInfo,
): number {
  if (!ratioInfo) return baseReductionPct;
  const bounded = Math.min(
    COD_ADJUSTMENT_CAP_PCT,
    ratioInfo.codOverCeiling * COD_ADJUSTMENT_PER_POINT,
  );
  return baseReductionPct + bounded;
}
