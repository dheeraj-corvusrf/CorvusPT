import { supabase } from "./supabase";
import { invokeEdgeFunction } from "./edge-functions";

// document_type is free-text (no schema enum), so this is just a convention shared
// between the upload call and the filter query that reads it back — see
// src/routes/ai-report.tsx's Improvement Condition module.
export const EVIDENCE_DOCUMENT_TYPE = "Improvement Evidence";

// Same convention, for a real protest case's own evidence — shared between
// CaseDetailModal's per-item checklist upload and ai-report.tsx's Module 8
// upload widget, so a file uploaded via either path shows up as the same
// tagged evidence, not two similarly-named-but-different strings.
export const PROTEST_EVIDENCE_DOCUMENT_TYPE = "Protest Evidence";

// Uploaded once a user confirms they've actually submitted their protest to
// the county (see DocumentsSection's "Have you filed?" prompt) — optional,
// best-effort proof, never required to mark a case Filed.
export const FILING_PROOF_DOCUMENT_TYPE = "Filing Proof";

// A real settlement offer document the county sent for signature — see
// settlement-agreement.ts. The original upload keeps this type; once
// signed, the certified copy is re-uploaded under
// SETTLEMENT_SIGNED_DOCUMENT_TYPE so both the original and the signed
// version stay on file.
export const SETTLEMENT_DOCUMENT_TYPE = "Settlement Agreement";
export const SETTLEMENT_SIGNED_DOCUMENT_TYPE = "Settlement Agreement — Signed";

// A real post-hearing decision document (ARB Order, hearing decision,
// revised value notice, etc.) — see decision-notice.ts.
export const DECISION_DOCUMENT_TYPE = "Hearing Decision Document";

// Case-record document types (see src/lib/case-record.ts) — the proof items
// a complete case file should hold that don't fit any category above. All
// free-text, same convention as the constants above.
export const CONFIRMATION_DOCUMENT_TYPE = "Filing Confirmation"; // portal/email confirmation, screenshots, certified-mail receipt
export const CORRESPONDENCE_DOCUMENT_TYPE = "County Correspondence"; // informal correspondence, county staff notes
export const EVIDENCE_SUBMISSION_DOCUMENT_TYPE = "Evidence Submission Confirmation";
export const ARB_ORDER_DOCUMENT_TYPE = "ARB Order";
export const ESCALATION_DOCUMENT_TYPE = "Escalation Document";

export type AiVerdict = "valid" | "issues" | "invalid";

export type DocumentRecord = {
  id: string;
  propertyId: string;
  fileName: string;
  storagePath: string;
  documentType: string | null;
  uploadedAt: string;
  // Set by the analyze-document edge function (null until a check is run).
  // Optional (not just nullable) so existing test fixtures / stub builders
  // that predate these columns don't all need updating — fromRow (the real
  // path) always populates them.
  category?: string | null;
  source?: string | null;
  aiVerdict?: AiVerdict | null;
  aiNotes?: string | null;
  aiCrossRefs?: string | null;
  aiCheckedAt?: string | null;
  suggestedName?: string | null;
  // Documents-workspace fields (see schema.sql). deletedAt set = in the
  // trash. useAsEvidence: user's explicit include/exclude for the protest
  // evidence packet (null = fall back to documentType). editedFrom: the id
  // of the file this one was AI-edited from.
  deletedAt?: string | null;
  useAsEvidence?: boolean | null;
  duplicateOf?: string | null;
  dupReviewed?: boolean;
  aiExplanation?: string | null;
  editedFrom?: string | null;
};

type DocumentRow = {
  id: string;
  property_id: string;
  file_name: string;
  storage_path: string;
  document_type: string | null;
  uploaded_at: string;
  category: string | null;
  source: string | null;
  ai_verdict: AiVerdict | null;
  ai_notes: string | null;
  ai_cross_refs: string | null;
  ai_checked_at: string | null;
  suggested_name: string | null;
  deleted_at: string | null;
  use_as_evidence: boolean | null;
  duplicate_of: string | null;
  dup_reviewed: boolean | null;
  ai_explanation: string | null;
  edited_from: string | null;
};

const SELECT_COLUMNS =
  "id, property_id, file_name, storage_path, document_type, uploaded_at, category, source, ai_verdict, ai_notes, ai_cross_refs, ai_checked_at, suggested_name, deleted_at, use_as_evidence, duplicate_of, dup_reviewed, ai_explanation, edited_from";

