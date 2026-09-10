// Deterministic, no-AI comparable-property analysis for the Market Value
// module (see ai-report.tsx's "comps" case). Every input here is a real field
// already returned by cad-comps (see supabase/functions/cad-comps/index.ts) —
// nothing here is fabricated, and nothing claims a sale price or building
// square footage, since neither is available from any free Texas source
// (Texas is a non-disclosure state; confirmed by inspecting the CAD's own
// public deed records, which carry a date/type/buyer/seller but no price).
import type { CompProperty } from "./cad-comps";

const EARTH_RADIUS_MILES = 3958.8;

// Real great-circle distance between two lat/lng points — plain math, not a
// second API call.
export function haversineMiles(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(Math.min(1, h)));
}

// 100 at diff=0, decays to ~50 at diff=halfScale, approaches 0 for large
// diff — an exponential half-life curve rather than a hard cutoff, so a comp
// just past a threshold doesn't fall off a cliff relative to one just before it.
function decayScore(diff: number, halfScale: number): number {
  if (!Number.isFinite(diff) || halfScale <= 0) return 50;
  return 100 * Math.exp((-Math.LN2 * Math.abs(diff)) / halfScale);
}

// A stable id for a comp across the whole Module 3 flow: the CAD pid as a
// string for a fetched comp, or "user:<uuid>" for one the user added (see
// comp-selections.ts). Used to match a comp to an exclude mark and to the
// AI's per-comp recommendations.
export function compKeyOf(c: { pid: number }): string {
  return String(c.pid);
}

// A comp the user added by hand or from an uploaded sale document — the real
// figures that get merged into the ranking pool alongside CAD comps.
export type ExtraComp = {
  key: string; // "user:<uuid>"
  address: string | null;
  latitude: number;
  longitude: number;
  salePrice: number | null;
  saleDate: string | null;
  landSqft: number | null;
  buildingSqft: number | null;
  source: string | null;
  saleVerified: boolean;
};

export type RankedComp = CompProperty & {
  distanceMi: number;
  similarity: number;
  // The 6 sub-scores + reliability adjustments behind `similarity` — shown
  // in the modal so the ranking is explainable, and fed to the Ask-AI
  // context.
  breakdown: SimilarityBreakdown;
  // Deterministic "unusual / less reliable" flags (see compFlags).
  flags: string[];
  key: string;
  // Set when the user has excluded this comp — kept in `ranked` so the table
  // can still show it (struck through), but left out of the indicated value,
  // gap and confidence math.
  excluded?: boolean;
  // Populated only for a user-added comp (ExtraComp) — a CAD comp has no
  // verifiable sale in a non-disclosure state.
  salePrice?: number | null;
  saleDate?: string | null;
  buildingSqft?: number | null;
  pricePerSqft?: number | null;
  saleVerified?: boolean;
  userAdded?: boolean;
};

type ComputeOpts = {
  // CAD pids (as strings) the user has excluded from the value math.
  excludedKeys?: Set<string>;
  // Comps the user added — merged into the pool before ranking.
  extraComps?: ExtraComp[];
  // The subject's own gross building area, when known — enables a $/SF
  // (improved-property) unit basis instead of $/acre. Absent for CAD-only
  // data, which carries no building SF.
  subjectBuildingSqft?: number | null;
  // The subject's own year-over-year assessed-value trend as a whole-number
  // % (from buildValueTrend / value history) — the basis for the time
  // adjustment. Absent → no time adjustment anywhere.
  subjectTrendPctPerYear?: number | null;
};

// How similar a comp is to the subject, 0-100. Four proximity signals form
// the base (value, distance, size, use), each neutral-50 when a field is
// missing on either side — never a fabricated value or a penalty for absent
// data. Then two reliability signals adjust it: a mild recency multiplier
// (a stale dated sale is worth less) and a small reliability bump/penalty
// (a verified closing-statement sale ranks above an equity comp; an
// unverified hand-typed price ranks below one). Absence of a date or a
// verification flag never moves the score.
export type SimilarityBreakdown = {
  value: number;
  distance: number;
  size: number;
  use: number;
  base: number;
  recencyMult: number;
  reliabilityAdj: number;
  score: number;
};

type SimilarityMeta = {
  verified?: boolean;
  userAdded?: boolean;
  // building SF on each side, when known — lets `size` compare floor area
  // instead of lot acreage for improved property.
  subjectBuildingSqft?: number | null;
  compBuildingSqft?: number | null;
};

