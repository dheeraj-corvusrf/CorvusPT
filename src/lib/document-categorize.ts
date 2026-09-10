import { fileToDataUrl } from "./intake-store";
import { classifyDocument, type Extraction } from "./document-ai";
import { uploadDocument, type DocumentRecord } from "./documents";
import type { PropertyRecord } from "./properties";

// Bulk-upload-and-sort for the Documents tab: the user picks several files
// at once with no property preselected, AI reads each one (the same real
// classify-document extraction used everywhere else — account number, CAD,
// address, and a real document type), and this matches that extraction
// against the user's own property list to figure out which property it
// belongs to. A file that can't be matched confidently is never guessed at
// — it's left for the user to assign by hand (see CategorizedUpload's
// "needs-property" status), same "never fabricate" discipline as every
// other AI feature in this app.

function normalizeKey(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Account number is the most reliable signal a document actually carries —
// exact (trimmed) match within this one user's own properties. Falls back
// to a normalized address match (handles "St" vs "Street", stray
// punctuation, casing) when no account number match is found. Returns null
// rather than a weak guess if neither signal confidently resolves to
// exactly one property.
export function matchPropertyForExtraction(
  extraction: Extraction,
  properties: PropertyRecord[],
): PropertyRecord | null {
  const extractedAccount = extraction.accountNumber?.trim();
  if (extractedAccount) {
    const byAccount = properties.filter((p) => p.accountNumber?.trim() === extractedAccount);
    if (byAccount.length === 1) return byAccount[0];
  }

  const extractedAddress = extraction.propertyAddress ?? extraction.situsAddress;
  if (extractedAddress) {
    const key = normalizeKey(extractedAddress);
    const byAddress = properties.filter((p) => normalizeKey(p.address) === key);
    if (byAddress.length === 1) return byAddress[0];
  }

  return null;
}

export type CategorizedUpload = {
  id: string;
  file: File;
  status: "classifying" | "uploading" | "done" | "needs-property" | "error";
  extraction: Extraction | null;
  matchedProperty: PropertyRecord | null;
  document: DocumentRecord | null;
  error: string | null;
  // Set once a file classified as a hearing notice has been auto-attached to
  // this property's open protest (see attachHearingNoticeToCase). The
  // Documents page turns this into a "filed to your open case" line with a
  // link into the case.
  attachedToCaseId?: string;
};

// Reads and classifies one file, then either uploads it straight to its
// matched property or leaves it in "needs-property" for the user to assign.
// Never throws — a classification/upload failure lands in the "error"
// status instead, so one bad file in a batch doesn't stop the rest.
export async function classifyAndUpload(
  userId: string,
  properties: PropertyRecord[],
  file: File,
): Promise<CategorizedUpload> {
  const base: Omit<CategorizedUpload, "status"> = {
    id: `${file.name}-${file.size}-${file.lastModified}`,
    file,
    extraction: null,
    matchedProperty: null,
    document: null,
    error: null,
  };
  try {
    const dataUrl = await fileToDataUrl(file);
    const extraction = await classifyDocument({
      fileName: file.name,
      mimeType: file.type,
      dataUrl,
    });
    const matchedProperty = matchPropertyForExtraction(extraction, properties);
    if (!matchedProperty) {
      return { ...base, status: "needs-property", extraction, matchedProperty: null };
    }
    const document = await uploadDocument(
      userId,
      matchedProperty.id,
      file,
      extraction.documentType,
    );
    return { ...base, status: "done", extraction, matchedProperty, document };
  } catch (err) {
    return {
      ...base,
      status: "error",
      error: err instanceof Error ? err.message : "Could not process this file.",
    };
  }
}

// For uploading straight into a property the user has already picked (e.g.
// a per-property "Upload" button, right on that property's own row) — skips
// matching entirely since there's nothing to match, but still runs the same
// real classify-document call so the file gets a real AI document type
// instead of landing untagged.
export async function classifyAndUploadToProperty(
  userId: string,
  property: PropertyRecord,
  file: File,
): Promise<CategorizedUpload> {
  const base: Omit<CategorizedUpload, "status"> = {
    id: `${file.name}-${file.size}-${file.lastModified}`,
    file,
    extraction: null,
    matchedProperty: property,
    document: null,
    error: null,
  };
  try {
    const dataUrl = await fileToDataUrl(file);
    const extraction = await classifyDocument({
      fileName: file.name,
      mimeType: file.type,
      dataUrl,
    });
    const document = await uploadDocument(userId, property.id, file, extraction.documentType);
    return { ...base, status: "done", extraction, document };
  } catch (err) {
    return {
      ...base,
      status: "error",
      error: err instanceof Error ? err.message : "Could not upload this file.",
    };
  }
}

// Used once the user manually picks a property for a "needs-property" row —
// same real upload path, just with a human-chosen property instead of an
// AI-matched one. Keeps the AI's own extraction/documentType intact rather
// than discarding what it already correctly read off the file.
export async function assignAndUpload(
  userId: string,
  property: PropertyRecord,
  upload: CategorizedUpload,
): Promise<CategorizedUpload> {
  try {
    const document = await uploadDocument(
      userId,
      property.id,
      upload.file,
      upload.extraction?.documentType ?? null,
    );
    return { ...upload, status: "done", matchedProperty: property, document, error: null };
  } catch (err) {
    return {
      ...upload,
      status: "error",
      error: err instanceof Error ? err.message : "Could not upload this file.",
    };
  }
}
