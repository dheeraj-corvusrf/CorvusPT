// Session-scoped intake store for the guest flow.
import {
  classifyDocument,
  validateDocument,
  type Extraction,
  type DocumentType,
} from "./document-ai";
import { getFirstPage } from "./pdf-utils";
import type { CadDeed, CadValueHistoryEntry } from "./cad-lookup";
import type { SavingsEstimate } from "./savings-estimate";

export type AuditEntry = {
  ts: number;
  actor: "ai" | "user" | "staff";
  action: string;
  field?: string;
  from?: string | number | null;
  to?: string | number | null;
  reason?: string;
};

export type Workflow =
  | "real_property_protest"
  | "bpp_rendition"
  | "bpp_protest"
  | "tax_payment_tracking"
  | "refund_tracking"
  | "notice_epin_retrieval"
  | "hearing_decision_tracking";

export type WorkflowSuggestion = {
  workflow: Workflow;
  label: string;
  message: string;
  primary: boolean;
};

export type PropertyKind = "commercial" | "residential";

export type IntakeState = {
  // legacy address flow
  address?: string;
  propertyKind?: PropertyKind;
  cad?: string;
  accountNumber?: string;
  ownerName?: string;
  propertyType?: string;
  landValue?: number;
  improvementValue?: number;
  totalValue?: number;
  taxYear?: number;
  noticeFileName?: string;
  confirmed?: boolean;
  previewsUsed: string[];
  legalDescription?: string | null;
  subdivision?: string | null;
  geoId?: string | null;
  mailingAddress?: string | null;
  ownershipPct?: number | null;
  protestStatus?: string | null;
  // Fort Bend only — see the matching comment in cad-record-url.ts.
  bisPropertyId?: string | null;
  valueHistory?: CadValueHistoryEntry[];
  deeds?: CadDeed[];
  // Caches the computed savings estimate against the specific property it was
  // computed for (cachedSavingsKey), so refreshing the page or re-validating the
  // same address mid-intake reuses this result instead of re-calling the AI —
  // the AI's reductionPct judgment isn't guaranteed bit-identical call to call,
  // so without this cache the same address could show a visibly different
  // dollar amount on every refresh. See runValidation() in intake.tsx.
  cachedSavings?: SavingsEstimate;
  cachedSavingsKey?: string;
  // Free-text fallback answers to a strategy's missing-evidence prompt (Module 2's
  // evidence gate — see ai-report.tsx), keyed by strategy name. Session-scoped like
  // the rest of this store; not persisted server-side.
  strategyAnswers?: Record<string, string>;

  // document classification flow
  extraction?: Extraction;
  extractionEdited?: Partial<Extraction>;
  extractionConfirmed?: boolean;
  lowConfidenceFlag?: boolean;
  mismatchFlag?: boolean;
  routedWorkflows?: WorkflowSuggestion[];
  auditLog?: AuditEntry[];
  // Set once ai-report.tsx actually loads for this session's confirmed
  // property (see its own first useEffect) — the real "reached AI Review"
  // signal for JourneyTracker's Upload Documents/AI Review steps when no
  // notice was uploaded at all (upload is optional; extractionConfirmed
  // only ever gets set by document-review.tsx's confirm step, which a
  // no-upload path never visits, so it can't be the only signal or those
  // two steps stay stuck "incomplete" forever even after the user is
  // actively on the AI Review page).
  aiReviewReached?: boolean;
};

const KEY = "crf_intake";

// The uploaded File can't be serialized into sessionStorage, so it's held here in
// memory instead, across the client-side navigation from /intake (or "/") to
// /document-review. Only used to persist the original file to Storage on confirm —
// if the tab was reloaded (module state lost), the confirm step simply skips
// re-uploading the raw file, same as before this feature existed.
let pendingFile: File | null = null;

export function setPendingFile(file: File | null) {
  pendingFile = file;
}

export function takePendingFile(): File | null {
  const f = pendingFile;
  pendingFile = null;
  return f;
}