function fromRow(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    propertyId: row.property_id,
    fileName: row.file_name,
    storagePath: row.storage_path,
    documentType: row.document_type,
    uploadedAt: row.uploaded_at,
    category: row.category,
    source: row.source,
    aiVerdict: row.ai_verdict,
    aiNotes: row.ai_notes,
    aiCrossRefs: row.ai_cross_refs,
    aiCheckedAt: row.ai_checked_at,
    suggestedName: row.suggested_name,
    deletedAt: row.deleted_at,
    useAsEvidence: row.use_as_evidence,
    duplicateOf: row.duplicate_of,
    dupReviewed: row.dup_reviewed ?? false,
    aiExplanation: row.ai_explanation,
    editedFrom: row.edited_from,
  };
}

// Uploads the original file to the private "documents" bucket and indexes it — called
// right after a property is confirmed/saved, so the dashboard's Documents tab has a
// real file to list instead of only the AI-extracted field values.
export async function uploadDocument(
  userId: string,
  propertyId: string,
  file: File,
  documentType?: string | null,
  // Set when this file is an AI-edited copy of another document — links the
  // new row back to its source (documents.edited_from).
  editedFrom?: string | null,
): Promise<DocumentRecord> {
  const storagePath = `${userId}/${propertyId}/${Date.now()}-${file.name}`;
  const { error: uploadError } = await supabase.storage
    .from("documents")
    .upload(storagePath, file, { contentType: file.type });
  if (uploadError) throw uploadError;

  const { data, error } = await supabase
    .from("documents")
    .insert({
      property_id: propertyId,
      user_id: userId,
      file_name: file.name,
      storage_path: storagePath,
      document_type: documentType ?? null,
      edited_from: editedFrom ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return fromRow(data as DocumentRow);
}

// Live documents only — soft-deleted rows (deleted_at set) are excluded so
// they never leak into the evidence packet, Module 8, or the pre-filing
// check. The Documents tab's trash uses listTrashedDocuments below.
export async function listDocuments(userId: string): Promise<DocumentRecord[]> {
  const { data, error } = await supabase
    .from("documents")
    .select(SELECT_COLUMNS)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .order("uploaded_at", { ascending: false });
  if (error) throw error;
  return (data as DocumentRow[]).map(fromRow);
}

// Soft-deleted documents from the last 30 days — the "Recently deleted" list.
export async function listTrashedDocuments(userId: string): Promise<DocumentRecord[]> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("documents")
    .select(SELECT_COLUMNS)
    .eq("user_id", userId)
    .not("deleted_at", "is", null)
    .gte("deleted_at", cutoff)
    .order("deleted_at", { ascending: false });
  if (error) throw error;
  return (data as DocumentRow[]).map(fromRow);
}

// Real "Protest Evidence"-tagged documents for one property — the same
// query ai-report.tsx's Module 8 already uses to show its own upload list
// (queried directly, not scoped to any protest_evidence_items checklist
// link), reused so anything that needs to know "how much evidence has this
// customer actually uploaded" (CaseDetailModal's Upload Evidence prompt,
// draftProtestReason, the Pre-Filing Check row) reads the same real,
// single source of truth Module 8 writes to.
export async function getProtestEvidenceDocuments(
  userId: string,
  propertyId: string,
): Promise<DocumentRecord[]> {
  const docs = await listDocuments(userId);
  return docs.filter((d) => d.propertyId === propertyId && isEvidenceDoc(d));
}

// Whether a document feeds the protest evidence packet. The user's explicit
// use_as_evidence choice wins (true = include even a non-evidence-typed
// file; false = exclude even a "Protest Evidence" one); null falls back to
// the document_type tag.
export function isEvidenceDoc(d: DocumentRecord): boolean {
  if (d.useAsEvidence === true) return true;
  if (d.useAsEvidence === false) return false;
  return d.documentType === PROTEST_EVIDENCE_DOCUMENT_TYPE;
}

// Real "Filing Proof"-tagged documents for one property — see
// CaseDetailModal.tsx's "Have you completed and submitted your property
// protest?" flow. The case is never marked Filed without at least one of
// these on file (see handleConfirmFiled).
export async function getFilingProofDocuments(
  userId: string,
  propertyId: string,
): Promise<DocumentRecord[]> {
  const docs = await listDocuments(userId);
  return docs.filter(
    (d) => d.propertyId === propertyId && d.documentType === FILING_PROOF_DOCUMENT_TYPE,
  );
}

// One real document by id — used where a caller only has a stored
// document_id (e.g. settlement_agreements.document_id/signed_document_id)
// and needs the real fileName/storagePath back, not just the id.
export async function getDocumentById(userId: string, id: string): Promise<DocumentRecord | null> {
  const { data, error } = await supabase
    .from("documents")
    .select(SELECT_COLUMNS)
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? fromRow(data as DocumentRow) : null;
}

export async function getDocumentUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from("documents")
    .createSignedUrl(storagePath, 60 * 5);
  if (error) throw error;
  return data.signedUrl;
}

