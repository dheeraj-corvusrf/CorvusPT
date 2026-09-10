import { supabase } from "./supabase";
import { invokeEdgeFunction } from "./edge-functions";
import type { ArbDecision, EscalationPath, ProtestRecord, ProtestStatus } from "./protests";
import type { PropertyRecord } from "./properties";
import { PLAN_OPTIONS, type PlanValue } from "./billing";

// Reads/writes here rely on the admin-only RLS policies in supabase/schema.sql
// (public.is_admin()) — never import this module from customer-facing routes,
// only from the /admin panel, which independently re-checks checkIsAdmin() itself.
// PlanValue/PLAN_OPTIONS live in ./billing (customer-facing) and are just re-exported
// here for admin-panel convenience, since plan values aren't admin-specific data.
export { PLAN_OPTIONS, type PlanValue };

export type AdminUserRecord = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  plan: PlanValue;
  isAdmin: boolean;
  createdAt: string;
};

type ProfileRow = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  plan: PlanValue;
  is_admin: boolean;
  created_at: string;
};

function fromRow(row: ProfileRow): AdminUserRecord {
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    phone: row.phone,
    plan: row.plan,
    isAdmin: row.is_admin,
    createdAt: row.created_at,
  };
}

export async function checkIsAdmin(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  return data?.is_admin ?? false;
}

export async function listAllUsers(): Promise<AdminUserRecord[]> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, first_name, last_name, phone, plan, is_admin, created_at")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data as ProfileRow[]).map(fromRow);
}

export type AdminAuditEntry = {
  id: string;
  actorEmail: string;
  action: string;
  targetEmail: string | null;
  detail: string | null;
  createdAt: string;
};

type AdminAuditRow = {
  id: string;
  actor_email: string;
  action: string;
  target_email: string | null;
  detail: string | null;
  created_at: string;
};

// Best-effort: a logging failure shouldn't roll back or surface an error for an
// admin action that itself already succeeded — see the try/catch below and the
// matching posture in admin-create-user/admin-delete-user's own inserts.
async function logAdminAction(input: {
  action: string;
  targetUserId?: string | null;
  targetEmail?: string | null;
  detail?: string | null;
}): Promise<void> {
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const { error } = await supabase.from("admin_audit_log").insert({
      actor_id: user.id,
      actor_email: user.email ?? "",
      action: input.action,
      target_user_id: input.targetUserId ?? null,
      target_email: input.targetEmail ?? null,
      detail: input.detail ?? null,
    });
    if (error) console.error("admin_audit_log insert failed:", error);
  } catch (err) {
    console.error("admin_audit_log insert failed:", err);
  }
}

export async function listAdminAuditLog(limit = 50): Promise<AdminAuditEntry[]> {
  const { data, error } = await supabase
    .from("admin_audit_log")
    .select("id, actor_email, action, target_email, detail, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as AdminAuditRow[]).map((row) => ({
    id: row.id,
    actorEmail: row.actor_email,
    action: row.action,
    targetEmail: row.target_email,
    detail: row.detail,
    createdAt: row.created_at,
  }));
}

export type BetaLead = {
  id: string;
  fullName: string;
  workEmail: string;
  company: string;
  areaOfInterest: string;
  useCase: string | null;
  sourceDoor: string | null;
  createdAt: string;
  invitedAt: string | null;
};

type BetaLeadRow = {
  id: string;
  full_name: string;
  work_email: string;
  company: string;
  area_of_interest: string;
  use_case: string | null;
  source_door: string | null;
  created_at: string;
  invited_at: string | null;
};

// Submissions from hub/index.html's public "Request Beta Access" form (see
// supabase/functions/submit-beta-lead) — a separate static site with no
// login of its own, so these rows have no user_id and rely purely on the
// admin-only select policy on beta_leads, not the usual owner-scoped RLS.
export async function listBetaLeads(): Promise<BetaLead[]> {
  const { data, error } = await supabase
    .from("beta_leads")
    .select(
      "id, full_name, work_email, company, area_of_interest, use_case, source_door, created_at, invited_at",
    )
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data as BetaLeadRow[]).map((row) => ({
    id: row.id,
    fullName: row.full_name,
    workEmail: row.work_email,
    company: row.company,
    areaOfInterest: row.area_of_interest,
    useCase: row.use_case,
    sourceDoor: row.source_door,
    createdAt: row.created_at,
    invitedAt: row.invited_at,
  }));
}

