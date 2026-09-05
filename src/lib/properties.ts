import { supabase } from "./supabase";
import { computeAndStoreHealthScore } from "./property-scores";
import type { CadValueHistoryEntry } from "./cad-lookup";
import type { IntakeState } from "./intake-store";
import type { Tier, PropertyValueBracket } from "./billing";

export type PropertyRecord = {
  id: string;
  address: string;
  cad: string | null;
  accountNumber: string | null;
  ownerName: string | null;
  propertyType: string | null;
  landValue: number | null;
  improvementValue: number | null;
  totalValue: number | null;
  taxYear: number | null;
  protestDeadline: string | null;
  paymentDueDate: string | null;
  taxAmountDue: number | null;
  paidAt: string | null;
  estimatedSavings: number | null;
  // "ai" and "baseline" are legacy values from before the savings estimate was
  // made fully deterministic — still readable on old rows, but nothing writes
  // them anymore (see src/lib/savings-estimate.ts).
  savingsBasis: "comps" | "formula" | "ai" | "baseline" | null;
  createdAt: string;
  valueHistory: CadValueHistoryEntry[] | null;
  // This property's own, real, independent Stripe subscription — see
  // cancel-property-subscription/create-checkout-session. Never client-
  // writable (see the column-level UPDATE grant in schema.sql); only the
  // stripe-webhook edge function (service role) ever sets these. Optional
  // (not just nullable) so existing test fixtures and admin.ts's
  // toPropertyRecordStub — built from data that genuinely doesn't carry
  // these — don't need updating; fromRow (the real, live path) always
  // populates all six.
  stripeSubscriptionId?: string | null;
  subscriptionStatus?: string | null;
  planTier?: Tier | null;
  valueBracket?: PropertyValueBracket | null;
  cancelAtPeriodEnd?: boolean;
  cancelAt?: string | null;
};

type PropertyRow = {
  id: string;
  address: string;
  cad: string | null;
  account_number: string | null;
  owner_name: string | null;
  property_type: string | null;
  land_value: number | null;
  improvement_value: number | null;
  total_value: number | null;
  tax_year: number | null;
  protest_deadline: string | null;
  payment_due_date: string | null;
  tax_amount_due: number | null;
  paid_at: string | null;
  estimated_savings: number | null;
  savings_basis: "comps" | "formula" | "ai" | "baseline" | null;
  created_at: string;
  value_history: string[] | null;
  stripe_subscription_id: string | null;
  subscription_status: string | null;
  plan_tier: Tier | null;
  value_bracket: PropertyValueBracket | null;
  cancel_at_period_end: boolean;
  cancel_at: string | null;
};

function fromRow(row: PropertyRow): PropertyRecord {
  return {
    id: row.id,
    address: row.address,
    cad: row.cad,
    accountNumber: row.account_number,
    ownerName: row.owner_name,
    propertyType: row.property_type,
    landValue: row.land_value,
    improvementValue: row.improvement_value,
    totalValue: row.total_value,
    taxYear: row.tax_year,
    protestDeadline: row.protest_deadline,
    paymentDueDate: row.payment_due_date,
    taxAmountDue: row.tax_amount_due,
    paidAt: row.paid_at,
    estimatedSavings: row.estimated_savings,
    savingsBasis: row.savings_basis,
    createdAt: row.created_at,
    valueHistory: row.value_history
      ? row.value_history.map((s) => JSON.parse(s) as CadValueHistoryEntry)
      : null,
    stripeSubscriptionId: row.stripe_subscription_id,
    subscriptionStatus: row.subscription_status,
    planTier: row.plan_tier,
    valueBracket: row.value_bracket,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    cancelAt: row.cancel_at,
  };
}

const SELECT_COLUMNS =
  "id, address, cad, account_number, owner_name, property_type, land_value, improvement_value, total_value, tax_year, protest_deadline, payment_due_date, tax_amount_due, paid_at, estimated_savings, savings_basis, created_at, value_history, stripe_subscription_id, subscription_status, plan_tier, value_bracket, cancel_at_period_end, cancel_at";