// Soft delete — the row and its storage object stay so the delete can be
// undone (Undo toast) or restored from "Recently deleted". A real purge is
// purgeDocument() below.
export async function deleteDocument(doc: DocumentRecord): Promise<void> {
  const { error } = await supabase
    .from("documents")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", doc.id);
  if (error) throw error;
}

export async function restoreDocument(id: string): Promise<void> {
  const { error } = await supabase.from("documents").update({ deleted_at: null }).eq("id", id);
  if (error) throw error;
}

// Permanent delete — row delete (governed by the RLS "Users can delete their
// own documents" policy) plus best-effort storage cleanup. Used by "Delete
// permanently" in the trash.
export async function purgeDocument(doc: DocumentRecord): Promise<void> {
  const { error } = await supabase.from("documents").delete().eq("id", doc.id);
  if (error) throw error;
  await supabase.storage
    .from("documents")
    .remove([doc.storagePath])
    .catch(() => {});
}

export async function setUseAsEvidence(id: string, value: boolean | null): Promise<void> {
  const { error } = await supabase
    .from("documents")
    .update({ use_as_evidence: value })
    .eq("id", id);
  if (error) throw error;
}

// Records that the user has resolved the "possible duplicate" prompt for a
// document. Pass the other document's id to note which file this one dupes.
export async function markDuplicateReviewed(
  id: string,
  duplicateOf: string | null = null,
): Promise<void> {
  const { error } = await supabase
    .from("documents")
    .update({ dup_reviewed: true, duplicate_of: duplicateOf })
    .eq("id", id);
  if (error) throw error;
}

// A small, honest display taxonomy over the free-text document_type — for the
// category badge, the "where it came from" hint, and which step/module a file
// feeds. Keyword-matched because document_type comes from several places
// (classify-document's extraction, the *_DOCUMENT_TYPE constants above,
// hand-set strings) and isn't a fixed enum.
export type DocCategory = {
  label: string;
  source: "county" | "uploaded" | "signed" | "generated";
  feeds: string | null;
};

export function categorizeDocument(documentType: string | null): DocCategory {
  const t = (documentType ?? "").toLowerCase();
  const has = (...needles: string[]) => needles.some((n) => t.includes(n));

  if (has("— signed", "agreement — signed") || (has("settlement") && has("sign"))) {
    return { label: "Signed agreement", source: "signed", feeds: "Settlement" };
  }
  if (has("settlement agreement", "settlement offer")) {
    return { label: "Settlement offer", source: "county", feeds: "Settlement" };
  }
  if (
    has("arb order", "order determining", "hearing decision", "decision document", "revised value")
  ) {
    return { label: "Hearing decision", source: "county", feeds: "Decision step" };
  }
  if (has("filing proof", "proof of filing", "protest confirmation", "efile")) {
    return { label: "Filing proof", source: "uploaded", feeds: "Submit step" };
  }
  if (has("hearing", "arb notice", "notice of hearing")) {
    return { label: "Hearing notice", source: "county", feeds: "Track step" };
  }
  if (has("improvement evidence")) {
    return { label: "Evidence", source: "uploaded", feeds: "Module 5 · Improvement" };
  }
  if (has("protest evidence", "comparable", "comp ", "photo")) {
    return { label: "Evidence", source: "uploaded", feeds: "Protest evidence" };
  }
  if (has("appraisal notice", "notice of appraised value", "noav")) {
    return { label: "Appraisal notice", source: "county", feeds: "AI Review" };
  }
  if (has("tax bill", "tax statement", "tax receipt")) {
    return { label: "Tax bill", source: "county", feeds: "Deadlines" };
  }
  if (has("bpp", "business personal property", "rendition")) {
    return { label: "BPP rendition", source: "county", feeds: "BPP" };
  }
  if (has("deed", "warranty deed", "closing")) {
    return { label: "Deed", source: "uploaded", feeds: null };
  }
  if (has("report")) {
    return { label: "Report", source: "generated", feeds: null };
  }
  return { label: documentType?.trim() || "Other", source: "uploaded", feeds: null };
}