// Called after createUserAccount() successfully sends the real invite email
// (see below) — this only records that it happened, it's a separate write
// from the invite itself since invited_at lives on beta_leads, not
// anything the admin-create-user edge function touches.
export async function markBetaLeadInvited(id: string): Promise<string> {
  const invitedAt = new Date().toISOString();
  const { error } = await supabase
    .from("beta_leads")
    .update({ invited_at: invitedAt })
    .eq("id", id);
  if (error) throw error;
  return invitedAt;
}

export async function deleteBetaLead(id: string): Promise<void> {
  const { error } = await supabase.from("beta_leads").delete().eq("id", id);
  if (error) throw error;
}

// Both of these now go through a service-role edge function rather than a direct
// client update — Postgres column grants on profiles (see supabase/schema.sql)
// no longer allow the plain client to write plan/is_admin at all, and the edge
// function verifies admin status server-side instead of relying on this module
// only ever being imported from the admin UI (which doesn't stop anyone from
// calling the underlying client methods directly). Each function logs its own
// admin_audit_log row server-side, so the separate logAdminAction() call these
// used to make is gone too — it can't be skipped independently of the update now.
export async function updateUserPlan(
  userId: string,
  plan: PlanValue,
  context?: { targetEmail?: string; previousPlan?: PlanValue },
): Promise<void> {
  await invokeEdgeFunction("admin-update-plan", {
    userId,
    plan,
    targetEmail: context?.targetEmail,
    previousPlan: context?.previousPlan,
  });
}

export async function updateUserAdminStatus(
  userId: string,
  isAdmin: boolean,
  context?: { targetEmail?: string },
): Promise<void> {
  await invokeEdgeFunction("admin-update-admin-status", {
    userId,
    isAdmin,
    targetEmail: context?.targetEmail,
  });
}

export async function deleteUserAccount(userId: string): Promise<void> {
  await invokeEdgeFunction("admin-delete-user", { userId });
}

// Returns a real one-time Supabase login link for the target user (see
// admin-impersonate-user's own comment) — the caller opens this in a new
// tab so the admin's own session is untouched. Server-side re-checks
// is_admin and logs to admin_audit_log itself; this is just the invoke.
export async function impersonateUser(userId: string): Promise<string> {
  const result = await invokeEdgeFunction<{ actionLink: string }>("admin-impersonate-user", {
    userId,
    redirectPath: `${import.meta.env.BASE_URL}dashboard`,
  });
  return result.actionLink;
}

// Builds a link into the app's own sign-up form, prefilled with what staff
// already know — no server call, no account created. sign-in.tsx reads
// these via validateSearch and pre-fills mode/email/firstName/lastName/beta;
// the invitee still sets their own password (or uses Google) to actually
// create the account. wantsBeta pre-checks the sign-up form's own beta
// checkbox, which is what actually sets plan='beta' (via handle_new_user()
// in schema.sql reading wants_beta off the real signUp() call) — nothing
// here writes a plan.
export function buildSignupInviteLink(input: {
  email: string;
  firstName?: string;
  lastName?: string;
  wantsBeta?: boolean;
}): string {
  const base = `${window.location.origin}${import.meta.env.BASE_URL}sign-in`;
  const params = new URLSearchParams({ mode: "signup", email: input.email });
  if (input.firstName) params.set("firstName", input.firstName);
  if (input.lastName) params.set("lastName", input.lastName);
  if (input.wantsBeta) params.set("beta", "1");
  return `${base}?${params.toString()}`;
}

