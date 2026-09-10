import { supabase } from "./supabase";
import { getModuleAnalysis, type ModuleAnalysisInput } from "./ai-report-modules";
import type { PropertyRecord } from "./properties";
import type {
  ProtestRecord,
  ArbDecision,
  InformalStatus,
  AppraiserCategory,
  AttendanceType,
} from "./protests";
import { getEffectiveTaxRate } from "./texas-tax-rates";
import { logCaseEvent } from "./case-audit";

const currencyText = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

// AI case prep for a real protest — persists the same strategy recommendation and
// evidence checklist the paywalled AI Report page already generates on demand
// (see ai-report-modules.ts) onto the actual case, so "Request Protest Filing"
// produces something real instead of just a status row. See the
// protest_evidence_items table and the new protests.strategy_* columns in
// supabase/schema.sql.
// storagePath is included so a real evidence document can actually be read
// back later (e.g. draftProtestReason() downloading the real file content
// to hand to the AI) — not just displayed by name.
export type EvidenceDocument = { id: string; fileName: string; storagePath: string };

export type EvidenceItemRecord = {
  id: string;
  protestId: string;
  label: string;
  documents: EvidenceDocument[];
  createdAt: string;
};

export type ProtestCase = {
  strategyRecommendation: string | null;
  strategyConfidencePct: number | null;
  strategyRationale: string | null;
  casePrepGeneratedAt: string | null;
  evidenceItems: EvidenceItemRecord[];
};

type ProtestCaseRow = {
  strategy_recommendation: string | null;
  strategy_confidence_pct: number | null;
  strategy_rationale: string | null;
  case_prep_generated_at: string | null;
};

type EvidenceItemRow = {
  id: string;
  protest_id: string;
  label: string;
  created_at: string;
};

function toModuleInput(property: PropertyRecord): ModuleAnalysisInput {
  return {
    address: property.address,
    cad: property.cad ?? undefined,
    propertyType: property.propertyType ?? undefined,
    landValue: property.landValue ?? undefined,
    improvementValue: property.improvementValue ?? undefined,
    totalValue: property.totalValue ?? undefined,
    taxYear: property.taxYear ?? undefined,
  };
}

// Generates the strategy recommendation and evidence checklist and persists them.
// The two halves run independently (one failing — rate limit, network — doesn't
// block the other), and the evidence checklist is only generated once per protest
// (skipped if items already exist) so calling this again as a manual retry doesn't
// pile up duplicate checklist items or wipe out evidence the user already uploaded
// against existing items.
//
// Confirmed live on a real stuck case: case_prep_generated_at used to get
// stamped unconditionally at the end regardless of whether EITHER half above
// actually produced anything, and every failure inside them was only ever
// console.error'd, never re-thrown — so a real failure (both halves came back
// empty: strategy_recommendation null, zero evidence rows, yet
// case_prep_generated_at set to a real timestamp) looked identical to
// success everywhere the caller could see: no toast, and CasePlanSection's
// own hasAnyPlan check (which reads the actual content, not this timestamp)
// just silently kept showing "No case plan yet" — with the "Generate Case
// Plan" button doing the same silent nothing on every subsequent click,
// forever, since there was no signal telling the user (or this function
// itself) that anything had gone wrong.
export async function generateCasePrep(
  protestId: string,
  userId: string,
  property: PropertyRecord,
): Promise<void> {
  const input = toModuleInput(property);
  let strategySucceeded = false;
  let evidenceSucceeded = false;

  try {
    const strategy = await getModuleAnalysis("strategy", input);
    // Module 2 now returns a ranked list of strategies rather than one single
    // recommendation — the saved case still only has room for one, so this
    // persists the top-ranked strategy (see StrategyEntry in ai-report-modules.ts).
    const top = strategy.strategies[0] ?? null;
    const { error } = await supabase
      .from("protests")
      .update({
        strategy_recommendation: top?.name ?? null,
        strategy_confidence_pct: top?.confidencePct ?? null,
        strategy_rationale: top?.whySelected ?? null,
      })
      .eq("id", protestId);
    if (error) throw error;
    strategySucceeded = true;
  } catch (err) {
    console.error("Case strategy generation failed:", err);
  }

  try {
    const { count } = await supabase
      .from("protest_evidence_items")
      .select("id", { count: "exact", head: true })
      .eq("protest_id", protestId);
    if (count) {
      // Already has evidence items from a prior successful run — nothing
      // new to generate, but not a failure of THIS run either.
      evidenceSucceeded = true;
    } else {
      const evidence = await getModuleAnalysis("evidence", input);
      if (evidence.items.length > 0) {
        const { error } = await supabase.from("protest_evidence_items").insert(
          evidence.items.map(({ item }) => ({
            protest_id: protestId,
            user_id: userId,
            label: item,
          })),
        );
        if (error) throw error;
      }
      evidenceSucceeded = true;
    }
  } catch (err) {
    console.error("Case evidence checklist generation failed:", err);
  }

  if (!strategySucceeded && !evidenceSucceeded) {
    // Neither half produced anything real — leave case_prep_generated_at
    // untouched (so hasAnyPlan and "has this ever been attempted" both stay
    // accurate) and throw for real, so the caller's existing catch+toast
    // (see CasePlanSection.handleGenerate in CaseDetailModal.tsx) actually
    // fires instead of this looking like a normal, silent success.
    throw new Error(
      "Could not generate the case plan right now — this is usually temporary. Please try again in a moment.",
    );
  }

  await supabase
    .from("protests")
    .update({ case_prep_generated_at: new Date().toISOString() })
    .eq("id", protestId);
}

