import { supabase } from "./supabase";
import { invokeEdgeFunction } from "./edge-functions";
import { bytesToBase64 } from "./pdf-utils";
import type { PropertyRecord } from "./properties";
import type { ProtestRecord } from "./protests";

// Real, AI-extracted content from an actual ARB Order / hearing decision /
// settlement / revised value notice / other final determination the user
// uploads after a hearing — see extract-decision-document/index.ts for the
// prompt/discipline (shared with settlement-agreement.ts's pre-signature
// verification). discrepancies is computed server-side, deterministically,
// never the model's own say-so.
export type DecisionDocumentCategory =
  | "ARB Order"
  | "Hearing Decision"
  | "Settlement"
  | "Revised Value Notice"
  | "County Decision"
  | "Other";

export type DecisionExtraction = {
  documentCategory: DecisionDocumentCategory;
  originalValue: number | null;
  finalValue: number | null;
  decisionDate: string | null;
  taxYear: string | null;
  accountNumber: string | null;
  propertyAddress: string | null;
  settlementTerms: string | null;
  appealDeadline: string | null;
  refundIndicator: string | null;
  otherConditions: string | null;
  discrepancies: string[];
  // Only meaningful when the caller asked for a signed copy to be verified
  // (extractDecisionDocument's { expectSigned } option) — the post-hearing
  // decision path never reads these. "Unclear" / null otherwise.
  signaturePresent?: "Yes" | "No" | "Unclear";
  signedDate?: string | null;
};

export type DecisionNoticeRecord = DecisionExtraction & {
  id: string;
  protestId: string;
  documentId: string | null;
  createdAt: string;
};

async function fileToDataUrl(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mimeType = file.type || "application/octet-stream";
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
}

export async function extractDecisionDocument(
  property: PropertyRecord,
  protest: ProtestRecord,
  file: File,
  // Set when the upload is a signed copy the owner wants AI to verify — see
  // verifySignedSettlementCopy in settlement-agreement.ts. Makes the edge
  // function report signaturePresent / signedDate.
  opts?: { expectSigned?: boolean },
): Promise<DecisionExtraction> {
  const dataUrl = await fileToDataUrl(file);
  return invokeEdgeFunction<DecisionExtraction>("extract-decision-document", {
    caseContext: {
      address: property.address,
      cad: property.cad,
      accountNumber: property.accountNumber,
      taxYear: property.taxYear ?? protest.taxYear,
      originalValue: protest.originalValue,
      expectSigned: opts?.expectSigned ?? false,
    },
    documents: [
      { fileName: file.name, mimeType: file.type || "application/octet-stream", dataUrl },
    ],
  });
}

type DecisionNoticeRow = {
  id: string;
  protest_id: string;
  document_id: string | null;
  document_category: string | null;
  original_value: number | null;
  final_value: number | null;
  decision_date: string | null;
  extracted_tax_year: string | null;
  extracted_account_number: string | null;
  extracted_property_address: string | null;
  settlement_terms: string | null;
  appeal_deadline: string | null;
  refund_indicator: string | null;
  other_conditions: string | null;
  discrepancies: string | null;
  created_at: string;
};

function fromRow(row: DecisionNoticeRow): DecisionNoticeRecord {
  const parseArray = (v: string | null): string[] => {
    if (!v) return [];
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  };
  return {
    id: row.id,
    protestId: row.protest_id,
    documentId: row.document_id,
    documentCategory: (row.document_category as DecisionDocumentCategory) ?? "Other",
    originalValue: row.original_value,
    finalValue: row.final_value,
    decisionDate: row.decision_date,
    taxYear: row.extracted_tax_year,
    accountNumber: row.extracted_account_number,
    propertyAddress: row.extracted_property_address,
    settlementTerms: row.settlement_terms,
    appealDeadline: row.appeal_deadline,
    refundIndicator: row.refund_indicator,
    otherConditions: row.other_conditions,
    discrepancies: parseArray(row.discrepancies),
    createdAt: row.created_at,
  };
}

export async function saveDecisionNotice(
  userId: string,
  protestId: string,
  documentId: string | null,
  extraction: DecisionExtraction,
): Promise<DecisionNoticeRecord> {
  const { data, error } = await supabase
    .from("decision_notices")
    .insert({
      protest_id: protestId,
      user_id: userId,
      document_id: documentId,
      document_category: extraction.documentCategory,
      original_value: extraction.originalValue,
      final_value: extraction.finalValue,
      decision_date: extraction.decisionDate,
      extracted_tax_year: extraction.taxYear,
      extracted_account_number: extraction.accountNumber,
      extracted_property_address: extraction.propertyAddress,
      settlement_terms: extraction.settlementTerms,
      appeal_deadline: extraction.appealDeadline,
      refund_indicator: extraction.refundIndicator,
      other_conditions: extraction.otherConditions,
      discrepancies: JSON.stringify(extraction.discrepancies),
    })
    .select()
    .single();
  if (error) throw error;
  return fromRow(data as DecisionNoticeRow);
}

// Most recent decision document on file — a case could genuinely receive
// more than one over its life (a first ARB Order, then a corrected one);
// the latest is what the UI shows.
export async function getLatestDecisionNotice(
  protestId: string,
): Promise<DecisionNoticeRecord | null> {
  const { data, error } = await supabase
    .from("decision_notices")
    .select("*")
    .eq("protest_id", protestId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? fromRow(data as DecisionNoticeRow) : null;
}