// Deliberately NOT admin.inviteUserByEmail() (the old admin-create-user
// flow, now unused) — that pre-created a real auth.users/profiles row the
// instant staff clicked Invite, before the invitee had done anything. This
// sends a real, branded email (via send-signup-invite, Resend directly —
// bypassing Supabase Auth's own mailer entirely) containing a prefilled
// sign-up link; no account exists until the invitee actually finishes
// signing up themselves, password or Google, same as any organic visitor.
export async function createUserAccount(input: {
  email: string;
  firstName: string;
  lastName: string;
  wantsBeta?: boolean;
}): Promise<void> {
  const signupUrl = buildSignupInviteLink(input);
  await invokeEdgeFunction("send-signup-invite", { ...input, signupUrl });
}

export type InvitedUserRecord = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  wantsBeta: boolean;
  invitedAt: string;
  lastSentAt: string;
  resendCount: number;
};

type InvitedUserRow = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  wants_beta: boolean;
  invited_at: string;
  last_sent_at: string;
  resend_count: number;
};

// Everyone who's been sent a sign-up link but hasn't actually finished
// signing up yet — see invited_users in schema.sql. handle_new_user()
// deletes a row the moment a real account exists for that email, so
// whatever's left here is genuinely still pending, not a permanent log.
export async function listInvitedUsers(): Promise<InvitedUserRecord[]> {
  const { data, error } = await supabase
    .from("invited_users")
    .select("id, email, first_name, last_name, wants_beta, invited_at, last_sent_at, resend_count")
    .order("invited_at", { ascending: false });
  if (error) throw error;
  return (data as InvitedUserRow[]).map((row) => ({
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    wantsBeta: row.wants_beta,
    invitedAt: row.invited_at,
    lastSentAt: row.last_sent_at,
    resendCount: row.resend_count,
  }));
}

// Re-sends the same real branded email to an already-pending invite — same
// send-signup-invite path as a fresh invite, which updates that row's
// last_sent_at/resend_count (by email, its unique key) rather than creating
// a second one.
export async function resendInvite(invite: InvitedUserRecord): Promise<void> {
  await createUserAccount({
    email: invite.email,
    firstName: invite.firstName ?? "",
    lastName: invite.lastName ?? "",
    wantsBeta: invite.wantsBeta,
  });
}

// Clears a pending invite without waiting for the person to sign up (wrong
// address, no longer wanted, etc.) — direct client delete via invited_users'
// own admin-only RLS policy, same pattern as beta_leads' delete, no edge
// function needed since this never touches auth.users.
export async function deleteInvitedUser(id: string): Promise<void> {
  const { error } = await supabase.from("invited_users").delete().eq("id", id);
  if (error) throw error;
}

export const PROTEST_STATUS_OPTIONS: { value: ProtestStatus; label: string }[] = [
  { value: "requested", label: "Requested" },
  { value: "filed", label: "Filed" },
  { value: "under_review", label: "Under Review" },
  { value: "offer_received", label: "Offer Received" },
  { value: "hearing_scheduled", label: "Hearing Scheduled" },
  { value: "decision_received", label: "Decision Received" },
  { value: "appealing", label: "Appealing" },
  { value: "arbitrating", label: "Arbitrating" },
  { value: "resolved", label: "Resolved" },
];

export type AdminProtestRecord = {
  id: string;
  propertyId: string;
  userId: string;
  status: ProtestStatus;
  notes: string | null;
  requestedAt: string;
  updatedAt: string;
  propertyAddress: string | null;
  propertyCad: string | null;
  propertyType: string | null;
  protestDeadline: string | null;
  totalValue: number | null;
  landValue: number | null;
  improvementValue: number | null;
  taxYear: number | null;
  accountNumber: string | null;
  // The tax year this specific protest was filed for (protests.tax_year), distinct
  // from `taxYear` above (the property's current tax year). A property re-filed in
  // multiple years (see "Re-file for {year}" on the dashboard) has one protest row
  // per year, so grouping the admin queue by year needs this, not the property's
  // single current value. Falls back to the property's tax year for protest rows
  // created before this column existed and were never backfilled.
  protestFilingYear: number | null;
  // Case-progress fields (see src/lib/protests.ts and protest-case.ts) — carried
  // here too so the admin panel can open the same CaseProgress workflow the
  // customer dashboard uses, without a second fetch.
  originalValue: number | null;
  settlementOfferValue: number | null;
  settlementOfferReceivedAt: string | null;
  hearingDate: string | null;
  arbDecision: ArbDecision | null;
  arbDecisionDate: string | null;
  finalValue: number | null;
  escalationPath: EscalationPath | null;
  closedAt: string | null;
};

