import { listProtests } from "./protests";
import { getCountyProtestInfo } from "./county-protest-info";
import { extractHearingNotice, saveHearingNotice } from "./hearing-notice";
import { scheduleHearing } from "./protest-case";
import { setDocumentModules } from "./document-modules";
import type { PropertyRecord } from "./properties";

// When a file the Documents tab classified as "Hearing Notice / ARB" lands
// on a property that has an open protest, run the same deep extraction the
// Case view's Hearing Notice section does (extract-hearing-notice), file it
// against that case, and — if it states a real hearing date — get it onto
// the calendar. Lets the user drop the scan into the central Documents tab
// and have it reach the case on its own, instead of re-uploading inside the
// Case view.
//
// Never throws: any failure here just means the file is still uploaded and
// visible in Documents like any other, it simply didn't auto-attach — the
// user can still upload it from inside the Case view. The caller (the
// Documents page) treats a null return as "nothing attached."
export async function attachHearingNoticeToCase(
  userId: string,
  matchedProperty: PropertyRecord,
  file: File,
  documentId: string,
): Promise<{ attachedToCaseId: string; hearingDate: string | null } | null> {
  try {
    const protests = await listProtests(userId);
    // One protest per property in practice (same `.find` every other call
    // site uses); skip a resolved/closed case — a fresh notice on one of
    // those is a re-file signal, not something to schedule.
    const pr = protests.find((p) => p.propertyId === matchedProperty.id && p.status !== "resolved");
    if (!pr) return null;

    const extraction = await extractHearingNotice(
      matchedProperty,
      file,
      getCountyProtestInfo(matchedProperty.cad),
    );
    await saveHearingNotice(userId, pr.id, documentId, extraction);
    // Known document kind — tag it straight to the hearing section (and the
    // evidence packet) rather than re-running the classifier.
    await setDocumentModules(documentId, ["hearing", "evidence"]).catch(() => {});

    if (extraction.hearingDate) {
      await scheduleHearing(pr.id, extraction.hearingDate, {
        time: extraction.hearingTime,
        location: extraction.hearingLocation,
        mode: extraction.hearingMode,
      });
    }
    return { attachedToCaseId: pr.id, hearingDate: extraction.hearingDate };
  } catch (err) {
    console.error("Could not attach hearing notice to case:", err);
    return null;
  }
}
