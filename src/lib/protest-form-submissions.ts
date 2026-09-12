import { supabase } from "./supabase";
import type { FieldValues } from "./protest-documents";
import type { SignatureValue } from "@/components/SignaturePad";

// "evidence" has no PDF/signature of its own — it's here purely so the
// Evidence package gets the same per-document filing-method tracking
// (below) as the three real Comptroller forms, via the same
// (protest_id, form_type) row shape.
export type FormType =
  "notice_of_protest" | "appointment_of_agent" | "evidence_declaration" | "evidence";

export type FilingMethod = "online" | "mail" | "in_person" | "email";

export type FormSubmission = {
  fieldValues: FieldValues;
  signature: SignatureValue | null;
  signedAt: string | null;
  documentId: string | null;
  // How this specific document is being submitted to the county — a county
  // can allow a different method for the Notice of Protest than for the
  // Agent form, so this is tracked per (protest, form_type) row, not once
  // per case (see protests.filing_channel for the separate case-level
  // mirror File Protest also writes, read by CaseRecordSection).
  filingMethod: FilingMethod | null;
  // Online: the portal's confirmation code. Reused generically — any method
  // can have a reference number worth recording even without a receipt photo.
  filingConfirmationNumber: string | null;
  mailTrackingNumber: string | null;
  // The mocked Email flow's own sent-log — Corvus prepares a draft and the
  // user sends it from their own mail client; this is what they tell us they
  // sent, not something read back from an inbox (see the Filing Method &
  // Submission workflow's own comment for why — no email integration exists
  // in this app).
  emailRecipient: string | null;
  emailSubject: string | null;
  emailSentAt: string | null;
  // The user's own explicit "yes, the county has this" — set once real proof
  // (a reference number or an uploaded document) is on file. Same "customer's
  // own word + real evidence, never auto-confirmed" discipline as
  // markFiled()/handleConfirmFiled elsewhere in this app.
  filingConfirmedAt: string | null;
  // The county came back asking for more on this document, after it was
  // already confirmed — see filingSubmissionStatus's own comment for how
  // this and filingConfirmedAt resolve into one status (newest wins, so a
  // fresh re-confirmation naturally clears an old request).
  additionalRequestedAt: string | null;
};

type SubmissionRow = {
  field_values: string;
  signature_type: "draw" | "type" | null;
  signature_data: string | null;
  signed_at: string | null;
  document_id: string | null;
  filing_method: FilingMethod | null;
  filing_confirmation_number: string | null;
  mail_tracking_number: string | null;
  email_recipient: string | null;
  email_subject: string | null;
  email_sent_at: string | null;
  filing_confirmed_at: string | null;
  additional_requested_at: string | null;
};

function fromRow(row: SubmissionRow): FormSubmission {
  return {
    fieldValues: JSON.parse(row.field_values) as FieldValues,
    signature:
      row.signature_type && row.signature_data
        ? { type: row.signature_type, data: row.signature_data }
        : null,
    signedAt: row.signed_at,
    documentId: row.document_id,
    filingMethod: row.filing_method,
    filingConfirmationNumber: row.filing_confirmation_number,
    mailTrackingNumber: row.mail_tracking_number,
    emailRecipient: row.email_recipient,
    emailSubject: row.email_subject,
    emailSentAt: row.email_sent_at,
    filingConfirmedAt: row.filing_confirmed_at,
    additionalRequestedAt: row.additional_requested_at,
  };
}

export async function getSubmission(
  protestId: string,
  formType: FormType,
): Promise<FormSubmission | null> {
  const { data, error } = await supabase
    .from("protest_form_submissions")
    .select(
      "field_values, signature_type, signature_data, signed_at, document_id, filing_method, filing_confirmation_number, mail_tracking_number, email_recipient, email_subject, email_sent_at, filing_confirmed_at, additional_requested_at",
    )
    .eq("protest_id", protestId)
    .eq("form_type", formType)
    .maybeSingle();
  if (error) throw error;
  return data ? fromRow(data as SubmissionRow) : null;
}