type AdminProtestRow = {
  id: string;
  property_id: string;
  user_id: string;
  status: ProtestStatus;
  notes: string | null;
  requested_at: string;
  updated_at: string;
  original_value: number | null;
  settlement_offer_value: number | null;
  settlement_offer_received_at: string | null;
  hearing_date: string | null;
  arb_decision: ArbDecision | null;
  arb_decision_date: string | null;
  final_value: number | null;
  escalation_path: EscalationPath | null;
  closed_at: string | null;
  tax_year: number | null;
  properties: {
    address: string;
    cad: string | null;
    property_type: string | null;
    protest_deadline: string | null;
    total_value: number | null;
    land_value: number | null;
    improvement_value: number | null;
    tax_year: number | null;
    account_number: string | null;
  } | null;
};

// Real, staff-actioned queue: every row here came from a user clicking "Request
// Protest Filing" on the dashboard (src/lib/protests.ts) — status only ever moves
// forward from here, by an admin, since filing/hearings happen off-platform.
export async function listAllProtests(): Promise<AdminProtestRecord[]> {
  const { data, error } = await supabase
    .from("protests")
    .select(
      "id, property_id, user_id, status, notes, requested_at, updated_at, original_value, settlement_offer_value, settlement_offer_received_at, hearing_date, arb_decision, arb_decision_date, final_value, escalation_path, closed_at, tax_year, properties(address, cad, property_type, protest_deadline, total_value, land_value, improvement_value, tax_year, account_number)",
    )
    .order("requested_at", { ascending: false });
  if (error) throw error;
  return (data as unknown as AdminProtestRow[]).map((row) => ({
    id: row.id,
    propertyId: row.property_id,
    userId: row.user_id,
    status: row.status,
    notes: row.notes,
    requestedAt: row.requested_at,
    updatedAt: row.updated_at,
    propertyAddress: row.properties?.address ?? null,
    propertyCad: row.properties?.cad ?? null,
    propertyType: row.properties?.property_type ?? null,
    protestDeadline: row.properties?.protest_deadline ?? null,
    totalValue: row.properties?.total_value ?? null,
    landValue: row.properties?.land_value ?? null,
    improvementValue: row.properties?.improvement_value ?? null,
    taxYear: row.properties?.tax_year ?? null,
    accountNumber: row.properties?.account_number ?? null,
    protestFilingYear: row.tax_year ?? row.properties?.tax_year ?? null,
    originalValue: row.original_value,
    settlementOfferValue: row.settlement_offer_value,
    settlementOfferReceivedAt: row.settlement_offer_received_at,
    hearingDate: row.hearing_date,
    arbDecision: row.arb_decision,
    arbDecisionDate: row.arb_decision_date,
    finalValue: row.final_value,
    escalationPath: row.escalation_path,
    closedAt: row.closed_at,
  }));
}

// Trivial field renames off data listAllProtests() already fetched — lets the
// admin panel open the exact same CaseProgress workflow the customer dashboard
// uses (src/components/CaseDetailModal.tsx) without a second query. Fields
// CaseProgress/getCaseResults don't touch (ownerName, paymentDueDate, etc.) are
// stubbed to null since AdminProtestRecord never carries them.
export function toProtestRecord(record: AdminProtestRecord): ProtestRecord {
  return {
    id: record.id,
    propertyId: record.propertyId,
    status: record.status,
    notes: record.notes,
    requestedAt: record.requestedAt,
    updatedAt: record.updatedAt,
    originalValue: record.originalValue,
    settlementOfferValue: record.settlementOfferValue,
    settlementOfferReceivedAt: record.settlementOfferReceivedAt,
    hearingDate: record.hearingDate,
    // AdminProtestRecord doesn't carry these (same stubbed-to-null
    // convention as the rest of this function) — the admin panel's own
    // CaseProgress view never renders the richer hearing-notice detail
    // that would need them.
    hearingTime: null,
    hearingLocation: null,
    hearingMode: null,
    informalStatus: "not_requested",
    informalReviewDate: null,
    informalReviewTime: null,
    informalReviewMode: null,
    informalAppraiserCategory: null,
    attendanceType: null,
    arbDecision: record.arbDecision,
    arbDecisionDate: record.arbDecisionDate,
    finalValue: record.finalValue,
    escalationPath: record.escalationPath,
    closedAt: record.closedAt,
    taxYear: record.protestFilingYear,
    // The admin panel's AdminCaseProgressModal never shows CorvusGuidanceGate
    // (that's a customer-only onboarding step to a case they're managing
    // themselves) — stubbed to null like the other fields this adapter
    // doesn't carry, same convention as the comment above already documents.
    corvusGuidanceAckAt: null,
  };
}

