import { supabase } from "./supabase";

// Per-property tax inputs for Module 9 (Estimated Savings) — the optional
// owner-supplied figures that refine the deterministic savings analysis
// (see savings-analysis.ts): a real taxable value, total exemptions, a flat
// protest-cost override, and a multi-year projection length. One row per
// property. Mirrors income-analysis.ts / comp-selections.ts.
export type SavingsTaxInputsRecord = {
  taxableValue: number | null;
  exemptionsTotal: number | null;
  protestCostOverride: number | null;
  projectionYears: number | null;
  notes: string | null;
  updatedAt: string | null;
};

type Row = {
  taxable_value: number | null;
  exemptions_total: number | null;
  protest_cost_override: number | null;
  projection_years: number | null;
  notes: string | null;
  updated_at: string | null;
};

const SELECT_COLUMNS =
  "taxable_value, exemptions_total, protest_cost_override, projection_years, notes, updated_at";

function fromRow(r: Row): SavingsTaxInputsRecord {
  return {
    taxableValue: r.taxable_value,
    exemptionsTotal: r.exemptions_total,
    protestCostOverride: r.protest_cost_override,
    projectionYears: r.projection_years,
    notes: r.notes,
    updatedAt: r.updated_at,
  };
}

export async function getSavingsTaxInputs(
  propertyId: string,
): Promise<SavingsTaxInputsRecord | null> {
  const { data, error } = await supabase
    .from("savings_tax_inputs")
    .select(SELECT_COLUMNS)
    .eq("property_id", propertyId)
    .maybeSingle();
  if (error) throw error;
  return data ? fromRow(data as Row) : null;
}

export type SavingsTaxInputsInput = {
  taxableValue?: number | null;
  exemptionsTotal?: number | null;
  protestCostOverride?: number | null;
  projectionYears?: number | null;
  notes?: string | null;
};

export async function upsertSavingsTaxInputs(
  userId: string,
  propertyId: string,
  input: SavingsTaxInputsInput,
): Promise<void> {
  const { error } = await supabase.from("savings_tax_inputs").upsert(
    {
      user_id: userId,
      property_id: propertyId,
      taxable_value: input.taxableValue ?? null,
      exemptions_total: input.exemptionsTotal ?? null,
      protest_cost_override: input.protestCostOverride ?? null,
      projection_years: input.projectionYears ?? null,
      notes: input.notes ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "property_id" },
  );
  if (error) throw error;
}
