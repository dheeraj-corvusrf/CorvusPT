// Deterministic "Ready to File" checklist — the blocking gate Corvus runs
// before a user can open the Notice of Protest form (see
// PreFilingCheckSection in CaseDetailModal.tsx). Every row here is either a
// real field already on the property/protest/evidence records, or a real,
// hand-verified per-county fact from county-protest-info.ts — never a
// guessed or fabricated answer. Where a fact genuinely isn't verified for a
// county, the row honestly says "Not confirmed" rather than assuming a
// typical answer.
import type { PropertyRecord } from "./properties";
import type { ProtestRecord } from "./protests";
import { getCountyProtestInfo } from "./county-protest-info";

export type PreFilingCheckItem = {
  label: string;
  value: string | null;
  // "missing"      — no value on file.
  // "needs_review" — there IS a value, but a deterministic check found it
  //                  inconsistent (a passed deadline, a tax-year mismatch, …);
  //                  `issue` says what to confirm or correct.
  // "confirmed"    — present and nothing looks wrong.
  status: "confirmed" | "missing" | "needs_review";
  // Set only for "needs_review" — the one-line explanation shown under the row.
  issue?: string;
  // Blocking rows are this case's own real identity/deadline data — if any
  // are missing OR flagged needs_review, filing stops until they're fixed
  // (isPreFilingBlocked / PreFilingCheckSection enforce this). Non-blocking
  // rows are informational — procedural facts that are either always-true app
  // copy or a real, possibly-unconfirmed per-county answer — never treated as
  // a reason to stop filing, since the app's own generic form/instructions
  // remain a valid fallback even when a specific county detail isn't
  // confirmed.
  blocking: boolean;
};

function row(label: string, value: string | null, blocking: boolean): PreFilingCheckItem {
  return { label, value, status: value ? "confirmed" : "missing", blocking };
}

// Flip an already-built row to needs_review with an explanation. No-op if the
// label isn't in the list (defensive — the labels are fixed above).
function flag(items: PreFilingCheckItem[], label: string, issue: string): void {
  const it = items.find((i) => i.label === label);
  if (it) {
    it.status = "needs_review";
    it.issue = issue;
  }
}

function yesNo(value: boolean | null, whenTrue: string, whenFalse: string): string {
  if (value === true) return whenTrue;
  if (value === false) return whenFalse;
  return "Not confirmed";
}

