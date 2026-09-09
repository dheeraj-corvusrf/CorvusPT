import { supabase } from "./supabase";
import { submitWeb3Form } from "./web3forms";

export type ProtestStatus =
  | "requested"
  | "filed"
  | "under_review"
  | "offer_received"
  | "hearing_scheduled"
  | "decision_received"
  | "appealing"
  | "arbitrating"
  | "resolved";

export type ArbDecision = "approved" | "partial" | "denied";
export type EscalationPath = "accept" | "appeal" | "arbitration";

// Finer-grained than ProtestStatus — see the schema.sql comment on
// protests.informal_status for why this is a separate column rather than
// new ProtestStatus values.
export type InformalStatus =
  | "not_requested"
  | "requested"
  | "pending_response"
  | "scheduled"
  | "proposed_value_received"
  | "accepted"
  | "rejected"
  | "no_informal_available";

// The real, shorter label set the user actually sees — several internal
// InformalStatus values collapse to the same honest user-facing phrase
// rather than exposing all 8 as their own confusing badge text.
export const INFORMAL_STATUS_LABEL: Record<InformalStatus, string> = {
  not_requested: "Not Requested",
  requested: "Informal Review Pending",
  pending_response: "Informal Review Pending",
  scheduled: "Informal Review Scheduled",
  proposed_value_received: "Offer Received",
  accepted: "Offer Accepted",
  rejected: "Formal Hearing Needed",
  no_informal_available: "Formal Hearing Needed",
};

export type AppraiserCategory =
  | "Land Appraiser"
  | "Improvement Appraiser"
  | "Commercial Appraiser"
  | "Retail Appraiser"
  | "Office Appraiser"
  | "Daycare/School Appraiser"
  | "Other";

// Who will actually attend the hearing — see HearingPrepSection in
// CaseDetailModal.tsx. User-selected, not inferred: an Appointment of
// Agent (Form 50-162) on file means an agent CAN attend, not that they
// will.
export type AttendanceType = "Property Owner" | "Authorized Agent" | "Both";

export type ProtestRecord = {
  id: string;
  propertyId: string;
  status: ProtestStatus;
  notes: string | null;
  requestedAt: string;
  updatedAt: string;
  originalValue: number | null;
  settlementOfferValue: number | null;
  settlementOfferReceivedAt: string | null;
  hearingDate: string | null;
  // Real detail from an actual uploaded hearing notice (see
  // extract-hearing-notice / hearing-notice.ts) — null whenever the hearing
  // date was set manually instead (CaseProgress's own date input), same as
  // hearingDate was before this existed.
  hearingTime: string | null;
  hearingLocation: string | null;
  hearingMode: "In Person" | "Phone" | "Videoconference" | "Affidavit" | "Unknown" | null;
  arbDecision: ArbDecision | null;
  arbDecisionDate: string | null;
  finalValue: number | null;
  escalationPath: EscalationPath | null;
  closedAt: string | null;
  taxYear: number | null;
  // When the customer acknowledged Corvus's "AI Guidance & Filing Notice" —
  // null until then, never reset once set. See CorvusGuidanceGate in
  // CaseDetailModal.tsx, which gates entry into a not-yet-filed case on this.
  corvusGuidanceAckAt: string | null;
  informalStatus: InformalStatus;
  informalReviewDate: string | null;
  informalAppraiserCategory: AppraiserCategory | null;
  attendanceType: AttendanceType | null;
  // Case-record fields — see src/lib/case-record.ts. Optional (not just
  // nullable) so the many ProtestRecord fixtures/builders that predate them
  // don't all need updating; fromRow (the real path) always populates them.
  filingConfirmationNumber?: string | null;
  filingChannel?: "online" | "mail" | "in_person" | "email" | null;
  certifiedMailTracking?: string | null;
  evidenceSubmittedConfirmedAt?: string | null;
};

type ProtestRow = {
  id: string;
  property_id: string;
  status: ProtestStatus;
  notes: string | null;
  requested_at: string;
  updated_at: string;
  original_value: number | null;
  settlement_offer_value: number | null;
  settlement_offer_received_at: string | null;
  hearing_date: string | null;
  hearing_time: string | null;
  hearing_location: string | null;
  hearing_mode: "In Person" | "Phone" | "Videoconference" | "Affidavit" | "Unknown" | null;
  arb_decision: ArbDecision | null;
  arb_decision_date: string | null;
  final_value: number | null;
  escalation_path: EscalationPath | null;
  closed_at: string | null;
  tax_year: number | null;
  corvus_guidance_ack_at: string | null;
  informal_status: InformalStatus;
  informal_review_date: string | null;
  informal_appraiser_category: AppraiserCategory | null;
  attendance_type: AttendanceType | null;
  filing_confirmation_number: string | null;
  filing_channel: "online" | "mail" | "in_person" | "email" | null;
  certified_mail_tracking: string | null;
  evidence_submitted_confirmed_at: string | null;
};