export async function listProperties(userId: string): Promise<PropertyRecord[]> {
  const { data, error } = await supabase
    .from("properties")
    .select(SELECT_COLUMNS)
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data as PropertyRow[]).map(fromRow);
}

// Avoids inserting a duplicate row for a property the user already has on file.
// Matched by CAD account number when we have one (the real unique key for a CAD
// record — the same address can be typed slightly differently), falling back to
// the address itself when we don't (e.g. an admin-added property with no CAD
// match). Returns the existing row as-is rather than updating it, since
// properties intentionally have no update policy — re-deriving fresher data
// means deleting and re-adding, not silently overwriting what's on file.
export async function findExistingProperty(
  userId: string,
  property: { address: string; cad?: string; accountNumber?: string },
): Promise<PropertyRecord | null> {
  let query = supabase.from("properties").select(SELECT_COLUMNS).eq("user_id", userId);
  query =
    property.accountNumber && property.cad
      ? query.eq("cad", property.cad).eq("account_number", property.accountNumber)
      : query.ilike("address", property.address.trim());
  const { data, error } = await query.limit(1);
  if (error) throw error;
  const row = (data as PropertyRow[])[0];
  return row ? fromRow(row) : null;
}

export async function addProperty(
  userId: string,
  property: {
    address: string;
    cad?: string;
    accountNumber?: string;
    ownerName?: string;
    propertyType?: string;
    landValue?: number;
    improvementValue?: number;
    totalValue?: number;
    taxYear?: number;
    protestDeadline?: string;
    paymentDueDate?: string;
    taxAmountDue?: number;
    estimatedSavings?: number;
    savingsBasis?: "comps" | "formula";
    valueHistory?: CadValueHistoryEntry[] | null;
  },
): Promise<PropertyRecord> {
  const existing = await findExistingProperty(userId, property);
  if (existing) return existing;

  const { data, error } = await supabase
    .from("properties")
    .insert({
      user_id: userId,
      address: property.address,
      cad: property.cad ?? null,
      account_number: property.accountNumber ?? null,
      owner_name: property.ownerName ?? null,
      property_type: property.propertyType ?? null,
      land_value: property.landValue ?? null,
      improvement_value: property.improvementValue ?? null,
      total_value: property.totalValue ?? null,
      tax_year: property.taxYear ?? null,
      protest_deadline: property.protestDeadline ?? null,
      payment_due_date: property.paymentDueDate ?? null,
      tax_amount_due: property.taxAmountDue ?? null,
      estimated_savings: property.estimatedSavings ?? null,
      savings_basis: property.savingsBasis ?? null,
      value_history:
        property.valueHistory && property.valueHistory.length > 0
          ? property.valueHistory.map((v) => JSON.stringify(v))
          : null,
    })
    .select()
    .single();
  if (error) throw error;
  const created = fromRow(data as PropertyRow);
  computeAndStoreHealthScore(created);
  return created;
}

// Backfills a savings estimate onto a property that was saved before it had one
// (added pre-feature, or the estimate attempt at intake time errored/came back
// empty) — see the Properties dashboard page, which calls this once per property
// missing an estimate rather than leaving it permanently blank.
export async function updatePropertySavings(
  id: string,
  savings: { estimatedSavings: number; savingsBasis: "comps" | "formula" },
): Promise<PropertyRecord> {
  const { data, error } = await supabase
    .from("properties")
    .update({ estimated_savings: savings.estimatedSavings, savings_basis: savings.savingsBasis })
    .eq("id", id)
    .select(SELECT_COLUMNS)
    .single();
  if (error) throw error;
  return fromRow(data as PropertyRow);
}

