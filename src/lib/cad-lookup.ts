import { invokeEdgeFunction } from "./edge-functions";

export type CadDeed = {
  date: string | null;
  type: string | null;
  description: string | null;
  seller: string | null;
  buyer: string | null;
  instrumentNum: string | null;
};

export type CadValueHistoryEntry = {
  year: number;
  landValue: number | null;
  improvementValue: number | null;
  marketValue: number | null;
  appraisedValue: number | null;
};

export type CadRecord = {
  ownerName: string | null;
  propertyAddress: string;
  cad: string;
  accountNumber: string | null;
  propertyType: string | null;
  landValue: number | null;
  improvementValue: number | null;
  totalValue: number | null;
  taxYear: number | null;
  // Only populated for the counties whose public site exposes a real JSON API
  // (Denton, Montgomery, Tarrant, Travis, Fort Bend, Grayson) — see
  // texas_cad_vendor_landscape memory for why the other 5 counties can't offer this.
  legalDescription?: string | null;
  subdivision?: string | null;
  geoId?: string | null;
  mailingAddress?: string | null;
  ownershipPct?: number | null;
  protestStatus?: string | null;
  // Fort Bend only — see the matching comment in supabase/functions/
  // cad-lookup/index.ts and cad-record-url.ts's getCadRecordUrl().
  bisPropertyId?: string | null;
  valueHistory?: CadValueHistoryEntry[];
  deeds?: CadDeed[];
  // Structure / lot detail — only populated for the counties whose parcel
  // layer actually publishes it (Denton, Collin, Tarrant, Fort Bend, Williamson
  // for building data; Harris/Travis/Grayson for lot size only — verified live
  // against each ArcGIS layer's metadata). Null everywhere else; never
  // fabricated. See applyStructureDetail() in supabase/functions/cad-lookup.
  buildingSqft?: number | null;
  yearBuilt?: number | null;
  buildingClass?: string | null;
  lotSizeSqft?: number | null;
  lotSizeAcres?: number | null;
};

// nearby: real parcels on the same street (any house number), from the same
// county sources — never fabricated — surfaced only when the exact match
// failed and there was a real city to filter by. Empty when there's nothing
// real to suggest (e.g. the address is in one of the many Texas counties
// this app has no data source for at all).
//
// matched: "multiple" — the exact house-number+street match itself resolved
// to more than one REAL, distinct CAD account (different accountNumber),
// not a "no exact match, try something nearby" situation. Confirmed real
// live: a single strip-center-style civic address ("11400 Culebra, San
// Antonio") covers two separate legal parcels on the same county block —
// one a day care (PINNACLE MONTESSORI OF ALAMO RANCH LLC), one a strip
// center (AVIGHNA HOLDINGS LLC) — with completely different owners. Picking
// either one silently (the old behavior) shows the wrong legal owner for
// whichever the tiebreak didn't happen to land on, with no way for the user
// to even notice, let alone correct it — a real trust problem for a report
// this app's own Protest Authorization flow treats as authoritative.
export type CadLookupResult =
  | { matched: false; nearby: CadRecord[] }
  | { matched: true; record: CadRecord }
  | { matched: "multiple"; options: CadRecord[] };

export async function cadLookup(address: string): Promise<CadLookupResult> {
  return invokeEdgeFunction<CadLookupResult>("cad-lookup", { address });
}

// A direct, exact lookup by account/parcel number for a single named county —
// bypasses address parsing entirely (see queryByAccountNumber's own comment
// in the edge function). Used by the "Didn't find your property? Enter
// account number and county" fallback on the address-search "not found" step.
// No "nearby"/"multiple" branch here — an account number is either a real
// exact match for that one county or it isn't.
export async function cadLookupByAccount(
  cad: string,
  accountNumber: string,
): Promise<CadRecord | null> {
  const res = await invokeEdgeFunction<{ matched: boolean; record: CadRecord | null }>(
    "cad-lookup",
    { cad, accountNumber },
  );
  return res.matched ? res.record : null;
}
