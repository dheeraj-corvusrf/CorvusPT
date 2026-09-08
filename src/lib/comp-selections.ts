import { supabase } from "./supabase";
import { invokeEdgeFunction } from "./edge-functions";
import type { ExtraComp } from "./comps-analysis";

export type CompSaleExtraction = {
  address: string | null;
  salePrice: number | null;
  saleDate: string | null;
  buildingSqft: number | null;
  landSqft: number | null;
  source: string | null;
  confidence: number;
  notes: string | null;
  documentId: string;
};

// Reads a closing statement / settlement statement / purchase contract / fee
// appraisal the user uploaded and pulls the sale facts printed on it, to
// pre-fill the "Add a comparable" form. See
// supabase/functions/extract-comp-sale/index.ts — nothing is written; the
// user confirms the figures before the comp is saved (as a verified comp).
export async function extractCompSale(documentId: string): Promise<CompSaleExtraction> {
  return invokeEdgeFunction<CompSaleExtraction>("extract-comp-sale", { documentId });
}

// Per-property comparable-sales selection for Module 3 (Market Value). A row
// exists only for a comp the user has actually touched:
//
//  - a CAD comp they excluded from the indicated-value math:
//    { compKey: "<cad pid>", action: "exclude" }  — every other field null
//  - a comp they added by hand or from an uploaded sale document:
//    { compKey: "user:<uuid>", action: "include", address, latitude, ... }
//
// Ranking / indicated value / gap / confidence stay deterministic in
// comps-analysis.ts — this only decides which comps feed that math. Mirrors
// module-overrides.ts (module_data_overrides), which does the same job for the
// "not applicable" marks on Modules 4/5/7.
export type CompSelection = {
  compKey: string;
  action: "exclude" | "include";
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  salePrice: number | null;
  saleDate: string | null;
  landSqft: number | null;
  buildingSqft: number | null;
  source: string | null;
  notes: string | null;
  // True only when the figures came from a document the user uploaded
  // (sourceDocumentId) — never from an unverifiable source, since Texas is a
  // non-disclosure state. Drives the "Sale Price Not Verified" label.
  saleVerified: boolean;
  sourceDocumentId: string | null;
};

type CompSelectionRow = {
  comp_key: string;
  action: "exclude" | "include";
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  sale_price: number | null;
  sale_date: string | null;
  land_sqft: number | null;
  building_sqft: number | null;
  source: string | null;
  notes: string | null;
  sale_verified: boolean;
  source_document_id: string | null;
};

function fromRow(r: CompSelectionRow): CompSelection {
  return {
    compKey: r.comp_key,
    action: r.action,
    address: r.address,
    latitude: r.latitude,
    longitude: r.longitude,
    salePrice: r.sale_price,
    saleDate: r.sale_date,
    landSqft: r.land_sqft,
    buildingSqft: r.building_sqft,
    source: r.source,
    notes: r.notes,
    saleVerified: r.sale_verified,
    sourceDocumentId: r.source_document_id,
  };
}

const SELECT_COLUMNS =
  "comp_key, action, address, latitude, longitude, sale_price, sale_date, land_sqft, building_sqft, source, notes, sale_verified, source_document_id";

// Every comp selection for one property — the caller (Module 3's view) splits
// these into excluded CAD keys and user-added comps itself.
export async function listCompSelections(propertyId: string): Promise<CompSelection[]> {
  const { data, error } = await supabase
    .from("comp_selections")
    .select(SELECT_COLUMNS)
    .eq("property_id", propertyId);
  if (error) throw error;
  return (data ?? []).map((r) => fromRow(r as CompSelectionRow));
}

export type CompSelectionInput = {
  compKey: string;
  action: "exclude" | "include";
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  salePrice?: number | null;
  saleDate?: string | null;
  landSqft?: number | null;
  buildingSqft?: number | null;
  source?: string | null;
  notes?: string | null;
  saleVerified?: boolean;
  sourceDocumentId?: string | null;
};

export async function upsertCompSelection(
  userId: string,
  propertyId: string,
  sel: CompSelectionInput,
): Promise<void> {
  const { error } = await supabase.from("comp_selections").upsert(
    {
      user_id: userId,
      property_id: propertyId,
      comp_key: sel.compKey,
      action: sel.action,
      address: sel.address ?? null,
      latitude: sel.latitude ?? null,
      longitude: sel.longitude ?? null,
      sale_price: sel.salePrice ?? null,
      sale_date: sel.saleDate ?? null,
      land_sqft: sel.landSqft ?? null,
      building_sqft: sel.buildingSqft ?? null,
      source: sel.source ?? null,
      notes: sel.notes ?? null,
      sale_verified: sel.saleVerified ?? false,
      source_document_id: sel.sourceDocumentId ?? null,
    },
    { onConflict: "property_id,comp_key" },
  );
  if (error) throw error;
}

export async function deleteCompSelection(propertyId: string, compKey: string): Promise<void> {
  const { error } = await supabase
    .from("comp_selections")
    .delete()
    .eq("property_id", propertyId)
    .eq("comp_key", compKey);
  if (error) throw error;
}

// The CAD pids the user has excluded, as a Set of strings — the shape
// computeComparableStats() takes for its `excludedKeys` option.
export function excludedCompKeys(selections: CompSelection[]): Set<string> {
  return new Set(selections.filter((s) => s.action === "exclude").map((s) => s.compKey));
}

// The comps the user added by hand / from a document, mapped to the
// ExtraComp shape computeComparableStats() merges into the ranking pool.
// Skips any without real coordinates — the ranking math needs lat/lng, and a
// comp we couldn't geocode has no place on the map either.
export function compSelectionsToExtraComps(selections: CompSelection[]): ExtraComp[] {
  return selections
    .filter(
      (s) =>
        s.action === "include" &&
        s.compKey.startsWith("user:") &&
        s.latitude != null &&
        s.longitude != null,
    )
    .map((s) => ({
      key: s.compKey,
      address: s.address,
      latitude: s.latitude as number,
      longitude: s.longitude as number,
      salePrice: s.salePrice,
      saleDate: s.saleDate,
      landSqft: s.landSqft,
      buildingSqft: s.buildingSqft,
      source: s.source,
      saleVerified: s.saleVerified,
    }));
}