function yearsSince(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return null;
  const yrs = (Date.now() - t) / (365.25 * 24 * 60 * 60 * 1000);
  return yrs >= 0 ? yrs : null;
}

export function similarityBreakdown(
  subject: CompProperty,
  comp: CompProperty,
  meta: SimilarityMeta = {},
): SimilarityBreakdown {
  const distanceMi = haversineMiles(subject, comp);
  const distance = decayScore(distanceMi, 0.4);

  const value =
    subject.marketValue && comp.marketValue
      ? decayScore(Math.abs(comp.marketValue - subject.marketValue) / subject.marketValue, 0.15)
      : 50;

  // Prefer building SF when both sides have it (improved property), else lot
  // acreage, else neutral.
  const size =
    meta.subjectBuildingSqft && meta.compBuildingSqft
      ? decayScore(
          Math.abs(meta.compBuildingSqft - meta.subjectBuildingSqft) / meta.subjectBuildingSqft,
          0.4,
        )
      : subject.legalAcreage && comp.legalAcreage
        ? decayScore(Math.abs(comp.legalAcreage - subject.legalAcreage) / subject.legalAcreage, 0.4)
        : 50;

  const use =
    subject.propType && comp.propType ? (subject.propType === comp.propType ? 100 : 35) : 50;

  const base = value * 0.35 + distance * 0.3 + size * 0.2 + use * 0.15;

  // Recency: only a dated sale can be stale. 0-1 yr → ~1.0, ~4 yr → ~0.87,
  // ~10 yr → ~0.78. No date → no effect.
  const yrs = yearsSince(comp.lastTransferDt);
  const recencyMult = yrs == null ? 1 : Math.max(0.75, 0.75 + 0.25 * (decayScore(yrs, 4) / 100));

  // Reliability: verified sale +4, unverified hand-typed price −8, CAD
  // equity comp 0. Absence of the meta (existing callers) → 0.
  const reliabilityAdj = meta.verified ? 4 : meta.userAdded && meta.verified === false ? -8 : 0;

  const score = Math.round(Math.max(0, Math.min(100, base * recencyMult + reliabilityAdj)));
  return { value, distance, size, use, base, recencyMult, reliabilityAdj, score };
}

export function similarityScore(
  subject: CompProperty,
  comp: CompProperty,
  meta: SimilarityMeta = {},
): number {
  return similarityBreakdown(subject, comp, meta).score;
}

// Deterministic "this comp is unusual / less reliable" flags — plain reads
// of the real fields, never a guess. The AI adds concerns these can't see
// (portfolio sales, related parties, atypical financing) in its per-comp
// reason.
export function compFlags(
  subject: CompProperty | null,
  c: RankedComp,
  medianDistanceMi: number,
): string[] {
  const flags: string[] = [];
  const yrs = yearsSince(c.saleDate ?? c.lastTransferDt);
  if (yrs != null && yrs > 3) flags.push("Stale");
  const distCap = Math.max(3, medianDistanceMi * 2);
  if (c.distanceMi > distCap) flags.push("Distant");
  const sizeBase = c.userAdded ? c.buildingSqft : c.legalAcreage;
  const subjSize = c.userAdded ? null : (subject?.legalAcreage ?? null);
  if (sizeBase != null && subjSize != null && subjSize > 0) {
    if (Math.abs(sizeBase - subjSize) / subjSize > 0.5) flags.push("Size mismatch");
  }
  if (subject?.propType && c.propType && subject.propType !== c.propType) {
    flags.push("Type mismatch");
  }
  if (c.userAdded && !c.saleVerified) flags.push("Unverified price");
  if (!c.userAdded) flags.push("Not a market sale");
  return flags;
}

// One comp's normalization on the way to the reconciled indicated value.
export type CompAdjustment = {
  key: string;
  // "$/acre" | "$/SF" | "raw" — which unit the comp was reduced to.
  unitBasis: "acre" | "sqft" | "raw";
  // The comp's own value expressed in that unit ($/acre or $/SF), or the
  // raw value when there's no size on either side.
  unitRate: number;
  // unitRate × the subject's own size — the comp restated at the subject's
  // scale.
  sizeAdjValue: number;
  // Market-trend time adjustment applied (whole-number %), only for a comp
  // with a real dated sale; 0 for a CAD equity comp (deed date is not a
  // verified sale).
  timeAdjPct: number;
  // sizeAdjValue × (1 + timeAdjPct/100) — the comp's final indicated value.
  adjustedValue: number;
};