const SOURCE_LABEL: Record<DocCategory["source"], string> = {
  county: "From the county",
  uploaded: "You uploaded",
  signed: "Signed",
  generated: "AI-generated",
};

export function sourceLabel(source: DocCategory["source"]): string {
  return SOURCE_LABEL[source];
}

// Canonical category (public.documents.category) set by analyze-document —
// preferred over the keyword guess once a document has been checked.
export const CATEGORY_LABEL: Record<string, string> = {
  appraisal_notice: "Appraisal notice",
  tax_bill: "Tax bill",
  bpp_rendition: "BPP rendition",
  hearing_notice: "Hearing notice",
  hearing_decision: "Hearing decision",
  settlement_offer: "Settlement offer",
  signed_agreement: "Signed agreement",
  filing_proof: "Filing proof",
  evidence: "Evidence",
  deed: "Deed",
  report: "Report",
  correspondence: "Correspondence",
  other: "Other",
};

const CATEGORY_FEEDS: Record<string, string> = {
  appraisal_notice: "AI Review",
  tax_bill: "Deadlines",
  bpp_rendition: "BPP",
  hearing_notice: "Track step",
  hearing_decision: "Decision step",
  settlement_offer: "Settlement",
  signed_agreement: "Settlement",
  filing_proof: "Submit step",
  evidence: "Protest evidence",
};

const SOURCE_OF_CANONICAL: Record<string, DocCategory["source"]> = {
  county: "county",
  uploaded: "uploaded",
  signed: "signed",
  generated: "generated",
};

// The category / source / feeds triple for a document — from the stored
// canonical fields once analyze-document has run, otherwise the keyword guess.
export function docCategory(doc: DocumentRecord): DocCategory {
  if (doc.category && CATEGORY_LABEL[doc.category]) {
    return {
      label: CATEGORY_LABEL[doc.category],
      source: SOURCE_OF_CANONICAL[doc.source ?? ""] ?? "uploaded",
      feeds: CATEGORY_FEEDS[doc.category] ?? null,
    };
  }
  return categorizeDocument(doc.documentType);
}

// A consistent human label for a file regardless of what it was actually named
// on the user's disk ("Site plan.PDF", "IMG_2043.jpg", "scan (3).pdf"). The
// stored file isn't renamed — this is display only.
export function standardDocName(doc: DocumentRecord, accountNumber: string | null): string {
  const { label } = docCategory(doc);
  const when = new Date(doc.uploadedAt).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
  });
  return [accountNumber ? `Acct ${accountNumber}` : null, label, when].filter(Boolean).join(" · ");
}

export type DocAnalysis = {
  documentId: string;
  category: string;
  source: string;
  verdict: AiVerdict;
  notes: string;
  crossRefs: string[];
  suggestedName: string | null;
  aiCheckedAt: string;
};

// Runs the per-document AI check (analyze-document edge function): classifies
// it, checks it against the property on file and the other documents, writes
// the verdict/notes/suggested name back to the row, and returns the analysis.
export async function analyzeDocument(documentId: string): Promise<DocAnalysis> {
  return invokeEdgeFunction<DocAnalysis>("analyze-document", { documentId });
}

// Apply a suggested rename — file_name is the one field a user may now change
// on an existing document row (see the column grant in schema.sql). The stored
// object keeps its original storage_path; only the display name changes.
export async function renameDocument(id: string, fileName: string): Promise<void> {
  const { error } = await supabase.from("documents").update({ file_name: fileName }).eq("id", id);
  if (error) throw error;
}

const VERDICT_META: Record<
  AiVerdict,
  { label: string; tone: "success" | "warning" | "destructive" }
> = {
  valid: { label: "Checks out", tone: "success" },
  issues: { label: "Has issues", tone: "warning" },
  invalid: { label: "Doesn't match", tone: "destructive" },
};

export function verdictMeta(v: AiVerdict | null | undefined) {
  return v ? VERDICT_META[v] : { label: "Not checked", tone: "warning" as const };
}

// Rough preview kind from the file name — the documents table doesn't store a
// mime type. Anything not previewable inline falls back to a download prompt.
export function previewKind(fileName: string): "pdf" | "image" | "none" {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "tiff"].includes(ext)) return "image";
  return "none";
}
