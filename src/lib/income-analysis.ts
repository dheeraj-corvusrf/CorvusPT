import { supabase } from "./supabase";
import { invokeEdgeFunction } from "./edge-functions";
import type { CapRateSource } from "./income-approach";

// Per-property income figures for Module 7 (Income Value). One row per
// property, holding the owner-confirmed numbers only — never AI output. The
// deterministic ladder (income-approach.ts) and the AI narrative
// (MODULE_SPECS.income) both read from here. Mirrors comp-selections.ts /
// module-overrides.ts.
export type IncomeAnalysis = {
  grossPotentialIncome: number | null;
  otherIncome: number | null;
  vacancyPct: number | null;
  operatingExpenses: number | null;
  noiStated: number | null;
  rentableSqft: number | null;
  capRatePct: number | null;
  capRateSource: CapRateSource | null;
  sourceDocumentIds: string[];
  notes: string | null;
  updatedAt: string | null;
};

type IncomeAnalysisRow = {
  gross_potential_income: number | null;
  other_income: number | null;
  vacancy_pct: number | null;
  operating_expenses: number | null;
  noi_stated: number | null;
  rentable_sqft: number | null;
  cap_rate_pct: number | null;
  cap_rate_source: CapRateSource | null;
  source_document_ids: string[] | null;
  notes: string | null;
  updated_at: string | null;
};

const SELECT_COLUMNS =
  "gross_potential_income, other_income, vacancy_pct, operating_expenses, noi_stated, rentable_sqft, cap_rate_pct, cap_rate_source, source_document_ids, notes, updated_at";

function fromRow(r: IncomeAnalysisRow): IncomeAnalysis {
  return {
    grossPotentialIncome: r.gross_potential_income,
    otherIncome: r.other_income,
    vacancyPct: r.vacancy_pct,
    operatingExpenses: r.operating_expenses,
    noiStated: r.noi_stated,
    rentableSqft: r.rentable_sqft,
    capRatePct: r.cap_rate_pct,
    capRateSource: r.cap_rate_source,
    sourceDocumentIds: r.source_document_ids ?? [],
    notes: r.notes,
    updatedAt: r.updated_at,
  };
}

export async function getIncomeAnalysis(propertyId: string): Promise<IncomeAnalysis | null> {
  const { data, error } = await supabase
    .from("income_analysis")
    .select(SELECT_COLUMNS)
    .eq("property_id", propertyId)
    .maybeSingle();
  if (error) throw error;
  return data ? fromRow(data as IncomeAnalysisRow) : null;
}

export type IncomeAnalysisInput = {
  grossPotentialIncome?: number | null;
  otherIncome?: number | null;
  vacancyPct?: number | null;
  operatingExpenses?: number | null;
  noiStated?: number | null;
  rentableSqft?: number | null;
  capRatePct?: number | null;
  capRateSource?: CapRateSource | null;
  sourceDocumentIds?: string[];
  notes?: string | null;
};

export async function upsertIncomeAnalysis(
  userId: string,
  propertyId: string,
  input: IncomeAnalysisInput,
): Promise<void> {
  const { error } = await supabase.from("income_analysis").upsert(
    {
      user_id: userId,
      property_id: propertyId,
      gross_potential_income: input.grossPotentialIncome ?? null,
      other_income: input.otherIncome ?? null,
      vacancy_pct: input.vacancyPct ?? null,
      operating_expenses: input.operatingExpenses ?? null,
      noi_stated: input.noiStated ?? null,
      rentable_sqft: input.rentableSqft ?? null,
      cap_rate_pct: input.capRatePct ?? null,
      cap_rate_source: input.capRateSource ?? null,
      source_document_ids: input.sourceDocumentIds ?? [],
      notes: input.notes ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "property_id" },
  );
  if (error) throw error;
}

// Reads one uploaded financial document (a P&L / operating statement, a rent
// roll, or a fee appraisal) and pulls the figures actually printed on it, to
// pre-fill the income figures form. Nothing is written; the owner confirms
// every number before it is saved. See
// supabase/functions/extract-income-financials/index.ts.
export type IncomeExtraction = {
  documentKind: "P&L" | "Operating Statement" | "Rent Roll" | "Appraisal" | "Other" | null;
  grossPotentialIncome: number | null;
  otherIncome: number | null;
  vacancyPct: number | null;
  operatingExpenses: number | null;
  operatingExpensesByCategory: { category: string; amount: number }[];
  noi: number | null;
  capRatePct: number | null;
  rentableSqft: number | null;
  periodLabel: string | null;
  confidence: number;
  notes: string | null;
  documentId: string;
};

export async function extractIncomeFinancials(documentId: string): Promise<IncomeExtraction> {
  return invokeEdgeFunction<IncomeExtraction>("extract-income-financials", { documentId });
}