export type ComparableStats = {
  indicated: { min: number; median: number; max: number } | null;
  // The similarity-weighted reconciliation of the per-comp adjusted values
  // — the headline indicated value once size and time are normalized.
  // Falls back to null (and the UI uses `indicated`) when there aren't
  // enough size-bearing comps to adjust.
  adjustedIndicated: { value: number; min: number; max: number } | null;
  perCompAdjustment: CompAdjustment[];
  subjectValue: number | null;
  // (subjectValue - indicated.median) / indicated.median, as a whole-number
  // percent — positive means the subject's assessed value sits above what
  // the comps indicate (a potential overvaluation).
  valuationGapPct: number | null;
  confidencePct: number | null;
  // True when there are fewer than MIN_USABLE_COMPS comps with a real
  // market value — the UI should show "Limited Comparable Data" and fall
  // back to other valuation methods rather than trust a number this thin.
  limitedData: boolean;
  ranked: RankedComp[];
};

const MIN_USABLE_COMPS = 3;
const TOP_N_FOR_INDICATED_VALUE = 5;

// Same honest 35-95 bounding success-probability.ts uses for its own
// derived (not AI-guessed) confidence score — never claims near-certainty
// or near-impossibility regardless of how count/spread stack up.
const MIN_CONFIDENCE_PCT = 35;
const MAX_CONFIDENCE_PCT = 95;

// Maps a user-added comp to the CompProperty shape similarityScore() reads —
// its sale price stands in for market value, its lot size (converted from
// square feet) for legalAcreage. No property-type code, so typeScore lands on
// its neutral 50.
function extraToCompProperty(e: ExtraComp): CompProperty {
  return {
    pid: 0,
    address: e.address ?? "",
    latitude: e.latitude,
    longitude: e.longitude,
    marketValue: e.salePrice,
    ownerName: null,
    legalAcreage: e.landSqft != null ? e.landSqft / 43560 : null,
    landValue: null,
    improvementValue: null,
    appraisedValue: null,
    lastTransferDt: e.saleDate,
    propType: null,
    zoning: null,
  };
}

