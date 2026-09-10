import { invokeEdgeFunction } from "./edge-functions";

export type DocumentType =
  | "Real Property Appraisal Notice"
  | "BPP Rendition Form"
  | "BPP Appraisal Notice"
  | "Tax Bill / Statement"
  | "Hearing Notice / ARB"
  | "Refund Notice"
  | "EPIN / PIN Notice"
  | "Exemption Notice"
  | "Other";

export type Extraction = {
  documentType: DocumentType;
  ownerName: string | null;
  propertyName: string | null;
  propertyAddress: string | null;
  situsAddress: string | null;
  county: string | null;
  cadName: string | null;
  accountNumber: string | null;
  parcelId: string | null;
  taxYear: number | null;
  noticeValue: number | null;
  landValue: number | null;
  improvementValue: number | null;
  bppValue: number | null;
  priorValue: number | null;
  noticeDate: string | null;
  mailDate: string | null;
  protestDeadline: string | null;
  hearingDate: string | null;
  hearingTime: string | null;
  hearingInstructions: string | null;
  paymentDueDate: string | null;
  taxAmountDue: number | null;
  taxableValue: number | null;
  taxRate: number | null;
  penaltyDate: string | null;
  refundAmount: number | null;
  pinOrEpin: string | null;
  exemptions: string[] | null;
  confidence: number; // 0-1
  reasoning: string | null;
};

export async function classifyDocument(input: {
  fileName: string;
  mimeType: string;
  dataUrl: string;
}): Promise<Extraction> {
  return invokeEdgeFunction<Extraction>("classify-document", input);
}

export type ValidationResult = {
  isValid: boolean;
  cadName: string | null;
  reason: string | null;
};

export async function validateDocument(input: {
  fileName: string;
  mimeType: string;
  dataUrl: string;
}): Promise<ValidationResult> {
  return invokeEdgeFunction<ValidationResult>("validate-document", input);
}

export async function askAboutDocument(input: {
  question: string;
  context?: string;
  // The answer will be spoken aloud / shown in a chat bubble — ask for a
  // natural spoken reply instead of the default bulleted/tabular format.
  conversational?: boolean;
}): Promise<{ answer: string }> {
  return invokeEdgeFunction<{ answer: string }>("ask-about-document", input);
}