// Lets a user correct or confirm a genuinely-missing pre-filing field
// directly from CaseDetailModal's Pre-Filing Check gate (see
// PreFilingGate) — e.g. a property added via CAD-search intake never had a
// Notice of Appraised Value document for the AI to extract a real
// protestDeadline from, and until now there was no way to supply one.
// Every field here is one PreFilingCheckItem already flags as "blocking".
export async function updatePropertyIdentity(
  id: string,
  patch: {
    cad?: string;
    address?: string;
    accountNumber?: string;
    ownerName?: string;
    taxYear?: number;
    protestDeadline?: string;
  },
): Promise<PropertyRecord> {
  const update: Record<string, unknown> = {};
  if (patch.cad !== undefined) update.cad = patch.cad;
  if (patch.address !== undefined) update.address = patch.address;
  if (patch.accountNumber !== undefined) update.account_number = patch.accountNumber;
  if (patch.ownerName !== undefined) update.owner_name = patch.ownerName;
  if (patch.taxYear !== undefined) update.tax_year = patch.taxYear;
  if (patch.protestDeadline !== undefined) update.protest_deadline = patch.protestDeadline;
  const { data, error } = await supabase
    .from("properties")
    .update(update)
    .eq("id", id)
    .select(SELECT_COLUMNS)
    .single();
  if (error) throw error;
  return fromRow(data as PropertyRow);
}

export async function deleteProperty(id: string): Promise<void> {
  const { error } = await supabase.from("properties").delete().eq("id", id);
  if (error) throw error;
}

// Keeps this "latest bill" snapshot in sync with the real per-year history in
// public.tax_bills (see src/lib/tax-bills.ts) whenever a bill is added there — so the
// Deadlines page and dashboard home widget, which read these two columns directly,
// show the latest bill without needing to know tax_bills exists.
export async function updatePropertyBillSnapshot(
  id: string,
  snapshot: { paymentDueDate?: string; taxAmountDue?: number },
): Promise<PropertyRecord> {
  const update: Record<string, unknown> = {};
  if (snapshot.paymentDueDate !== undefined) update.payment_due_date = snapshot.paymentDueDate;
  if (snapshot.taxAmountDue !== undefined) update.tax_amount_due = snapshot.taxAmountDue;
  const { data, error } = await supabase
    .from("properties")
    .update(update)
    .eq("id", id)
    .select(SELECT_COLUMNS)
    .single();
  if (error) throw error;
  return fromRow(data as PropertyRow);
}

// CorvusPT has no live payment integration — there's no bank/county feed to confirm a
// bill was actually paid, so this records the user's own "I paid this" action rather
// than a verified payment event.
export async function markPropertyPaid(id: string): Promise<PropertyRecord> {
  const { data, error } = await supabase
    .from("properties")
    .update({ paid_at: new Date().toISOString() })
    .eq("id", id)
    .select(SELECT_COLUMNS)
    .single();
  if (error) throw error;
  return fromRow(data as PropertyRow);
}

// Shared "load this saved property's real fields into the guest-flow intake
// store" patch — every jump into /ai-report for an already-saved property
// (the dashboard's "Open AI Report", and CaseDetailModal's "Upload Evidence
// — Go to Module 8") needs the exact same fields, so this stays in one place
// instead of drifting across call sites. Callers still own the actual
// updateIntake()/navigate() calls — this only builds the patch object, since
// updateIntake lives in intake-store.ts and navigate is a route-bound hook,
// neither of which belongs in this file.
export function buildAiReportIntakePatch(p: PropertyRecord): Partial<IntakeState> {
  return {
    address: p.address,
    cad: p.cad ?? undefined,
    accountNumber: p.accountNumber ?? undefined,
    ownerName: p.ownerName ?? undefined,
    propertyType: p.propertyType ?? undefined,
    landValue: p.landValue ?? undefined,
    improvementValue: p.improvementValue ?? undefined,
    totalValue: p.totalValue ?? undefined,
    taxYear: p.taxYear ?? undefined,
    valueHistory: p.valueHistory ?? undefined,
    confirmed: true,
  };
}