export function toPropertyRecordStub(record: AdminProtestRecord): PropertyRecord {
  return {
    id: record.propertyId,
    address: record.propertyAddress ?? "",
    cad: record.propertyCad,
    accountNumber: record.accountNumber,
    ownerName: null,
    propertyType: record.propertyType,
    landValue: record.landValue,
    improvementValue: record.improvementValue,
    totalValue: record.totalValue,
    taxYear: record.taxYear,
    protestDeadline: record.protestDeadline,
    paymentDueDate: null,
    taxAmountDue: null,
    paidAt: null,
    estimatedSavings: null,
    savingsBasis: null,
    createdAt: record.requestedAt,
    // Not selected by listAllProtests() — the admin panel's case-progress view has
    // no value-history chart, so this is never read there (same posture as the
    // other admin-unrelated fields stubbed above).
    valueHistory: null,
  };
}

export async function updateProtestStatus(
  protestId: string,
  status: ProtestStatus,
  context?: { propertyAddress?: string | null; requesterEmail?: string },
): Promise<void> {
  const { error } = await supabase
    .from("protests")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", protestId);
  if (error) throw error;
  await logAdminAction({
    action: "update_protest_status",
    targetEmail: context?.requesterEmail,
    detail: `${context?.propertyAddress ?? "protest"}: status → ${status}`,
  });
}

export async function updateProtestNotes(
  protestId: string,
  notes: string,
  context?: { propertyAddress?: string | null; requesterEmail?: string },
): Promise<void> {
  const { error } = await supabase
    .from("protests")
    .update({ notes, updated_at: new Date().toISOString() })
    .eq("id", protestId);
  if (error) throw error;
  await logAdminAction({
    action: "update_protest_notes",
    targetEmail: context?.requesterEmail,
    detail: `${context?.propertyAddress ?? "protest"}: notes updated`,
  });
}

export type AdminDocumentRecord = {
  id: string;
  fileName: string;
  documentType: string | null;
  uploadedAt: string;
};

// Relies on the "Admins can view all documents" RLS policy (schema.sql) — metadata
// only (name/type/date), used as an evidence signal for the AI case summary below.
// Viewing/downloading the actual file isn't supported here: the storage bucket's
// own policies only permit the owning user, not admins.
export async function listDocumentsForProperty(propertyId: string): Promise<AdminDocumentRecord[]> {
  const { data, error } = await supabase
    .from("documents")
    .select("id, file_name, document_type, uploaded_at")
    .eq("property_id", propertyId)
    .order("uploaded_at", { ascending: false });
  if (error) throw error;
  return (
    data as { id: string; file_name: string; document_type: string | null; uploaded_at: string }[]
  ).map((row) => ({
    id: row.id,
    fileName: row.file_name,
    documentType: row.document_type,
    uploadedAt: row.uploaded_at,
  }));
}

export type CaseSummaryResult = {
  summary: string;
  nextAction: string;
  evidenceGaps: string[];
};

export async function getCaseSummary(payload: {
  propertyContext: string;
  protestContext: string;
  documentsContext: string;
}): Promise<CaseSummaryResult> {
  return invokeEdgeFunction<CaseSummaryResult>("admin-case-summary", payload);
}
