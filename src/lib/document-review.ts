import { invokeEdgeFunction } from "./edge-functions";

// AI Review for the Documents tab — a plain-language explanation of a stored
// document plus a Q&A box grounded in the file itself. See
// supabase/functions/review-document/index.ts.

export type DocumentReview = {
  explanation: string;
  // Echoed back so the caller can patch documents.ai_explanation.
  documentId: string;
};

// First call for a document — returns (and server-side stores) the long-form
// explanation.
export async function reviewDocument(documentId: string): Promise<DocumentReview> {
  return invokeEdgeFunction<DocumentReview>("review-document", { documentId });
}

// A follow-up question about the same document. Not stored — ephemeral, like
// Module 8's Ask-AI box.
export async function askDocument(documentId: string, question: string): Promise<string> {
  const { answer } = await invokeEdgeFunction<{ answer: string }>("review-document", {
    documentId,
    question,
  });
  return answer;
}