const SELECT_COLUMNS =
  "id, property_id, status, notes, requested_at, updated_at, original_value, settlement_offer_value, settlement_offer_received_at, hearing_date, hearing_time, hearing_location, hearing_mode, arb_decision, arb_decision_date, final_value, escalation_path, closed_at, tax_year, corvus_guidance_ack_at, informal_status, informal_review_date, informal_appraiser_category, attendance_type, filing_confirmation_number, filing_channel, certified_mail_tracking, evidence_submitted_confirmed_at";

function fromRow(row: ProtestRow): ProtestRecord {
  return {
    id: row.id,
    propertyId: row.property_id,
    status: row.status,
    notes: row.notes,
    requestedAt: row.requested_at,
    updatedAt: row.updated_at,
    originalValue: row.original_value,
    settlementOfferValue: row.settlement_offer_value,
    settlementOfferReceivedAt: row.settlement_offer_received_at,
    hearingDate: row.hearing_date,
    hearingTime: row.hearing_time,
    hearingLocation: row.hearing_location,
    hearingMode: row.hearing_mode,
    arbDecision: row.arb_decision,
    arbDecisionDate: row.arb_decision_date,
    finalValue: row.final_value,
    escalationPath: row.escalation_path,
    closedAt: row.closed_at,
    taxYear: row.tax_year,
    corvusGuidanceAckAt: row.corvus_guidance_ack_at,
    informalStatus: row.informal_status,
    informalReviewDate: row.informal_review_date,
    informalAppraiserCategory: row.informal_appraiser_category,
    attendanceType: row.attendance_type,
    filingConfirmationNumber: row.filing_confirmation_number,
    filingChannel: row.filing_channel,
    certifiedMailTracking: row.certified_mail_tracking,
    evidenceSubmittedConfirmedAt: row.evidence_submitted_confirmed_at,
  };
}

// Filing and hearing representation happen off-platform by CorvusPT staff (per the
// /property-protest page's own description) — this creates the real request record
// staff act on; there is no automated filing today, so status only ever advances via
// the admin panel or the case-progress actions in protest-case.ts. `details` is used
// only for the staff notification below and the original-value snapshot — the
// request itself is fully recorded in the DB regardless of whether that send works.
export async function requestProtest(
  userId: string,
  propertyId: string,
  details?: {
    address?: string;
    userEmail?: string;
    originalValue?: number | null;
    taxYear?: number | null;
  },
): Promise<ProtestRecord> {
  const { data, error } = await supabase
    .from("protests")
    .insert({
      property_id: propertyId,
      user_id: userId,
      original_value: details?.originalValue ?? null,
      tax_year: details?.taxYear ?? null,
    })
    .select(SELECT_COLUMNS)
    .single();
  if (error) throw error;
  const created = fromRow(data as ProtestRow);

  // Best-effort staff notification — previously a request only surfaced if staff
  // happened to check the admin panel's "Protest Requests" list themselves.
  const address = details?.address ?? `property ${propertyId}`;
  submitWeb3Form({
    subject: "New protest filing request — CorvusPT.ai",
    from_name: "CorvusPT.ai",
    property_address: address,
    property_id: propertyId,
    user_email: details?.userEmail ?? "(unknown)",
    message: `A protest filing was requested for ${address} by ${details?.userEmail ?? `user ${userId}`}. Update its status in the admin panel.`,
  }).catch((err) => console.error("Protest request staff notification failed:", err));

  return created;
}

// Records that the customer has acknowledged Corvus's "AI Guidance & Filing
// Notice" for this case — see CorvusGuidanceGate in CaseDetailModal.tsx. A
// one-way write (no "un-acknowledge"); the gate only ever checks whether this
// is null, never re-shown once set.
export async function acknowledgeGuidance(protestId: string): Promise<void> {
  const { error } = await supabase
    .from("protests")
    .update({ corvus_guidance_ack_at: new Date().toISOString() })
    .eq("id", protestId);
  if (error) throw error;
}

export async function listProtests(userId: string): Promise<ProtestRecord[]> {
  const { data, error } = await supabase
    .from("protests")
    .select(SELECT_COLUMNS)
    .eq("user_id", userId)
    .order("requested_at", { ascending: false });
  if (error) throw error;
  return (data as ProtestRow[]).map(fromRow);
}