export async function getCase(protestId: string): Promise<ProtestCase> {
  const { data: protestRow, error: protestErr } = await supabase
    .from("protests")
    .select(
      "strategy_recommendation, strategy_confidence_pct, strategy_rationale, case_prep_generated_at",
    )
    .eq("id", protestId)
    .single();
  if (protestErr) throw protestErr;

  const { data: itemRows, error: itemsErr } = await supabase
    .from("protest_evidence_items")
    .select("id, protest_id, label, created_at")
    .eq("protest_id", protestId)
    .order("created_at", { ascending: true });
  if (itemsErr) throw itemsErr;

  const rows = (itemRows as EvidenceItemRow[]) ?? [];
  const itemIds = rows.map((r) => r.id);
  const documentsByItemId = new Map<string, EvidenceDocument[]>();
  if (itemIds.length > 0) {
    const { data: docs } = await supabase
      .from("documents")
      .select("id, file_name, storage_path, evidence_item_id")
      .in("evidence_item_id", itemIds)
      .order("uploaded_at", { ascending: true });
    for (const d of (docs as Array<{
      id: string;
      file_name: string;
      storage_path: string;
      evidence_item_id: string;
    }>) ?? []) {
      const list = documentsByItemId.get(d.evidence_item_id) ?? [];
      list.push({ id: d.id, fileName: d.file_name, storagePath: d.storage_path });
      documentsByItemId.set(d.evidence_item_id, list);
    }
  }

  const protest = protestRow as ProtestCaseRow;
  return {
    strategyRecommendation: protest.strategy_recommendation,
    strategyConfidencePct: protest.strategy_confidence_pct,
    strategyRationale: protest.strategy_rationale,
    casePrepGeneratedAt: protest.case_prep_generated_at,
    evidenceItems: rows.map((r) => ({
      id: r.id,
      protestId: r.protest_id,
      label: r.label,
      documents: documentsByItemId.get(r.id) ?? [],
      createdAt: r.created_at,
    })),
  };
}