// Upserts on the (protest_id, form_type) unique key — one row per form per
// case, whether this is the first save or the hundredth edit.
export async function saveDraft(
  userId: string,
  protestId: string,
  formType: FormType,
  values: FieldValues,
): Promise<void> {
  const { error } = await supabase.from("protest_form_submissions").upsert(
    {
      protest_id: protestId,
      user_id: userId,
      form_type: formType,
      field_values: JSON.stringify(values),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "protest_id,form_type" },
  );
  if (error) throw error;
}

export async function signAndSubmit(
  userId: string,
  protestId: string,
  formType: FormType,
  values: FieldValues,
  signature: SignatureValue,
  documentId: string,
): Promise<void> {
  const { error } = await supabase.from("protest_form_submissions").upsert(
    {
      protest_id: protestId,
      user_id: userId,
      form_type: formType,
      field_values: JSON.stringify(values),
      signature_type: signature.type,
      signature_data: signature.data,
      signed_at: new Date().toISOString(),
      document_id: documentId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "protest_id,form_type" },
  );
  if (error) throw error;
}

// The three functions below only ever touch their own columns — never
// field_values/signature — so an upsert against an already-drafted form never
// clobbers it (and field_values defaults to '{}' in the database for a
// brand-new row, e.g. Evidence's, which has no draft of its own to lose).

export async function saveFilingMethod(
  userId: string,
  protestId: string,
  formType: FormType,
  method: FilingMethod,
): Promise<void> {
  const { error } = await supabase.from("protest_form_submissions").upsert(
    {
      protest_id: protestId,
      user_id: userId,
      form_type: formType,
      filing_method: method,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "protest_id,form_type" },
  );
  if (error) throw error;
}

export type FilingProofFields = Partial<{
  filingConfirmationNumber: string | null;
  mailTrackingNumber: string | null;
  emailRecipient: string | null;
  emailSubject: string | null;
  emailSentAt: string | null;
}>;

const FILING_PROOF_FIELD_COLUMN: Record<keyof FilingProofFields, string> = {
  filingConfirmationNumber: "filing_confirmation_number",
  mailTrackingNumber: "mail_tracking_number",
  emailRecipient: "email_recipient",
  emailSubject: "email_subject",
  emailSentAt: "email_sent_at",
};

export async function saveFilingProofFields(
  userId: string,
  protestId: string,
  formType: FormType,
  patch: FilingProofFields,
): Promise<void> {
  const row: Record<string, unknown> = {
    protest_id: protestId,
    user_id: userId,
    form_type: formType,
    updated_at: new Date().toISOString(),
  };
  for (const key of Object.keys(patch) as (keyof FilingProofFields)[]) {
    row[FILING_PROOF_FIELD_COLUMN[key]] = patch[key];
  }
  const { error } = await supabase
    .from("protest_form_submissions")
    .upsert(row, { onConflict: "protest_id,form_type" });
  if (error) throw error;
}

// The real, honest "this document is with the county" signal — see
// FormSubmission.filingConfirmedAt above. Returns the timestamp so the caller
// can update its own local state without a re-fetch.
export async function confirmFiling(
  userId: string,
  protestId: string,
  formType: FormType,
): Promise<string> {
  const at = new Date().toISOString();
  const { error } = await supabase.from("protest_form_submissions").upsert(
    {
      protest_id: protestId,
      user_id: userId,
      form_type: formType,
      filing_confirmed_at: at,
      updated_at: at,
    },
    { onConflict: "protest_id,form_type" },
  );
  if (error) throw error;
  return at;
}

// The county came back asking for more on this document — see
// FormSubmission.additionalRequestedAt above. Returns the timestamp so the
// caller can update its own local state without a re-fetch.
export async function requestAdditionalInfo(
  userId: string,
  protestId: string,
  formType: FormType,
): Promise<string> {
  const at = new Date().toISOString();
  const { error } = await supabase.from("protest_form_submissions").upsert(
    {
      protest_id: protestId,
      user_id: userId,
      form_type: formType,
      additional_requested_at: at,
      updated_at: at,
    },
    { onConflict: "protest_id,form_type" },
  );
  if (error) throw error;
  return at;
}