export function getPreFilingCheck(
  property: PropertyRecord,
  protest: ProtestRecord,
  // Real count of "Protest Evidence"-tagged documents uploaded for this
  // property (see getProtestEvidenceDocuments in documents.ts) — evidence
  // now uploads exclusively through Module 8 (ai-report.tsx), a flat
  // document list, not the older per-checklist-item structure, so this is
  // a plain count rather than "N of M items."
  evidenceDocumentCount?: number,
): PreFilingCheckItem[] {
  // protestDeadline is a date-only string ("2026-05-15") — parsing it as-is
  // is interpreted as UTC midnight, which toLocaleDateString then renders in
  // the browser's local timezone, rolling the displayed date back a full day
  // for anyone west of UTC (confirmed live: "2026-05-15" rendered as "May
  // 14"). Appending a local time-of-day avoids the UTC interpretation
  // entirely, regardless of the viewer's timezone.
  const deadline = property.protestDeadline
    ? new Date(`${property.protestDeadline}T00:00:00`).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : null;
  const taxYear = protest.taxYear ?? property.taxYear;
  const countyInfo = getCountyProtestInfo(property.cad);
  const filingMethod = countyInfo?.filingMethod ?? null;
  const mailOrInPerson = filingMethod?.mail ?? filingMethod?.inPerson ?? null;

  const filingMethodValue = filingMethod?.online
    ? `Online — ${filingMethod.online.url}`
    : mailOrInPerson
      ? `Mail or deliver to ${mailOrInPerson.address}`
      : // No verified per-county entry yet — the app's own honest default
        // (see DocumentsSection's "download or deliver this PDF" copy),
        // never a guessed online/mail/email answer.
        "Download and deliver to your county";

  const evidenceStatus =
    evidenceDocumentCount == null
      ? null
      : evidenceDocumentCount === 0
        ? "None uploaded yet"
        : `${evidenceDocumentCount} document${evidenceDocumentCount === 1 ? "" : "s"} uploaded`;

  const contactValue = countyInfo?.arbContact
    ? [countyInfo.arbContact.phone, countyInfo.arbContact.email].filter(Boolean).join(" · ") || null
    : null;

  const items: PreFilingCheckItem[] = [
    row("County", property.cad, true),
    row("Property Address", property.address, true),
    row("Account Number", property.accountNumber, true),
    row("Tax Year", taxYear != null ? String(taxYear) : null, true),
    row("Owner / Entity", property.ownerName, true),
    row("Property Type", property.propertyType ?? "Not on file", false),
    row("Protest Deadline", deadline, true),
    row("Applicable Form", "Comptroller Form 50-132 — Notice of Protest", false),
    row("Filing Method", filingMethodValue, false),
    row("Signature Required", "Yes — property owner or authorized agent", false),
    row("Required Supporting Documents", evidenceStatus ?? "Not on file", false),
    row("Applicable County Instructions", countyInfo?.sourceUrl ?? "Not on file", false),
    row(
      "County Requirements Verified",
      countyInfo
        ? `As of ${countyInfo.verifiedAt} · ${countyInfo.sourceUrl}`
        : "No verified county record on file — using the standard Texas Comptroller process",
      false,
    ),
    row(
      "Online Filing Available",
      yesNo(filingMethod ? filingMethod.online != null : null, "Yes", "No"),
      false,
    ),
    row("Email Filing Available", yesNo(filingMethod?.email.available ?? null, "Yes", "No"), false),
    row(
      "Mail / In-Person Filing",
      mailOrInPerson
        ? filingMethod?.online
          ? "Available (alternative to online)"
          : "Required (no confirmed online option)"
        : "Not confirmed",
      false,
    ),
    row("County Contact Information", contactValue ?? "Not confirmed", false),
  ];

  // --- Inconsistency checks: a value can be present but still wrong -------
  // Same local-noon parse as `deadline` above, to avoid the UTC-midnight
  // timezone roll-back.
  const deadlineDate = property.protestDeadline
    ? new Date(`${property.protestDeadline}T12:00:00`)
    : null;
  if (deadlineDate && !Number.isNaN(deadlineDate.getTime())) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    if (deadlineDate < startOfToday) {
      flag(
        items,
        "Protest Deadline",
        "This deadline has already passed — confirm the correct date, or whether a late-protest reason (e.g. a corrected notice) applies.",
      );
    } else if (taxYear != null) {
      const dYear = deadlineDate.getFullYear();
      if (dYear !== taxYear && dYear !== taxYear + 1) {
        flag(
          items,
          "Protest Deadline",
          `This deadline (${dYear}) doesn't line up with tax year ${taxYear} — confirm it's the ${taxYear} protest deadline.`,
        );
      }
    }
  }

  if (protest.taxYear != null && property.taxYear != null && protest.taxYear !== property.taxYear) {
    flag(
      items,
      "Tax Year",
      `The protest is for tax year ${protest.taxYear}, but the property record shows ${property.taxYear} — confirm which year you're protesting.`,
    );
  }

  if (!property.propertyType) {
    flag(
      items,
      "Property Type",
      "No CAD classification on file — confirm the property class (commercial, land, etc.) before filing.",
    );
  }

  return items;
}

// A single blocking row that still needs the user's attention — missing OR
// flagged inconsistent. The one predicate isPreFilingBlocked and the case
// report / executive summary all read from.
export function isBlockingUnresolved(item: PreFilingCheckItem): boolean {
  return item.blocking && (item.status === "missing" || item.status === "needs_review");
}

export function isPreFilingBlocked(items: PreFilingCheckItem[]): boolean {
  return items.some(isBlockingUnresolved);
}