export function readIntake(): IntakeState {
  if (typeof window === "undefined") return { previewsUsed: [] };
  try {
    return JSON.parse(sessionStorage.getItem(KEY) || "") as IntakeState;
  } catch {
    return { previewsUsed: [] };
  }
}

export function writeIntake(state: IntakeState) {
  sessionStorage.setItem(KEY, JSON.stringify(state));
}

export function updateIntake(patch: Partial<IntakeState>): IntakeState {
  const current = readIntake();
  const next: IntakeState = {
    ...current,
    ...patch,
    previewsUsed: current.previewsUsed ?? [],
  };
  writeIntake(next);
  return next;
}

export function appendAudit(entry: Omit<AuditEntry, "ts">) {
  const s = readIntake();
  const log = s.auditLog ?? [];
  log.push({ ts: Date.now(), ...entry });
  return updateIntake({ auditLog: log });
}

export function resetIntake() {
  sessionStorage.removeItem(KEY);
}

// Merge extraction + user edits into the effective confirmed record.
export function effectiveExtraction(s: IntakeState): Extraction | null {
  if (!s.extraction) return null;
  return { ...s.extraction, ...(s.extractionEdited ?? {}) } as Extraction;
}

export const LOW_CONFIDENCE_THRESHOLD = 0.6;

// Single source of truth for upload limits — change here to change everywhere
// (client validation, error copy, and the /intake page's stated limits).
export const UPLOAD_LIMITS = {
  maxFileBytes: 15 * 1024 * 1024,
  maxPages: 5,
};

// Takes Blob (not just File) so callers can also convert a fetched document blob —
// see src/routes/ai-report.tsx's evidence-upload flow, which fetches an already
// -uploaded document back from its signed URL rather than holding onto the original File.
export function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Failed to read file"));
    r.readAsDataURL(file);
  });
}

// Shared by the home page's "Upload Appraisal Notice" button and the /intake upload
// widget so both go through the exact same validation + classification + audit trail.
export async function classifyAndStoreDocument(file: File): Promise<Extraction> {
  if (file.size > UPLOAD_LIMITS.maxFileBytes) {
    throw new Error(
      `Document exceeds ${Math.round(UPLOAD_LIMITS.maxFileBytes / (1024 * 1024))} MB maximum file size.`,
    );
  }
  if (!/pdf|png|jpe?g/i.test(file.type)) {
    throw new Error("Supported types: PDF, PNG, JPG.");
  }

  appendAudit({ actor: "user", action: "upload_document", to: file.name });

  // Stage 1: check page 1 only, before paying for a full extraction pass.
  const firstPage = await getFirstPage(file);
  if (firstPage.pageCount > UPLOAD_LIMITS.maxPages) {
    throw new Error(
      `This document has ${firstPage.pageCount} pages — the maximum is ${UPLOAD_LIMITS.maxPages}. ` +
        "Upload just the appraisal notice or tax bill pages.",
    );
  }

  const validation = await validateDocument({
    fileName: file.name,
    mimeType: firstPage.mimeType,
    dataUrl: firstPage.dataUrl,
  });
  if (!validation.isValid) {
    appendAudit({
      actor: "ai",
      action: "reject_invalid_document",
      reason: validation.reason ?? undefined,
    });
    throw new Error(
      validation.reason ??
        "This doesn't look like a Texas property tax document. Please try another file.",
    );
  }

  // Stage 2: full multi-field extraction across the whole document.
  const dataUrl = await fileToDataUrl(file);
  const extraction = await classifyDocument({
    fileName: file.name,
    mimeType: file.type,
    dataUrl,
  });
  appendAudit({
    actor: "ai",
    action: "classify_document",
    to: `${extraction.documentType} (conf ${(extraction.confidence * 100).toFixed(0)}%)`,
  });
  setPendingFile(file);

  const prior = readIntake();
  const mismatchFlag = detectMismatch(extraction, prior);
  const lowConfidenceFlag = extraction.confidence < LOW_CONFIDENCE_THRESHOLD;
  if (lowConfidenceFlag) appendAudit({ actor: "ai", action: "flag_low_confidence" });
  if (mismatchFlag) appendAudit({ actor: "ai", action: "flag_mismatch" });

  updateIntake({
    noticeFileName: file.name,
    extraction,
    extractionEdited: undefined,
    extractionConfirmed: false,
    lowConfidenceFlag,
    mismatchFlag,
  });

  return extraction;
}

