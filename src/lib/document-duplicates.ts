import type { DocumentRecord } from "./documents";

// Deterministic near-duplicate detection for the Documents tab. The "AI
// verifies" part is that analyze-document has already read each file and
// written its category (and, in ai_notes, the facts it found) — this just
// compares those. No extra AI call.
//
// Two documents on the same property are flagged as possible duplicates when
// either:
//   - the file names match (case-insensitive, ignoring a trailing
//     " (edited)" / " (1)" and the extension), OR
//   - both have been AI-checked, share a category, and their ai_notes agree
//     on the same account number / tax year / dollar figures.

export function findDuplicateCandidates(
  doc: DocumentRecord,
  all: DocumentRecord[],
): DocumentRecord[] {
  const others = all.filter(
    (d) => d.id !== doc.id && d.propertyId === doc.propertyId && !d.deletedAt,
  );
  const docKey = nameKey(doc.fileName);
  const docFacts = factSet(doc);
  return others.filter((d) => {
    if (nameKey(d.fileName) === docKey) return true;
    if (!doc.aiCheckedAt || !d.aiCheckedAt) return false;
    if ((doc.category ?? "") !== (d.category ?? "") || !doc.category) return false;
    const otherFacts = factSet(d);
    // At least two shared, non-trivial facts.
    let shared = 0;
    for (const f of docFacts) if (otherFacts.has(f)) shared++;
    return shared >= 2;
  });
}

function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/, "")
    .replace(/\s*\((?:edited|\d+)\)\s*$/i, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

// Pulls comparable tokens (account numbers, 4-digit years, $ amounts) out of
// whatever analyze-document wrote — a coarse but honest signal that two docs
// describe the same thing.
function factSet(d: DocumentRecord): Set<string> {
  const text = `${d.aiNotes ?? ""} ${d.aiCrossRefs ?? ""} ${d.suggestedName ?? ""}`;
  const set = new Set<string>();
  for (const m of text.matchAll(/\b\d{5,}\b/g)) set.add(`n:${m[0]}`); // account-like
  for (const m of text.matchAll(/\b(19|20)\d{2}\b/g)) set.add(`y:${m[0]}`); // year
  for (const m of text.matchAll(/\$\s?[\d,]{4,}/g)) set.add(`$:${m[0].replace(/[\s,]/g, "")}`);
  return set;
}
