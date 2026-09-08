import { supabase } from "./supabase";

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

export type DocumentRecord = {
  id: string;
  propertyId: string;
  fileName: string;
  storagePath: string;
  documentType: string | null;
  uploadedAt: string;
};

type DocumentRow = {
  id: string;
  property_id: string;
  file_name: string;
  storage_path: string;
  document_type: string | null;
  uploaded_at: string;
};

function fromRow(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    propertyId: row.property_id,
    fileName: row.file_name,
    storagePath: row.storage_path,
    documentType: row.document_type,
    uploadedAt: row.uploaded_at,
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
    })
    .select()
    .single();
  if (error) throw error;
  return fromRow(data as DocumentRow);
}

export async function listDocuments(userId: string): Promise<DocumentRecord[]> {
  const { data, error } = await supabase
    .from("documents")
    .select("id, property_id, file_name, storage_path, document_type, uploaded_at")
    .eq("user_id", userId)
    .order("uploaded_at", { ascending: false });
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
  return docs.filter(
    (d) => d.propertyId === propertyId && d.documentType === PROTEST_EVIDENCE_DOCUMENT_TYPE,
  );
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
    .select("id, property_id, file_name, storage_path, document_type, uploaded_at")
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

// Row delete is the one that matters (it's what the RLS "Users can delete their
// own documents" policy governs, and what makes the file disappear from the
// UI). Removing the storage object is best-effort cleanup — an orphaned object
// is invisible to the user; a failed row delete is not.
export async function deleteDocument(doc: DocumentRecord): Promise<void> {
  const { error } = await supabase.from("documents").delete().eq("id", doc.id);
  if (error) throw error;
  await supabase.storage
    .from("documents")
    .remove([doc.storagePath])
    .catch(() => {});
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

// A consistent human label for a file regardless of what it was actually named
// on the user's disk ("Site plan.PDF", "IMG_2043.jpg", "scan (3).pdf"). The
// stored file isn't renamed — this is display only.
export function standardDocName(doc: DocumentRecord, accountNumber: string | null): string {
  const { label } = categorizeDocument(doc.documentType);
  const when = new Date(doc.uploadedAt).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
  });
  return [accountNumber ? `Acct ${accountNumber}` : null, label, when].filter(Boolean).join(" · ");
}

// Rough preview kind from the file name — the documents table doesn't store a
// mime type. Anything not previewable inline falls back to a download prompt.
export function previewKind(fileName: string): "pdf" | "image" | "none" {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "tiff"].includes(ext)) return "image";
  return "none";
}
