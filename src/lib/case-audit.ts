import { supabase } from "./supabase";

// Append-only, per-case audit trail (public.case_audit_events). One row per
// meaningful event in a protest's life: a status change, a document added, a
// form submitted or signed, a submission confirmed, a deadline set, a county
// communication logged, a value recorded, a free note. This is the owner's
// own record — distinct from admin_audit_log (staff actions).
//
// logCaseEvent() is written fire-and-forget from the case mutation helpers
// (protest-case.ts) and the case doc-upload paths: a failed insert here must
// never break the real update, so every caller ignores its result. It reads
// the current user from the session itself, so callers only pass the event.

export type CaseAuditKind =
  | "status_change"
  | "document_added"
  | "form_submitted"
  | "signature_captured"
  | "submission_confirmed"
  | "deadline_set"
  | "county_communication"
  | "value_recorded"
  | "note";

export type CaseAuditEvent = {
  id: string;
  protestId: string;
  kind: CaseAuditKind;
  summary: string;
  detail: Record<string, unknown> | null;
  occurredAt: string;
};

export async function logCaseEvent(
  protestId: string,
  kind: CaseAuditKind,
  summary: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    await supabase.from("case_audit_events").insert({
      protest_id: protestId,
      user_id: user.id,
      kind,
      summary,
      detail: detail ?? null,
    });
  } catch {
    // Audit is a side record — never surface or rethrow.
  }
}

export async function getCaseAuditTrail(protestId: string): Promise<CaseAuditEvent[]> {
  const { data, error } = await supabase
    .from("case_audit_events")
    .select("id, protest_id, kind, summary, detail, occurred_at")
    .eq("protest_id", protestId)
    .order("occurred_at", { ascending: false });
  if (error || !data) return [];
  return data.map((r) => ({
    id: r.id as string,
    protestId: r.protest_id as string,
    kind: r.kind as CaseAuditKind,
    summary: r.summary as string,
    detail: (r.detail as Record<string, unknown> | null) ?? null,
    occurredAt: r.occurred_at as string,
  }));
}

const KIND_LABEL: Record<CaseAuditKind, string> = {
  status_change: "Status change",
  document_added: "Document added",
  form_submitted: "Form submitted",
  signature_captured: "Signature captured",
  submission_confirmed: "Submission confirmed",
  deadline_set: "Deadline set",
  county_communication: "County communication",
  value_recorded: "Value recorded",
  note: "Note",
};

export function caseAuditKindLabel(kind: CaseAuditKind): string {
  return KIND_LABEL[kind] ?? "Event";
}