// A checklist item can hold several documents — call once per uploaded file
// (see CaseDetailModal's handleUpload, which loops a multi-file <input>).
export async function linkEvidenceDocument(itemId: string, documentId: string): Promise<void> {
  const { error } = await supabase
    .from("documents")
    .update({ evidence_item_id: itemId })
    .eq("id", documentId);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Case progress — settlement offer, hearing, ARB decision, and escalation. All
// self-reported (see the comment on these columns in schema.sql): there's no
// live county API, so someone has to enter what actually happened, same
// precedent as tax_bills.
// ---------------------------------------------------------------------------

// Called when the owner signs the Notice of Protest in-app (see
// CaseDetailModal's Sign & Submit). Only advances a case that's still at its
// starting status — if staff or the owner already moved it further along
// (offer received, hearing scheduled, etc.) by other means, this leaves that
// alone rather than regressing it back to "filed".
export async function markFiled(protestId: string): Promise<void> {
  const { error } = await supabase
    .from("protests")
    .update({ status: "filed" })
    .eq("id", protestId)
    .eq("status", "requested");
  if (error) throw error;
  void logCaseEvent(
    protestId,
    "status_change",
    "Notice of Protest marked as filed with the county.",
  );
}

export async function recordSettlementOffer(
  protestId: string,
  offer: { value: number; receivedAt: string },
): Promise<void> {
  const { error } = await supabase
    .from("protests")
    .update({
      settlement_offer_value: offer.value,
      settlement_offer_received_at: offer.receivedAt,
      status: "offer_received",
    })
    .eq("id", protestId);
  if (error) throw error;
  void logCaseEvent(
    protestId,
    "value_recorded",
    `Informal proposed value received: ${currencyText(offer.value)}.`,
    { proposedValue: offer.value, receivedAt: offer.receivedAt },
  );
}

export async function acceptSettlement(protestId: string, offerValue: number): Promise<void> {
  const { error } = await supabase
    .from("protests")
    .update({
      final_value: offerValue,
      escalation_path: "accept",
      closed_at: new Date().toISOString(),
      status: "resolved",
    })
    .eq("id", protestId);
  if (error) throw error;
  void logCaseEvent(
    protestId,
    "status_change",
    `Informal offer accepted at ${currencyText(offerValue)} — case resolved.`,
    { finalValue: offerValue },
  );
}

// The "Accepted + Satisfied" path from SettlementSignatureSection — same
// terminal update as acceptSettlement, but also lands the informal
// sub-tracker on "accepted" so the case history reads correctly (the offer
// came from the informal review, not a post-hearing decision).
export async function resolveInformalSettlement(
  protestId: string,
  settledValue: number,
): Promise<void> {
  const { error } = await supabase
    .from("protests")
    .update({
      final_value: settledValue,
      escalation_path: "accept",
      closed_at: new Date().toISOString(),
      status: "resolved",
      informal_status: "accepted",
    })
    .eq("id", protestId);
  if (error) throw error;
  void logCaseEvent(
    protestId,
    "status_change",
    `Informal settlement accepted at ${currencyText(settledValue)} — case resolved.`,
    { finalValue: settledValue },
  );
}

export async function scheduleHearing(
  protestId: string,
  date: string,
  // Real detail from an actual uploaded hearing notice, when there is one
  // (see extract-hearing-notice / hearing-notice.ts) — omitted entirely for
  // CaseProgress's own manual date-only entry, same as before this existed.
  detail?: {
    time?: string | null;
    location?: string | null;
    mode?: "In Person" | "Phone" | "Videoconference" | "Affidavit" | "Unknown" | null;
  },
): Promise<void> {
  const { error } = await supabase
    .from("protests")
    .update({
      hearing_date: date,
      status: "hearing_scheduled",
      ...(detail
        ? {
            hearing_time: detail.time ?? null,
            hearing_location: detail.location ?? null,
            hearing_mode: detail.mode ?? null,
          }
        : {}),
    })
    .eq("id", protestId);
  if (error) throw error;
  void logCaseEvent(protestId, "deadline_set", `Formal ARB hearing scheduled for ${date}.`, {
    hearingDate: date,
    ...(detail ?? {}),
  });
}

// Real, user-driven update to the informal-review sub-tracker (see the
// schema.sql comment on protests.informal_status) — the user picks their
// real, actual status directly (a dropdown in InformalReviewSection), not
// an AI guess. Every value already exists in the DB check constraint.
export async function updateInformalStatus(
  protestId: string,
  status: InformalStatus,
): Promise<void> {
  const { error } = await supabase
    .from("protests")
    .update({ informal_status: status })
    .eq("id", protestId);
  if (error) throw error;
  void logCaseEvent(protestId, "status_change", `Informal review status set to "${status}".`, {
    informalStatus: status,
  });
}

// The real, self-reported date/time/mode once the county and owner have
// actually agreed on one — this app has no live scheduling API for any
// county, so there's no "available dates" to offer beyond what the user
// tells us they were given. Feeds the calendar the same way
// scheduleHearing() does for the formal hearing; the detail shape mirrors
// scheduleHearing's (no location — an informal review is a call or a visit
// to the CAD office, not a booked room).
export async function scheduleInformalReview(
  protestId: string,
  date: string,
  detail?: {
    time?: string | null;
    mode?: "In Person" | "Phone" | "Videoconference" | "Affidavit" | "Unknown" | null;
  },
): Promise<void> {
  const { error } = await supabase
    .from("protests")
    .update({
      informal_status: "scheduled",
      informal_review_date: date,
      ...(detail
        ? {
            informal_review_time: detail.time ?? null,
            informal_review_mode: detail.mode ?? null,
          }
        : {}),
    })
    .eq("id", protestId);
  if (error) throw error;
  void logCaseEvent(protestId, "deadline_set", `Informal review scheduled for ${date}.`, {
    informalReviewDate: date,
    ...(detail ?? {}),
  });
}

// AI's own read of which appraiser specialty this property would route to
// (see informal-review-guidance edge function) — saved so it's available
// the next time this case's guidance loads, without a fresh AI call every
// time. Internal/supporting detail only, per product direction — never
// surfaced as its own prominent field.
export async function saveInformalAppraiserCategory(
  protestId: string,
  category: AppraiserCategory,
): Promise<void> {
  const { error } = await supabase
    .from("protests")
    .update({ informal_appraiser_category: category })
    .eq("id", protestId);
  if (error) throw error;
}

// Who the user says will actually attend — see HearingPrepSection in
// CaseDetailModal.tsx. Purely a user selection; never inferred.
export async function saveAttendanceType(
  protestId: string,
  attendanceType: AttendanceType,
): Promise<void> {
  const { error } = await supabase
    .from("protests")
    .update({ attendance_type: attendanceType })
    .eq("id", protestId);
  if (error) throw error;
}

// Not an AI call — assembled from the case's own already-generated strategy and
// evidence checklist (see generateCasePrep above), the same real content the user
// already has, just formatted as hearing talking points.
export function getHearingPrep(caseData: ProtestCase, propertyAddress: string): string {
  const lines: string[] = [`Hearing summary — ${propertyAddress}`, ""];

  if (caseData.strategyRecommendation) {
    lines.push(`Strategy: ${caseData.strategyRecommendation}`);
    if (caseData.strategyRationale) lines.push(caseData.strategyRationale);
    lines.push("");
  }

  if (caseData.evidenceItems.length > 0) {
    const ready = caseData.evidenceItems.filter((i) => i.documents.length > 0);
    const missing = caseData.evidenceItems.filter((i) => i.documents.length === 0);
    lines.push("Evidence ready to present:");
    lines.push(
      ...(ready.length > 0
        ? ready.map((i) => `  - ${i.label} (${i.documents.map((d) => d.fileName).join(", ")})`)
        : ["  (none uploaded yet)"]),
    );
    if (missing.length > 0) {
      lines.push("");
      lines.push("Not yet gathered:");
      lines.push(...missing.map((i) => `  - ${i.label}`));
    }
  } else {
    lines.push("No evidence checklist generated for this case yet.");
  }

  return lines.join("\n");
}

export async function recordArbDecision(
  protestId: string,
  decision: { type: ArbDecision; date: string; finalValue: number },
): Promise<void> {
  const resolved = decision.type === "approved";
  const { error } = await supabase
    .from("protests")
    .update({
      arb_decision: decision.type,
      arb_decision_date: decision.date,
      final_value: decision.finalValue,
      status: resolved ? "resolved" : "decision_received",
      ...(resolved ? { closed_at: new Date().toISOString(), escalation_path: "accept" } : {}),
    })
    .eq("id", protestId);
  if (error) throw error;
  void logCaseEvent(
    protestId,
    "status_change",
    `ARB decision recorded: ${decision.type} — final value ${currencyText(decision.finalValue)}` +
      (resolved ? " (case resolved)." : "."),
    { arbDecision: decision.type, arbDecisionDate: decision.date, finalValue: decision.finalValue },
  );
}

export async function recordEscalation(
  protestId: string,
  path: "appeal" | "arbitration",
): Promise<void> {
  const { error } = await supabase
    .from("protests")
    .update({ escalation_path: path, status: path === "appeal" ? "appealing" : "arbitrating" })
    .eq("id", protestId);
  if (error) throw error;
  void logCaseEvent(
    protestId,
    "status_change",
    path === "appeal"
      ? "Escalation recorded: district court appeal."
      : "Escalation recorded: binding arbitration.",
    { escalationPath: path },
  );
}

// Structured case-record fields with no other home (see src/lib/case-record.ts):
// the filing confirmation number, how it was filed, a certified-mail tracking
// number, and the "yes, I submitted my evidence to the ARB" confirmation. All
// self-reported — same precedent as every other column on this table.
export type CaseRecordPatch = {
  filingConfirmationNumber?: string | null;
  filingChannel?: "online" | "mail" | "in_person" | "email" | null;
  certifiedMailTracking?: string | null;
  evidenceSubmittedConfirmedAt?: string | null;
};

export async function saveCaseRecordFields(
  protestId: string,
  patch: CaseRecordPatch,
): Promise<void> {
  const row: Record<string, unknown> = {};
  if ("filingConfirmationNumber" in patch)
    row.filing_confirmation_number = patch.filingConfirmationNumber || null;
  if ("filingChannel" in patch) row.filing_channel = patch.filingChannel || null;
  if ("certifiedMailTracking" in patch)
    row.certified_mail_tracking = patch.certifiedMailTracking || null;
  if ("evidenceSubmittedConfirmedAt" in patch)
    row.evidence_submitted_confirmed_at = patch.evidenceSubmittedConfirmedAt || null;
  if (Object.keys(row).length === 0) return;
  const { error } = await supabase.from("protests").update(row).eq("id", protestId);
  if (error) throw error;
  if (patch.filingConfirmationNumber)
    void logCaseEvent(
      protestId,
      "submission_confirmed",
      `Filing confirmation number recorded: ${patch.filingConfirmationNumber}` +
        (patch.filingChannel ? ` (filed ${patch.filingChannel.replace("_", " ")}).` : "."),
    );
  if (patch.certifiedMailTracking)
    void logCaseEvent(
      protestId,
      "submission_confirmed",
      `Certified-mail tracking recorded: ${patch.certifiedMailTracking}.`,
    );
  if (patch.evidenceSubmittedConfirmedAt)
    void logCaseEvent(
      protestId,
      "submission_confirmed",
      "Evidence submission to the ARB confirmed.",
    );
}

// Closes out an appeal or arbitration once *that* resolves — doesn't model the
// appeal/arbitration's own sub-process, just captures that it happened and what
// the case ultimately settled at.
export async function closeCase(protestId: string, finalValue: number): Promise<void> {
  const { error } = await supabase
    .from("protests")
    .update({ final_value: finalValue, closed_at: new Date().toISOString(), status: "resolved" })
    .eq("id", protestId);
  if (error) throw error;
  void logCaseEvent(
    protestId,
    "status_change",
    `Case closed — final value ${currencyText(finalValue)}.`,
    { finalValue },
  );
}

export type CaseResults = { valueReduction: number; actualSavings: number };

// Real, decision-backed numbers — not the intake-time estimate. Only meaningful
// once a case has both an original snapshot and a final determined value on file.
export function getCaseResults(
  protest: Pick<ProtestRecord, "originalValue" | "finalValue">,
  property: Pick<PropertyRecord, "cad">,
): CaseResults | null {
  if (protest.originalValue == null || protest.finalValue == null) return null;
  const valueReduction = Math.max(0, protest.originalValue - protest.finalValue);
  const rate = getEffectiveTaxRate(property.cad);
  return {
    valueReduction: Math.round(valueReduction),
    actualSavings: Math.round(valueReduction * rate),
  };
}