export function computeComparableStats(
  subject: CompProperty | null,
  comps: CompProperty[],
  subjectTotalValue: number | null | undefined,
  opts: ComputeOpts = {},
): ComparableStats {
  const excludedKeys = opts.excludedKeys ?? new Set<string>();
  const extraComps = opts.extraComps ?? [];

  const subjBuildingSqft = opts.subjectBuildingSqft ?? null;

  let ranked: RankedComp[] = subject
    ? [
        ...comps.map((c) => {
          const key = compKeyOf(c);
          const breakdown = similarityBreakdown(subject, c);
          return {
            ...c,
            distanceMi: haversineMiles(subject, c),
            similarity: breakdown.score,
            breakdown,
            flags: [] as string[],
            key,
            excluded: excludedKeys.has(key) || undefined,
          };
        }),
        ...extraComps.map((e) => {
          const cp = extraToCompProperty(e);
          const breakdown = similarityBreakdown(subject, cp, {
            verified: e.saleVerified,
            userAdded: true,
            subjectBuildingSqft: subjBuildingSqft,
            compBuildingSqft: e.buildingSqft,
          });
          return {
            ...cp,
            distanceMi: haversineMiles(subject, cp),
            similarity: breakdown.score,
            breakdown,
            flags: [] as string[],
            key: e.key,
            excluded: excludedKeys.has(e.key) || undefined,
            salePrice: e.salePrice,
            saleDate: e.saleDate,
            buildingSqft: e.buildingSqft,
            pricePerSqft:
              e.salePrice != null && e.buildingSqft != null && e.buildingSqft > 0
                ? Math.round(e.salePrice / e.buildingSqft)
                : null,
            saleVerified: e.saleVerified,
            userAdded: true as const,
          };
        }),
      ].sort((a, b) => b.similarity - a.similarity)
    : [];

  // Deterministic per-comp flags, using the median comp distance as the
  // "distant" yardstick.
  {
    const dists = ranked.map((c) => c.distanceMi).sort((a, b) => a - b);
    const medianDist = dists.length ? dists[Math.floor(dists.length / 2)] : 0;
    ranked = ranked.map((c) => ({ ...c, flags: compFlags(subject, c, medianDist) }));
  }

  const usable = ranked.filter((c) => c.marketValue != null && !c.excluded);
  const limitedData = usable.length < MIN_USABLE_COMPS;
  const subjectValue = subjectTotalValue ?? subject?.marketValue ?? null;

  if (usable.length === 0) {
    return {
      indicated: null,
      adjustedIndicated: null,
      perCompAdjustment: [],
      subjectValue,
      valuationGapPct: null,
      confidencePct: null,
      limitedData: true,
      ranked,
    };
  }

  const top = usable.slice(0, TOP_N_FOR_INDICATED_VALUE);
  const values = top.map((c) => c.marketValue as number).sort((a, b) => a - b);
  const min = values[0];
  const max = values[values.length - 1];
  const median = values[Math.floor(values.length / 2)];

  // ── Adjustment layer: normalize each `top` comp to the subject's scale on
  // size, then time-adjust a real dated sale by the subject's own
  // assessed-value trend (capped ±15%), then reconcile similarity-weighted.
  const subjAcres = subject?.legalAcreage ?? null;
  const trendPerYear = opts.subjectTrendPctPerYear ?? null;
  const perCompAdjustment: CompAdjustment[] = top.map((c) => {
    const raw = c.marketValue as number;
    let unitBasis: CompAdjustment["unitBasis"] = "raw";
    let unitRate = raw;
    let sizeAdjValue = raw;
    if (subjBuildingSqft && c.userAdded && c.buildingSqft && c.buildingSqft > 0) {
      unitBasis = "sqft";
      unitRate = raw / c.buildingSqft;
      sizeAdjValue = unitRate * subjBuildingSqft;
    } else if (subjAcres && subjAcres > 0 && c.legalAcreage && c.legalAcreage > 0) {
      unitBasis = "acre";
      unitRate = raw / c.legalAcreage;
      sizeAdjValue = unitRate * subjAcres;
    }
    // Time: only a real dated sale (a user-added comp with a saleDate) gets
    // adjusted — a CAD comp's deed date is not a verified market sale.
    let timeAdjPct = 0;
    if (trendPerYear != null && c.userAdded && c.saleDate) {
      const yrs = yearsSince(c.saleDate);
      if (yrs != null) timeAdjPct = Math.max(-15, Math.min(15, Math.round(trendPerYear * yrs)));
    }
    const adjustedValue = Math.round(sizeAdjValue * (1 + timeAdjPct / 100));
    return {
      key: c.key,
      unitBasis,
      unitRate: Math.round(unitRate),
      sizeAdjValue: Math.round(sizeAdjValue),
      timeAdjPct,
      adjustedValue,
    };
  });

  // Only reconcile when at least half the top comps actually got a size
  // basis (otherwise "adjusted" would just echo the raw values).
  const sizeAdjusted = perCompAdjustment.filter((a) => a.unitBasis !== "raw");
  let adjustedIndicated: ComparableStats["adjustedIndicated"] = null;
  if (sizeAdjusted.length >= Math.max(2, Math.ceil(top.length / 2))) {
    const wSum = top.reduce((s, c) => s + Math.max(1, c.similarity), 0);
    const weighted =
      top.reduce(
        (s, c, i) => s + perCompAdjustment[i].adjustedValue * Math.max(1, c.similarity),
        0,
      ) / wSum;
    const adjValues = perCompAdjustment.map((a) => a.adjustedValue).sort((x, y) => x - y);
    adjustedIndicated = {
      value: Math.round(weighted),
      min: adjValues[0],
      max: adjValues[adjValues.length - 1],
    };
  }

  const headlineMedian = adjustedIndicated?.value ?? median;
  const valuationGapPct =
    subjectValue != null && headlineMedian > 0
      ? Math.round(((subjectValue - headlineMedian) / headlineMedian) * 100)
      : null;

  // More comps + a tighter spread + more verified sales -> higher
  // confidence; all three are real derived signals, not an AI guess.
  const spreadRatio = headlineMedian > 0 ? (max - min) / headlineMedian : 1;
  const countScore = Math.min(1, usable.length / 8);
  const tightnessScore = Math.max(0, 1 - spreadRatio);
  const verifiedShare =
    top.length > 0 ? top.filter((c) => c.userAdded && c.saleVerified).length / top.length : 0;
  const confidencePct = limitedData
    ? null
    : Math.round(
        MIN_CONFIDENCE_PCT +
          (MAX_CONFIDENCE_PCT - MIN_CONFIDENCE_PCT) *
            (countScore * 0.4 + tightnessScore * 0.4 + verifiedShare * 0.2),
      );

  return {
    indicated: { min, median, max },
    adjustedIndicated,
    perCompAdjustment,
    subjectValue,
    valuationGapPct,
    confidencePct,
    limitedData,
    ranked,
  };
}