export function detectMismatch(e: Extraction, prior?: IntakeState): boolean {
  if (!prior) return false;
  if (prior.cad && e.cadName && !normalize(e.cadName).includes(normalize(prior.cad).split(" ")[0]))
    return true;
  if (
    prior.accountNumber &&
    e.accountNumber &&
    normalize(e.accountNumber) !== normalize(prior.accountNumber)
  )
    return true;
  return false;
}

function normalize(v: string) {
  return v.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function routeWorkflows(e: Extraction): WorkflowSuggestion[] {
  const out: WorkflowSuggestion[] = [];
  const primaryByType: Record<DocumentType, WorkflowSuggestion | null> = {
    "Real Property Appraisal Notice": {
      workflow: "real_property_protest",
      label: "Real Property Protest",
      message: "Looks like your property value may be protestable. AI can file on your behalf.",
      primary: true,
    },
    "BPP Rendition Form": {
      workflow: "bpp_rendition",
      label: "BPP Rendition",
      message: "Looks like you need to file a BPP rendition before the deadline.",
      primary: true,
    },
    "BPP Appraisal Notice": {
      workflow: "bpp_protest",
      label: "BPP Protest",
      message: "Looks like a business personal property notice. AI can evaluate a protest.",
      primary: true,
    },
    "Tax Bill / Statement": {
      workflow: "tax_payment_tracking",
      label: "Tax Payment Tracking",
      message: "Looks like this is a tax bill. AI will track payment and savings.",
      primary: true,
    },
    "Hearing Notice / ARB": {
      workflow: "hearing_decision_tracking",
      label: "Hearing / Decision Tracking",
      message: "Looks like this is a hearing notice. AI will track the ARB decision.",
      primary: true,
    },
    "Refund Notice": {
      workflow: "refund_tracking",
      label: "Refund Tracking",
      message: "Looks like a refund notice. AI will track the refund to your account.",
      primary: true,
    },
    "EPIN / PIN Notice": {
      workflow: "notice_epin_retrieval",
      label: "Notice / EPIN Retrieval",
      message: "Looks like an EPIN/PIN notice. AI will store it for online filings.",
      primary: true,
    },
    "Exemption Notice": {
      workflow: "real_property_protest",
      label: "Real Property Protest",
      message: "Exemption notice detected. AI will factor exemptions into your valuation review.",
      primary: true,
    },
    Other: null,
  };

  const p = primaryByType[e.documentType];
  if (p) out.push(p);

  if (e.paymentDueDate && p?.workflow !== "tax_payment_tracking") {
    out.push({
      workflow: "tax_payment_tracking",
      label: "Tax Payment Tracking",
      message: "Payment due date detected — AI will track this bill.",
      primary: false,
    });
  }
  if (e.hearingDate && p?.workflow !== "hearing_decision_tracking") {
    out.push({
      workflow: "hearing_decision_tracking",
      label: "Hearing / Decision Tracking",
      message: "Hearing date detected — AI will track the ARB decision.",
      primary: false,
    });
  }
  if (out.length === 0) {
    out.push({
      workflow: "notice_epin_retrieval",
      label: "Manual Review",
      message: "AI could not confidently route this document. CorvusPT staff will review.",
      primary: true,
    });
  }
  return out;
}

export function currency(n?: number | null) {
  if (n == null) return "—";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

// Abbreviated form ($31K, $1.2M) for tight spaces (stat tiles, chart axes)
// where the full currency() string would overflow or force truncation —
// e.g. a real estimated-savings figure like $31,547 getting CSS-ellipsized
// to "$31…" in a fixed-size dashboard tile is a genuine display bug, not
// just a long number; this is the fix for that class of problem.
export function compactCurrency(n?: number | null): string {
  if (n == null) return "—";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${Math.round(n / 1000)}K`;
  return currency(n);
}

export function displayVal(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "Data Not Found";
  return String(v);
}
