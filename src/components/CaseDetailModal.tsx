import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { askAboutDocument } from "@/lib/document-ai";
import { MarkdownLite } from "@/components/MarkdownLite";
import {
  updatePropertyIdentity,
  buildAiReportIntakePatch,
  type PropertyRecord,
} from "@/lib/properties";
import {
  acknowledgeGuidance,
  INFORMAL_STATUS_LABEL,
  type ProtestRecord,
  type InformalStatus,
  type AttendanceType,
} from "@/lib/protests";
import { currency, updateIntake } from "@/lib/intake-store";
import {
  getCase,
  generateCasePrep,
  markFiled,
  recordSettlementOffer,
  acceptSettlement,
  scheduleHearing,
  getHearingPrep,
  recordArbDecision,
  recordEscalation,
  closeCase,
  getCaseResults,
  updateInformalStatus,
  scheduleInformalReview,
  resolveInformalSettlement,
  saveInformalAppraiserCategory,
  saveAttendanceType,
  type ProtestCase,
} from "@/lib/protest-case";
import { getCaseGuidance } from "@/lib/case-guidance";
import {
  evaluateEscalation,
  type EscalationOption,
  type EscalationEvaluation,
} from "@/lib/escalation-eval";
import {
  getCaseRecord,
  caseRecordStage,
  outstandingProofPrompts,
  caseRecordCompletion,
  type CaseRecordItem,
} from "@/lib/case-record";
import {
  logCaseEvent,
  getCaseAuditTrail,
  caseAuditKindLabel,
  type CaseAuditEvent,
} from "@/lib/case-audit";
import { saveCaseRecordFields } from "@/lib/protest-case";
import { listDocuments } from "@/lib/documents";
import {
  getCountyProtestInfo,
  COUNTY_PROTEST_INFO,
  type CountyProtestInfo,
} from "@/lib/county-protest-info";
import {
  getPreFilingCheck,
  isPreFilingBlocked,
  type PreFilingCheckItem,
} from "@/lib/pre-filing-check";
import {
  uploadDocument,
  getProtestEvidenceDocuments,
  getFilingProofDocuments,
  getDocumentById,
  getDocumentUrl,
  FILING_PROOF_DOCUMENT_TYPE,
  SETTLEMENT_DOCUMENT_TYPE,
  DECISION_DOCUMENT_TYPE,
  type DocumentRecord,
} from "@/lib/documents";
import { verifyFilingProof, type FilingProofVerification } from "@/lib/filing-proof";
import {
  extractHearingNotice,
  saveHearingNotice,
  getLatestHearingNotice,
  type HearingNoticeRecord,
  type HearingNoticeExtraction,
  type HearingMode,
} from "@/lib/hearing-notice";
import {
  getInformalReviewGuidance,
  buildInformalReviewMailto,
  type InformalReviewGuidance,
} from "@/lib/informal-review";
import { getHearingPrepGuide, type HearingPrepGuide } from "@/lib/hearing-prep";
import { getHearingUserStatus, type HearingUserStatus } from "@/lib/hearing-status";
import {
  extractDecisionDocument,
  saveDecisionNotice,
  getLatestDecisionNotice,
  type DecisionNoticeRecord,
  type DecisionExtraction,
} from "@/lib/decision-notice";
import {
  extractSettlementDocument,
  saveSettlementAgreement,
  getLatestSettlementAgreement,
  confirmSettlementAgreement,
  signSettlementAgreement,
  recordSettlementResponse,
  verifySignedSettlementCopy,
  confirmSettlementOutcome,
  type SettlementAgreementRecord,
} from "@/lib/settlement-agreement";
import { getEffectiveTaxRate } from "@/lib/texas-tax-rates";
import { getErrorMessage } from "@/lib/error-message";
import { getAuthorization, type AuthorizationRecord } from "@/lib/protest-authorizations";
import {
  getNoticeOfProtestDefaults,
  getAppointmentOfAgentDefaults,
  getAdditionalOwnerPropertyFields,
  getEvidenceDeclarationDefaults,
  buildPdf,
  signPdf,
  downloadPdf,
  resolveDateFields,
  NOTICE_OF_PROTEST_SCHEMA,
  APPOINTMENT_OF_AGENT_SCHEMA,
  EVIDENCE_DECLARATION_SCHEMA,
  type FieldValues,
} from "@/lib/protest-documents";
import {
  getSubmission,
  saveDraft,
  signAndSubmit,
  type FormType,
} from "@/lib/protest-form-submissions";
import { searchPropertiesByOwner } from "@/lib/cad-owner-search";
import { draftProtestReason } from "@/lib/protest-reason";
import { PdfFormEditor } from "@/components/PdfFormEditor";
import { FilingMethodsList } from "@/components/FilingMethodsList";
import { Skeleton } from "@/components/ui/skeleton";
import { SignaturePad, type SignatureValue } from "@/components/SignaturePad";

// Renders as a full page (see routes/dashboard/_layout.case.tsx), not an
// overlay — previously this was a <Modal>; per product direction, View Case
// now navigates to its own URL instead of opening on top of whatever page
// triggered it. onBack is "return to wherever View Case was clicked from,"
// not "dismiss an overlay," even though the internal state/logic below is
// unchanged from the modal version.
export function CaseDetailView({
  userId,
  property: propertyProp,
  protest,
  onBack,
}: {
  userId: string;
  property: PropertyRecord;
  protest: ProtestRecord;
  onBack: () => void;
}) {
  const [caseData, setCaseData] = useState<ProtestCase | null>(null);
  const [loading, setLoading] = useState(true);
  const [current, setCurrent] = useState<ProtestRecord>(protest);
  // Local, editable copy — the Pre-Filing Check gate lets the customer
  // correct/confirm a missing identity field (see PreFilingGate) right
  // where Corvus flags it as blocking, without leaving this modal.
  const [property, setProperty] = useState<PropertyRecord>(propertyProp);
  const [acknowledging, setAcknowledging] = useState(false);
  // Real signed_at off the Notice of Protest submission (see
  // protest-form-submissions.ts) — the one honest signal this app has for
  // "has the customer actually signed this," distinct from and never
  // conflated with "filed." Lifted here (not local to DocumentsSection) so
  // CorvusGuidancePanel/NextStepFooter can give correct guidance too.
  const [noticeSignedAt, setNoticeSignedAt] = useState<string | null>(null);
  // Real "Protest Evidence"-tagged documents for this property — evidence
  // now uploads exclusively through Module 8 (ai-report.tsx), not a
  // checklist inside this modal (see CasePlanSection's "Upload Evidence —
  // Go to Module 8" button below), so this is the one real source every
  // evidence-aware feature here (Corvus's guidance, Pre-Filing Check,
  // Generate Suggested Reason) reads from.
  const [evidenceDocuments, setEvidenceDocuments] = useState<DocumentRecord[]>([]);
  // Lifted (not local to SettlementSignatureSection) so the top-of-case
  // "informal outcome unconfirmed" banner and HearingPrepSection's inline
  // warning read the same record the settlement section writes.
  const [settlementAgreement, setSettlementAgreement] = useState<SettlementAgreementRecord | null>(
    null,
  );

  function load() {
    setLoading(true);
    getCase(protest.id)
      .then(setCaseData)
      .catch((err) => toast.error(err instanceof Error ? err.message : "Could not load this case."))
      .finally(() => setLoading(false));
    getSubmission(protest.id, "notice_of_protest")
      .then((s) => setNoticeSignedAt(s?.signedAt ?? null))
      .catch((err) => console.error("Could not load Notice of Protest signing status:", err));
    getProtestEvidenceDocuments(userId, property.id)
      .then(setEvidenceDocuments)
      .catch((err) => console.error("Could not load this case's evidence documents:", err));
    getLatestSettlementAgreement(protest.id)
      .then(setSettlementAgreement)
      .catch((err) => console.error("Could not load this case's settlement agreement:", err));
  }

  useEffect(load, [protest.id]);

  // If a fresher protest prop arrives with the filing notice already
  // accepted (e.g. this view stayed mounted while the parent refetched),
  // carry that in so the one-time notice doesn't reappear. Only ever fills
  // the ack — never clobbers a locally-edited field.
  useEffect(() => {
    if (protest.corvusGuidanceAckAt) {
      setCurrent((c) =>
        c.corvusGuidanceAckAt ? c : { ...c, corvusGuidanceAckAt: protest.corvusGuidanceAckAt },
      );
    }
  }, [protest.corvusGuidanceAckAt]);

  async function handleAcknowledgeGuidance() {
    setAcknowledging(true);
    try {
      await acknowledgeGuidance(protest.id);
      setCurrent((prev) => ({ ...prev, corvusGuidanceAckAt: new Date().toISOString() }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not continue — please try again.");
    } finally {
      setAcknowledging(false);
    }
  }

  // One-time per case: the AI Guidance & Filing Notice gates a not-yet-filed
  // case only until the customer has accepted it once (persisted as
  // protests.corvus_guidance_ack_at). After that it never shows again for
  // this case — reopening View Case, switching tabs, or a new session.
  const needsGuidanceAck = current.status === "requested" && !current.corvusGuidanceAckAt;

  return (
    <div>
      <button onClick={onBack} className="btn-outline text-sm mb-4">
        ← Back
      </button>
      <h3 className="font-serif text-xl font-semibold">Case: {property.address}</h3>
      <p className="text-xs text-muted-foreground">
        AI-generated from your property's official CAD record.
      </p>

      {loading ? (
        <div className="mt-4 grid gap-2">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : needsGuidanceAck ? (
        <CorvusGuidanceGate
          onAcknowledge={handleAcknowledgeGuidance}
          acknowledging={acknowledging}
        />
      ) : (
        <>
          <CorvusGuidancePanel
            property={property}
            protest={current}
            evidenceDocumentCount={evidenceDocuments.length}
            noticeSignedAt={noticeSignedAt}
          />

          <InformalOutcomeBanner protest={current} agreement={settlementAgreement} />

          <CasePlanSection
            userId={userId}
            property={property}
            protestId={protest.id}
            caseData={caseData}
            onReload={load}
          />

          {current.status === "requested" ? (
            <PreFilingGate
              userId={userId}
              property={property}
              protest={current}
              caseData={caseData}
              evidenceDocuments={evidenceDocuments}
              noticeSignedAt={noticeSignedAt}
              onUpdate={(patch) => setCurrent((prev) => ({ ...prev, ...patch }))}
              onPropertyUpdate={(patch) => setProperty((prev) => ({ ...prev, ...patch }))}
              onNoticeSigned={setNoticeSignedAt}
            />
          ) : (
            <DocumentsSection
              userId={userId}
              protest={current}
              property={property}
              strategyRecommendation={caseData?.strategyRecommendation ?? null}
              noticeSignedAt={noticeSignedAt}
              evidenceDocuments={evidenceDocuments}
              onUpdate={(patch) => setCurrent((prev) => ({ ...prev, ...patch }))}
              onNoticeSigned={setNoticeSignedAt}
            />
          )}

          {current.status !== "requested" && (
            <InformalReviewSection
              protest={current}
              property={property}
              strategyRecommendation={caseData?.strategyRecommendation ?? null}
              evidenceDocuments={evidenceDocuments}
              onUpdate={(patch) => setCurrent((prev) => ({ ...prev, ...patch }))}
            />
          )}

          {current.status !== "requested" && (
            <HearingNoticeSection
              userId={userId}
              protest={current}
              property={property}
              onUpdate={(patch) => setCurrent((prev) => ({ ...prev, ...patch }))}
            />
          )}

          <HearingPrepSection
            protest={current}
            property={property}
            caseData={caseData}
            evidenceDocuments={evidenceDocuments}
            settlementAgreement={settlementAgreement}
            onUpdate={(patch) => setCurrent((prev) => ({ ...prev, ...patch }))}
          />

          {current.status !== "requested" && (
            <SettlementSignatureSection
              userId={userId}
              protest={current}
              property={property}
              agreement={settlementAgreement}
              onAgreementChange={setSettlementAgreement}
              onUpdate={(patch) => setCurrent((prev) => ({ ...prev, ...patch }))}
            />
          )}

          <DecisionNoticeSection
            userId={userId}
            protest={current}
            property={property}
            onUpdate={(patch) => setCurrent((prev) => ({ ...prev, ...patch }))}
          />

          <EscalationEvaluationSection
            protest={current}
            property={property}
            evidenceDocumentCount={evidenceDocuments.length}
            onUpdate={(patch) => setCurrent((prev) => ({ ...prev, ...patch }))}
          />

          <CaseProgress
            protest={current}
            property={property}
            caseData={caseData}
            onUpdate={(patch) => setCurrent((prev) => ({ ...prev, ...patch }))}
          />

          <CaseRecordSection
            userId={userId}
            protest={current}
            property={property}
            onUpdate={(patch) => setCurrent((prev) => ({ ...prev, ...patch }))}
          />

          <CaseAuditTrailSection protestId={protest.id} />

          <NextStepFooter
            property={property}
            protest={current}
            evidenceDocumentCount={evidenceDocuments.length}
            noticeSignedAt={noticeSignedAt}
          />
        </>
      )}
    </div>
  );
}

// Consent screen gating entry into a not-yet-filed case, shown on every open
// (not just the first) per explicit product direction — exact copy per the
// spec this was built from. An acknowledgment, not a legal document, so a
// checkbox + button is enough (no signature capture, unlike the real Service
// Agreement in ProtestAuthorizationFlow.tsx).
function CorvusGuidanceGate({
  onAcknowledge,
  acknowledging,
}: {
  onAcknowledge: () => void;
  acknowledging: boolean;
}) {
  const [checked, setChecked] = useState(false);
  return (
    <div className="mt-4 grid gap-4">
      <div className="card-elev p-4">
        <h4 className="text-sm font-semibold">AI Guidance & Filing Notice</h4>
        <div className="mt-2 grid gap-2 text-sm text-muted-foreground">
          <p>
            Corvus AI is an assistant designed to guide you through the property protest process and
            help prepare and complete the required forms and documents.
          </p>
          <p>
            By proceeding, you authorize Corvus AI to assist with completing forms and preparing
            filing materials on your behalf.
          </p>
          <p>
            You are responsible for reviewing and verifying all information before signing, filing,
            or submitting any document.
          </p>
          <p>
            Corvus AI does not replace your responsibility to verify the accuracy of the information
            or comply with county requirements.
          </p>
        </div>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          className="mt-0.5"
        />
        I have read and understand this notice.
      </label>
      <button
        onClick={onAcknowledge}
        disabled={!checked || acknowledging}
        className="btn-accent w-fit text-sm disabled:opacity-60"
      >
        {acknowledging ? "Continuing…" : "Continue to Case"}
      </button>
    </div>
  );
}

// Shared by CorvusGuidancePanel and NextStepFooter below — a GuidanceStep's
// action.anchor is either a real element id already rendered by an existing
// section (scroll to it) or a real external URL (open it), never a route
// change or a new surface.
function goToGuidanceAnchor(anchor: string) {
  if (anchor.startsWith("http")) {
    window.open(anchor, "_blank", "noopener,noreferrer");
    return;
  }
  // tel:/mailto: — window.open() on these triggers a popup blocker or opens
  // a blank tab in most browsers; a plain location assignment is what
  // actually hands off to the phone/mail app reliably.
  if (anchor.startsWith("tel:") || anchor.startsWith("mailto:")) {
    window.location.href = anchor;
    return;
  }
  const el = document.getElementById(anchor);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  // Target not in the DOM yet (a section that just conditionally mounted) —
  // try once more next frame before giving up, so the click is never a
  // silent no-op for a purely timing reason.
  requestAnimationFrame(() => {
    document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

// Ambient, ongoing guidance — purely additive, sits above the existing
// sections on every visit once the one-time filing notice above has been
// accepted for this case. Every fact it shows comes from getCaseGuidance()'s
// deterministic mapping of real case/property/county data — never
// AI-generated. No checkbox, no gating: informational only, and nothing
// below it is disabled or hidden by its presence.
function CorvusGuidancePanel({
  property,
  protest,
  evidenceDocumentCount,
  noticeSignedAt,
}: {
  property: PropertyRecord;
  protest: ProtestRecord;
  evidenceDocumentCount: number;
  noticeSignedAt: string | null;
}) {
  const [countyOpen, setCountyOpen] = useState(false);
  const countyInfo = getCountyProtestInfo(property.cad);
  const guidance = getCaseGuidance(
    property,
    protest,
    evidenceDocumentCount,
    countyInfo,
    noticeSignedAt,
  );

  return (
    <div className="mt-4 card-elev p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Corvus AI Guidance
        </span>
        <span className="badge-soft">{guidance.stageLabel}</span>
      </div>
      <p className="mt-2 text-sm">{guidance.summary}</p>

      {guidance.nextSteps.length > 0 && (
        <div className="mt-3 grid gap-2">
          <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            What to do next
          </h5>
          <ul className="grid gap-1.5">
            {guidance.nextSteps.map((step, i) => (
              <li key={i} className="text-sm">
                <span className="font-medium">{step.label}</span>
                {step.detail && <span className="text-muted-foreground"> — {step.detail}</span>}
                {step.action && (
                  <button
                    onClick={() => goToGuidanceAnchor(step.action!.anchor)}
                    className="ml-2 text-xs text-accent hover:underline"
                  >
                    {step.action.label} →
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {countyInfo && (
        <div className="mt-3 border-t border-border pt-3">
          <button
            onClick={() => setCountyOpen((v) => !v)}
            className="text-xs font-semibold text-accent hover:underline"
          >
            {countyOpen ? "Hide" : "Show"} your county's protest process
          </button>
          {countyOpen && (
            <div className="mt-2 grid gap-2 text-xs text-muted-foreground">
              <div>
                <span className="font-medium text-foreground">How to file: </span>
                <FilingMethodsList countyInfo={countyInfo} />
              </div>
              {countyInfo.arbContact &&
                (countyInfo.arbContact.phone || countyInfo.arbContact.email) && (
                  <div>
                    <span className="font-medium text-foreground">ARB contact: </span>
                    {[countyInfo.arbContact.phone, countyInfo.arbContact.email]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                )}
              {countyInfo.informalReview && (
                <div>
                  <span className="font-medium text-foreground">Informal review: </span>
                  {countyInfo.informalReview.howToRequest}
                </div>
              )}
              <div className="pt-1">
                Source:{" "}
                <a
                  href={countyInfo.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  {countyInfo.cad}
                </a>{" "}
                (verified {countyInfo.verifiedAt})
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Repeats just the single most important next step at the very bottom of
// the modal, right above Close — CorvusGuidancePanel's own copy of this
// sits at the top, which a user scrolled down to Evidence
// Checklist/Documents/Case Progress (e.g. right after uploading a file or
// downloading a form) won't see without scrolling back up. Same real
// getCaseGuidance() data, not a separate/invented message. Renders nothing
// once there's genuinely no next step (e.g. a resolved case).
function NextStepFooter({
  property,
  protest,
  evidenceDocumentCount,
  noticeSignedAt,
}: {
  property: PropertyRecord;
  protest: ProtestRecord;
  evidenceDocumentCount: number;
  noticeSignedAt: string | null;
}) {
  const countyInfo = getCountyProtestInfo(property.cad);
  const guidance = getCaseGuidance(
    property,
    protest,
    evidenceDocumentCount,
    countyInfo,
    noticeSignedAt,
  );
  const next = guidance.nextSteps[0];
  if (!next) return null;

  return (
    <div className="mt-5 rounded-md border border-accent/30 bg-accent/5 p-3 text-sm">
      <span className="font-semibold">Next: {next.label}.</span>
      {next.detail && <span className="text-muted-foreground"> {next.detail}</span>}
      {next.action && (
        <button
          onClick={() => goToGuidanceAnchor(next.action!.anchor)}
          className="ml-2 text-xs text-accent hover:underline"
        >
          {next.action.label} →
        </button>
      )}
    </div>
  );
}

// Runs before the user can reach Documents/filing at all. Every fact comes
// from getPreFilingCheck() — real case/property/evidence fields, plus real
// per-county data from county-protest-info.ts, never AI-invented. If a
// blocking field (case identity/deadline) is missing, filing stops here and
// DocumentsSection is not rendered until it's corrected — the non-blocking
// procedural rows (filing method, county contact, etc.) are informational
// and never stop filing on their own, since the app's own generic form is
// always a valid fallback even where a specific county detail isn't
// confirmed.
function PreFilingGate({
  userId,
  property,
  protest,
  caseData,
  evidenceDocuments,
  noticeSignedAt,
  onUpdate,
  onPropertyUpdate,
  onNoticeSigned,
}: {
  userId: string;
  property: PropertyRecord;
  protest: ProtestRecord;
  caseData: ProtestCase | null;
  evidenceDocuments: DocumentRecord[];
  noticeSignedAt: string | null;
  onUpdate: (patch: Partial<ProtestRecord>) => void;
  onPropertyUpdate: (patch: Partial<PropertyRecord>) => void;
  onNoticeSigned: (signedAt: string | null) => void;
}) {
  const items = getPreFilingCheck(property, protest, evidenceDocuments.length);
  const blocked = isPreFilingBlocked(items);

  return (
    <>
      {/* While the readiness check is blocked the Documents section (and its
          own id="case-documents") isn't rendered — so Corvus Guidance's
          "Review Notice of Protest" link would scroll to nothing. Carry the
          id here in that case so the link lands the user on exactly what's
          blocking them. Exactly one element ever has the id. */}
      <div id={blocked ? "case-documents" : undefined} className="mt-5 border-t border-border pt-5">
        <PreFilingCheckList
          items={items}
          blocked={blocked}
          propertyId={property.id}
          onFixed={onPropertyUpdate}
        />
        {blocked && (
          <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            Corvus AI can't confirm this case is ready to file — please correct or confirm the
            field(s) marked "Missing" above before filing. Use "Confirm/edit" next to each one.
            Documents are hidden until this is resolved.
          </div>
        )}
      </div>
      {!blocked && (
        <DocumentsSection
          userId={userId}
          protest={protest}
          property={property}
          strategyRecommendation={caseData?.strategyRecommendation ?? null}
          noticeSignedAt={noticeSignedAt}
          evidenceDocuments={evidenceDocuments}
          onUpdate={onUpdate}
          onNoticeSigned={onNoticeSigned}
        />
      )}
    </>
  );
}

// Maps a blocking PreFilingCheckItem's label to the real property field it
// corrects and the input shape that field needs — County uses a closed
// dropdown of the exact cad strings the rest of the app recognizes (a
// free-typed county would silently break every county-specific lookup),
// everything else is free text/number/date.
const BLOCKING_FIELD_MAP: Record<
  string,
  {
    key: "cad" | "address" | "accountNumber" | "ownerName" | "taxYear" | "protestDeadline";
    type: "select" | "text" | "number" | "date";
  }
> = {
  County: { key: "cad", type: "select" },
  "Property Address": { key: "address", type: "text" },
  "Account Number": { key: "accountNumber", type: "text" },
  "Tax Year": { key: "taxYear", type: "number" },
  "Owner / Entity": { key: "ownerName", type: "text" },
  "Protest Deadline": { key: "protestDeadline", type: "date" },
};

function PreFilingCheckList({
  items,
  blocked,
  propertyId,
  onFixed,
}: {
  items: PreFilingCheckItem[];
  blocked: boolean;
  propertyId: string;
  onFixed: (patch: Partial<PropertyRecord>) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">Pre-Filing Check</h4>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
            blocked ? "bg-destructive/10 text-destructive" : "bg-success/15 text-success"
          }`}
        >
          {blocked ? "Action Needed" : "Ready to File"}
        </span>
      </div>
      <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
        {items.map((item) => {
          const missing = item.status === "missing";
          const field = missing ? BLOCKING_FIELD_MAP[item.label] : undefined;
          return (
            <div key={item.label} className="grid gap-1 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">{item.label}</span>
                <span
                  className={`truncate ${missing ? "text-destructive" : "text-success"}`}
                  title={item.value ?? undefined}
                >
                  {missing ? "Missing" : (item.value ?? "Confirmed")}
                </span>
              </div>
              {field && (
                <PreFilingFixRow
                  label={item.label}
                  field={field.key}
                  inputType={field.type}
                  propertyId={propertyId}
                  onFixed={onFixed}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Lets the customer directly correct/confirm a missing blocking field,
// right where Corvus flags it — the real fix for a property that never had
// this data (e.g. added via CAD search rather than an uploaded notice AI
// could extract a real deadline from). Saves via updatePropertyIdentity and
// bubbles the real updated field back up so PreFilingGate re-evaluates
// immediately, same pattern as CaseProgress's forms.
function PreFilingFixRow({
  label,
  field,
  inputType,
  propertyId,
  onFixed,
}: {
  label: string;
  field: "cad" | "address" | "accountNumber" | "ownerName" | "taxYear" | "protestDeadline";
  inputType: "select" | "text" | "number" | "date";
  propertyId: string;
  onFixed: (patch: Partial<PropertyRecord>) => void;
}) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!value.trim()) return;
    setSaving(true);
    try {
      const patch = field === "taxYear" ? { taxYear: Number(value) } : { [field]: value };
      const updated = await updatePropertyIdentity(propertyId, patch);
      onFixed(updated);
      toast.success(`${label} saved.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Could not save ${label}.`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {inputType === "select" ? (
        <select
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 py-1 text-xs"
        >
          <option value="">Select {label}…</option>
          {Object.keys(COUNTY_PROTEST_INFO).map((cad) => (
            <option key={cad} value={cad}>
              {cad}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={inputType === "number" ? "number" : inputType === "date" ? "date" : "text"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={`Enter ${label}`}
          className="min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 py-1 text-xs"
        />
      )}
      <button
        onClick={handleSave}
        disabled={saving || !value.trim()}
        className="shrink-0 btn-outline px-2 py-1 text-[11px] disabled:opacity-60"
      >
        {saving ? "Saving…" : "Confirm/edit"}
      </button>
    </div>
  );
}

// Real Texas Comptroller forms (Form 50-132, Form 50-162 — see
// src/lib/protest-documents.ts), pre-filled from data already on this case.
// Neither is auto-signed; both need review + a real signature before filing.
// Strategy + Evidence Checklist + "Generate Case Plan" — shared by the customer
// modal (CaseDetailModal, above) and the staff modal (AdminCaseProgressModal),
// same reuse pattern as DocumentsSection/CaseProgress below. `userId` must be the
// case-owning CUSTOMER's id even when this renders inside the admin panel — both
// generateCasePrep()'s protest_evidence_items insert and uploadDocument()'s row/
// storage-path use it directly, and the customer's own RLS policies (unaffected by
// this component's admin-added INSERT/UPDATE policies) key off that same value.
export function CasePlanSection({
  userId,
  property,
  protestId,
  caseData,
  onReload,
  // Module 8 lives on the customer's own /ai-report page, keyed to
  // whoever is currently signed in — for staff (AdminCaseProgressModal),
  // that's the admin, not the customer, so navigating there would try to
  // resolve/create this property under the ADMIN's account instead.
  // Customer view leaves this at its default (true); admin passes false.
  allowEvidenceUpload = true,
}: {
  userId: string;
  property: PropertyRecord;
  protestId: string;
  caseData: ProtestCase | null;
  onReload: () => void;
  allowEvidenceUpload?: boolean;
}) {
  const [generating, setGenerating] = useState(false);

  async function handleGenerate() {
    setGenerating(true);
    try {
      await generateCasePrep(protestId, userId, property);
      onReload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not generate the case plan.");
    } finally {
      setGenerating(false);
    }
  }

  // Evidence upload lives in exactly one place now — Module 8 on the AI
  // Report page — rather than duplicated here too. Sets this property as
  // the report's subject the same real way "View AI Report" already does
  // from the Properties dashboard (buildAiReportIntakePatch), then deep
  // links straight into the Evidence module (ai-report.tsx's own
  // ?openModule=evidence handling, built for exactly this button). Opens in
  // a new tab (window.open, not router navigate) so the case modal stays
  // open behind it — the sessionStorage write above happens synchronously
  // before the tab opens, so the new same-origin tab inherits it.
  function goToModule8() {
    updateIntake(buildAiReportIntakePatch(property));
    // import.meta.env.BASE_URL is "/" in dev and "/corvuspt/" on the GitHub
    // Pages build — a raw "/ai-report" absolute path skips that prefix and
    // 404s in production. Always build the URL from BASE_URL.
    window.open(`${import.meta.env.BASE_URL}ai-report?openModule=evidence`, "_blank");
  }

  const hasAnyPlan = !!caseData?.strategyRecommendation;

  if (!hasAnyPlan) {
    return (
      <div className="mt-4 grid gap-3">
        <p className="text-sm text-muted-foreground">No case plan yet.</p>
        <button
          onClick={handleGenerate}
          disabled={generating}
          className="btn-accent w-fit text-sm disabled:opacity-60"
        >
          {generating ? "Generating…" : "Generate Case Plan"}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-4 grid gap-5">
      <section>
        <h4 className="text-sm font-semibold">Strategy</h4>
        {caseData?.strategyRecommendation ? (
          <div className="mt-1">
            <span className="badge-soft">{caseData.strategyRecommendation}</span>
            {caseData.strategyConfidencePct != null && (
              <span className="ml-2 text-xs text-muted-foreground">
                {caseData.strategyConfidencePct}% confidence
              </span>
            )}
            {caseData.strategyRationale && (
              <p className="mt-1.5 text-sm text-muted-foreground">{caseData.strategyRationale}</p>
            )}
          </div>
        ) : (
          <div className="mt-1 flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Not available yet.</span>
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="text-xs text-accent hover:underline disabled:opacity-60"
            >
              {generating ? "Retrying…" : "Retry"}
            </button>
          </div>
        )}
      </section>

      {allowEvidenceUpload && (
        <section id="case-upload-evidence">
          <button onClick={goToModule8} className="btn-outline w-fit text-sm">
            Upload Evidence — Go to Module 8
          </button>
        </section>
      )}
    </div>
  );
}

// Real, county-specific guidance on what "proof of filing" actually looks
// like for each real way this county accepts a protest — grounded in the
// same real filingMethod facts FilingMethodsList already reads, not generic
// advice. Every county returns at least one real tip, or the honest
// fallback below when this county has no confirmed filing methods on file.
function filingProofGuidance(countyInfo: CountyProtestInfo | null): string[] {
  const tips: string[] = [];
  if (countyInfo?.filingMethod.online) {
    tips.push(
      "Filed online: a screenshot or PDF of the confirmation page, or the confirmation email the portal sent you.",
    );
  }
  if (countyInfo?.filingMethod.mail) {
    tips.push(
      "Mailed it: a photo of your Certified Mail receipt/tracking number, or the postmarked envelope.",
    );
  }
  if (countyInfo?.filingMethod.inPerson) {
    tips.push(
      "Delivered in person: a photo of the stamped/dated copy the district handed back to you.",
    );
  }
  if (countyInfo?.filingMethod.email.available) {
    tips.push("Emailed it: a screenshot of your sent email, or any reply confirming receipt.");
  }
  if (tips.length === 0) {
    tips.push(
      "Any confirmation you received when you submitted it — a screenshot, email, receipt, or stamped copy.",
    );
  }
  return tips;
}

// "Have you completed and submitted your property protest?" — the real gate
// before a case moves to "filed" (see handleMarkFiled and friends in
// DocumentsSection below). Two steps: the Yes/Not Yet question itself, then
// — only after Yes — real proof upload plus an advisory AI read of what it
// shows. Never auto-advances; every step here needs an explicit click.
function FilingConfirmationFlow({
  step,
  countyInfo,
  proofDocs,
  uploadingProof,
  onUploadProof,
  proofCheck,
  checkingProof,
  proofCheckError,
  onRecheck,
  markingFiled,
  onNotYet,
  onConfirmIntent,
  onConfirmFiled,
}: {
  step: "ask" | "proof";
  countyInfo: CountyProtestInfo | null;
  proofDocs: DocumentRecord[];
  uploadingProof: boolean;
  onUploadProof: (files: File[]) => void;
  proofCheck: FilingProofVerification | null;
  checkingProof: boolean;
  proofCheckError: string | null;
  onRecheck: () => void;
  markingFiled: boolean;
  onNotYet: () => void;
  onConfirmIntent: () => void;
  onConfirmFiled: () => void;
}) {
  if (step === "ask") {
    return (
      <div className="mt-3 rounded-md border border-accent/40 bg-accent/5 p-4 text-sm">
        <p className="font-medium">Have you completed and submitted your property protest?</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={onConfirmIntent} className="btn-accent text-xs py-1.5">
            Yes — Protest Filed
          </button>
          <button onClick={onNotYet} className="btn-outline text-xs py-1.5">
            Not Yet
          </button>
        </div>
      </div>
    );
  }

  const tips = filingProofGuidance(countyInfo);
  return (
    <div className="mt-3 rounded-md border border-accent/40 bg-accent/5 p-4 text-sm">
      <p className="font-medium">Upload proof that you filed</p>
      <p className="mt-1 text-xs text-muted-foreground">
        This app has no direct connection to {countyInfo?.cad ?? "your county"} — your own proof is
        the record this case relies on. What counts as proof depends on how you filed:
      </p>
      <ul className="mt-2 grid gap-1 text-xs text-muted-foreground">
        {tips.map((tip) => (
          <li key={tip}>• {tip}</li>
        ))}
      </ul>

      {proofDocs.length > 0 && (
        <ul className="mt-3 grid gap-1 text-xs">
          {proofDocs.map((doc) => (
            <li key={doc.id} className="text-foreground">
              {doc.fileName}
            </li>
          ))}
        </ul>
      )}

      <label
        className={`mt-3 inline-flex btn-outline cursor-pointer py-1.5 text-xs ${uploadingProof ? "pointer-events-none opacity-60" : ""}`}
      >
        {uploadingProof ? "Uploading…" : "Upload Proof"}
        <input
          type="file"
          accept="image/*,.pdf"
          multiple
          className="hidden"
          disabled={uploadingProof}
          onChange={(e) => {
            const selected = e.target.files ? Array.from(e.target.files) : [];
            e.target.value = "";
            if (selected.length > 0) onUploadProof(selected);
          }}
        />
      </label>

      {checkingProof && (
        <p className="mt-3 text-xs text-muted-foreground">Checking what this shows…</p>
      )}
      {proofCheckError && <p className="mt-3 text-xs text-destructive">{proofCheckError}</p>}
      {proofCheck && !checkingProof && (
        <div className="mt-3 rounded-md border border-border p-2.5 text-xs">
          <div className="font-medium">AI check — review before confirming</div>
          <div className="mt-1.5 grid gap-1.5">
            {proofCheck.findings.map((f, i) => (
              <div key={i}>
                <span className="font-medium">{f.fileName}:</span>{" "}
                {f.hasVisibleSignature ? (
                  <span className="text-success">
                    signature visible
                    {f.signatureNameObserved ? ` (${f.signatureNameObserved})` : ""}
                  </span>
                ) : (
                  <span className="text-warning-foreground">no signature visible</span>
                )}
                {f.dateObserved && (
                  <>
                    {" · date: "}
                    <span className={f.dateYearPlausible === false ? "text-destructive" : ""}>
                      {f.dateObserved}
                      {f.dateYearPlausible === false
                        ? " — looks like it may be a prior year, please double-check"
                        : ""}
                    </span>
                  </>
                )}
                <p className="mt-0.5 text-muted-foreground">{f.notes}</p>
              </div>
            ))}
          </div>
          {proofCheck.overallAssessment && (
            <p className="mt-1.5 text-muted-foreground">{proofCheck.overallAssessment}</p>
          )}
          <button type="button" onClick={onRecheck} className="mt-1.5 text-accent hover:underline">
            Re-check
          </button>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          onClick={onConfirmFiled}
          disabled={proofDocs.length === 0 || markingFiled}
          title={proofDocs.length === 0 ? "Upload at least one proof document first" : undefined}
          className="btn-accent text-xs py-1.5 disabled:opacity-60"
        >
          {markingFiled ? "Saving…" : "Confirm — Mark as Filed"}
        </button>
        <button onClick={onNotYet} className="btn-outline text-xs py-1.5">
          Cancel
        </button>
      </div>
    </div>
  );
}

export function DocumentsSection({
  userId,
  protest,
  property,
  strategyRecommendation,
  noticeSignedAt,
  evidenceDocuments,
  onUpdate,
  onNoticeSigned,
  // Staff must never sign a legal filing on a customer's behalf — the admin
  // panel's copy of this section (AdminCaseProgressModal) passes false to
  // hide signing entirely, keeping Save Progress/Download available for
  // staff to help prep the form without ever touching the signature step.
  allowSigning = true,
}: {
  userId: string;
  protest: ProtestRecord;
  property: PropertyRecord;
  strategyRecommendation: string | null;
  noticeSignedAt: string | null;
  evidenceDocuments: DocumentRecord[];
  onUpdate: (patch: Partial<ProtestRecord>) => void;
  onNoticeSigned: (signedAt: string | null) => void;
  allowSigning?: boolean;
}) {
  const [markingFiled, setMarkingFiled] = useState(false);
  const [authorization, setAuthorization] = useState<AuthorizationRecord | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [editingForm, setEditingForm] = useState<"protest" | "agent" | "evidence" | null>(null);
  const [values, setValues] = useState<FieldValues>({});
  const [downloading, setDownloading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [signingOpen, setSigningOpen] = useState(false);
  const [signature, setSignature] = useState<SignatureValue | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [generatingReason, setGeneratingReason] = useState(false);
  // Same real signed_at signal as the Notice of Protest's noticeSignedAt
  // (see CaseDetailModal.tsx), but for the Appointment of Agent form —
  // kept local here rather than lifted, since nothing outside Documents
  // currently needs it. Loaded whenever the agent editor opens, below.
  const [agentFormSignedAt, setAgentFormSignedAt] = useState<string | null>(null);
  // Same again for the Evidence Declaration (Form 50-283) — note that
  // "signed" here only means the in-app signature was drawn and saved, not
  // that the affidavit was actually notarized (see PdfFormEditor's own
  // notarization notice for formKind "evidence-declaration").
  const [evidenceDeclarationSignedAt, setEvidenceDeclarationSignedAt] = useState<string | null>(
    null,
  );

  // "Have you completed and submitted your property protest?" flow — see
  // handleMarkFiled/handleConfirmFiled below. The case is never moved to
  // "filed" just because the Notice of Protest was signed; this is the real
  // gate: an explicit Yes, at least one real proof-of-filing document, and
  // an (advisory, never blocking) AI read of what that document shows.
  const [filingStep, setFilingStep] = useState<"closed" | "ask" | "proof">("closed");
  const [filingProofDocs, setFilingProofDocs] = useState<DocumentRecord[]>([]);
  const [uploadingProof, setUploadingProof] = useState(false);
  const [proofCheck, setProofCheck] = useState<FilingProofVerification | null>(null);
  const [checkingProof, setCheckingProof] = useState(false);
  const [proofCheckError, setProofCheckError] = useState<string | null>(null);

  useEffect(() => {
    getAuthorization(protest.id)
      .then(setAuthorization)
      .catch((err) => console.error(err))
      .finally(() => setAuthLoading(false));
  }, [protest.id]);

  useEffect(() => {
    getFilingProofDocuments(userId, property.id)
      .then(setFilingProofDocs)
      .catch((err) => console.error("Could not load proof-of-filing documents:", err));
  }, [userId, property.id]);

  const formType: FormType | null =
    editingForm === "protest"
      ? "notice_of_protest"
      : editingForm === "agent"
        ? "appointment_of_agent"
        : editingForm === "evidence"
          ? "evidence_declaration"
          : null;
  const templatePath =
    editingForm === "protest"
      ? "forms/50-132.pdf"
      : editingForm === "agent"
        ? "forms/50-162.pdf"
        : "forms/50-283.pdf";
  const schema =
    editingForm === "protest"
      ? NOTICE_OF_PROTEST_SCHEMA
      : editingForm === "agent"
        ? APPOINTMENT_OF_AGENT_SCHEMA
        : EVIDENCE_DECLARATION_SCHEMA;

  // Opens immediately with computed defaults (no loading state on click), then
  // swaps in a saved draft/signed submission if one exists — a prior Save
  // Progress or Sign & Submit always wins over freshly-computed defaults.
  function openProtestEditor() {
    setValues(
      getNoticeOfProtestDefaults(property, property.taxYear, strategyRecommendation, authorization),
    );
    setEditingForm("protest");
    setSigningOpen(false);
    setSignature(null);
    getSubmission(protest.id, "notice_of_protest")
      .then((existing) => existing && setValues(existing.fieldValues))
      .catch((err) => console.error("Could not load saved Notice of Protest draft:", err));
  }

  function openAgentEditor() {
    if (!authorization) return;
    setValues(getAppointmentOfAgentDefaults(authorization, property));
    setEditingForm("agent");
    setSigningOpen(false);
    setSignature(null);
    setAgentFormSignedAt(null);
    getSubmission(protest.id, "appointment_of_agent")
      .then((existing) => {
        if (existing) {
          setValues(existing.fieldValues);
          setAgentFormSignedAt(existing.signedAt);
        }
      })
      .catch((err) => console.error("Could not load saved Appointment of Agent draft:", err))
      .finally(fillAdditionalOwnerProperties);
  }

  function openEvidenceDeclarationEditor() {
    setValues(getEvidenceDeclarationDefaults(property, property.taxYear, evidenceDocuments.length));
    setEditingForm("evidence");
    setSigningOpen(false);
    setSignature(null);
    setEvidenceDeclarationSignedAt(null);
    getSubmission(protest.id, "evidence_declaration")
      .then((existing) => {
        if (existing) {
          setValues(existing.fieldValues);
          setEvidenceDeclarationSignedAt(existing.signedAt);
        }
      })
      .catch((err) => console.error("Could not load saved Evidence Declaration draft:", err));
  }

  // Same real deep link as CasePlanSection's own goToModule8 — evidence
  // upload lives in exactly one place (Module 8 on the AI Report page), so
  // this button just gets the user there rather than duplicating an upload
  // widget in a second location. Opens in a new tab so the case modal
  // stays open behind it.
  function goToModule8() {
    updateIntake(buildAiReportIntakePatch(property));
    // import.meta.env.BASE_URL is "/" in dev and "/corvuspt/" on the GitHub
    // Pages build — a raw "/ai-report" absolute path skips that prefix and
    // 404s in production. Always build the URL from BASE_URL.
    window.open(`${import.meta.env.BASE_URL}ai-report?openModule=evidence`, "_blank");
  }

  // Form 50-162 authorizes an agent for possibly several properties at once —
  // this case's own property already fills the first slot; this looks up any
  // OTHER real properties on file under the same owner name, in the same
  // appraisal district (an authorization is filed per-district, so a sibling
  // property in a different county doesn't belong on this form), and fills
  // the remaining slots. Reuses the exact same owner-name search Add
  // Ownerships already uses — real CAD data, never guessed. Runs after the
  // saved-draft check above (whichever wins) and only ever fills slots that
  // are still empty, so it can never clobber a saved draft or an edit the
  // user already made.
  async function fillAdditionalOwnerProperties() {
    const ownerName =
      property.ownerName || (authorization?.isEntity ? authorization.entityName : null);
    if (!ownerName || !property.cad) return;
    try {
      const { matches } = await searchPropertiesByOwner(ownerName);
      const isCurrentProperty = (m: (typeof matches)[number]) =>
        property.accountNumber && m.accountNumber
          ? m.accountNumber === property.accountNumber
          : m.propertyAddress.trim().toLowerCase() === property.address.trim().toLowerCase();
      const additional = matches.filter((m) => m.cad === property.cad && !isCurrentProperty(m));
      if (additional.length === 0) return;
      setValues((prev) =>
        prev["Appraisal District Account Number_3"] ||
        prev["Physical or Situs Address of Property_3"]
          ? prev
          : { ...prev, ...getAdditionalOwnerPropertyFields(additional) },
      );
    } catch (err) {
      console.error("Could not search for other properties under this ownership:", err);
    }
  }

  function handleFieldChange(name: string, value: string | boolean) {
    setValues((prev) => ({ ...prev, [name]: value }));
  }

  async function handleSaveProgress() {
    if (!formType) return;
    setSaving(true);
    try {
      await saveDraft(userId, protest.id, formType, values);
      toast.success("Progress saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save your progress.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDownload() {
    setDownloading(true);
    try {
      const bytes = await buildPdf(templatePath, schema, values);
      const filenameBase = property.accountNumber ?? property.id;
      downloadPdf(
        bytes,
        editingForm === "protest"
          ? `Notice-of-Protest-${filenameBase}.pdf`
          : editingForm === "agent"
            ? `Appointment-of-Agent-${filenameBase}.pdf`
            : `Evidence-Declaration-${filenameBase}.pdf`,
      );
      // Downloading shouldn't be able to lose edits either — save silently
      // alongside it (no separate toast — the real next-step message below
      // covers this action).
      if (formType)
        await saveDraft(userId, protest.id, formType, values).catch((err) => console.error(err));
      toast.success(
        editingForm === "protest"
          ? "Downloaded. Review it, then use Sign & Submit above to file this protest — or deliver this PDF to your county yourself."
          : editingForm === "agent"
            ? "Downloaded. Once signed, deliver this PDF to your appraisal district."
            : "Downloaded. This affidavit isn't valid until signed before a notary public.",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not generate this document.");
    } finally {
      setDownloading(false);
    }
  }

  async function handleConfirmSign() {
    if (!formType || !signature) return;
    setSubmitting(true);
    try {
      // Last-chance correction — catches a date field that was never blurred
      // (e.g. filled by clicking a suggestion chip last) before it's baked
      // into the signed PDF and the saved record.
      const resolvedValues = resolveDateFields(schema, values);
      setValues(resolvedValues);
      const signedAt = new Date();
      const bytes = await signPdf(templatePath, schema, resolvedValues, signature, signedAt);
      const filenameBase = property.accountNumber ?? property.id;
      const fileName =
        editingForm === "protest"
          ? `Signed-Notice-of-Protest-${filenameBase}.pdf`
          : editingForm === "agent"
            ? `Signed-Appointment-of-Agent-${filenameBase}.pdf`
            : `Signed-Evidence-Declaration-${filenameBase}.pdf`;
      const file = new File([bytes as BlobPart], fileName, { type: "application/pdf" });
      const doc = await uploadDocument(
        userId,
        property.id,
        file,
        editingForm === "protest"
          ? "Signed Notice of Protest"
          : editingForm === "agent"
            ? "Signed Appointment of Agent"
            : "Signed Evidence Declaration",
      );
      await signAndSubmit(userId, protest.id, formType, resolvedValues, signature, doc.id);
      // Signing here is NOT the same as filing — this app has no e-filing
      // integration with any county, so it can't truthfully claim the
      // protest has been filed the moment it's signed. Status stays
      // "requested"; the customer confirms filing themselves, once they've
      // actually delivered it, via the "Mark as Filed" action below. For the
      // Evidence Declaration specifically, signing here isn't even a
      // complete signature yet — see the notarization notice in
      // PdfFormEditor.
      if (editingForm === "protest") onNoticeSigned(signedAt.toISOString());
      else if (editingForm === "agent") setAgentFormSignedAt(signedAt.toISOString());
      else setEvidenceDeclarationSignedAt(signedAt.toISOString());
      downloadPdf(bytes, fileName);
      setSigningOpen(false);
      setSignature(null);
      toast.success(
        editingForm === "protest"
          ? 'Signed and saved. This does not file your protest — deliver it to your county (online, by mail, or in person), then click "Mark as Filed" below.'
          : editingForm === "agent"
            ? "Signed and saved. Deliver this PDF to your appraisal district to put it into effect."
            : "Saved. This does not complete your affidavit — Texas law requires it be signed before a notary public.",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not sign this document.");
    } finally {
      setSubmitting(false);
    }
  }

  // Opens the "Have you completed and submitted your property protest?"
  // flow — no longer marks the case filed directly (kept the same name/
  // signature since it's already wired as PdfFormEditor's onMarkFiled prop
  // and the standalone banner's button below). Also closes the form editor
  // modal when called from inside it (PdfFormEditor's own "Mark as Filed"
  // button) — the flow itself renders inline in this section, behind where
  // that modal would otherwise stay open on top of it.
  function handleMarkFiled() {
    setEditingForm(null);
    setProofCheck(null);
    setProofCheckError(null);
    setFilingStep("ask");
  }

  // "Not Yet" — closes the prompt and leaves the case exactly as it was, so
  // the customer lands back on the real filing instructions/guidance above
  // rather than anywhere that implies progress was lost.
  function handleNotYetFiled() {
    setFilingStep("closed");
  }

  function handleConfirmIntentToFile() {
    setFilingStep("proof");
  }

  async function handleUploadProof(files: File[]) {
    setUploadingProof(true);
    try {
      const uploaded: DocumentRecord[] = [];
      for (const file of files) {
        uploaded.push(await uploadDocument(userId, property.id, file, FILING_PROOF_DOCUMENT_TYPE));
      }
      setFilingProofDocs((prev) => [...prev, ...uploaded]);
      // Runs automatically the moment there's something to check — this is
      // meant to be a real step in confirming filing, not an easily-skipped
      // optional extra the customer has to remember to click.
      handleCheckProof([...filingProofDocs, ...uploaded]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not upload this file.");
    } finally {
      setUploadingProof(false);
    }
  }

  // Real AI read of what the uploaded proof actually shows (signature
  // presence, whose name, what date/year) — see verify-filing-proof's own
  // comment. Advisory only: never blocks handleConfirmFiled below, and
  // never runs unless the customer has actually uploaded something real to
  // look at.
  async function handleCheckProof(docs: DocumentRecord[] = filingProofDocs) {
    if (docs.length === 0) return;
    setCheckingProof(true);
    setProofCheckError(null);
    try {
      const result = await verifyFilingProof(property, docs);
      setProofCheck(result);
    } catch (err) {
      setProofCheckError(err instanceof Error ? err.message : "Could not check this proof.");
    } finally {
      setCheckingProof(false);
    }
  }

  // The real, final confirmation — never reachable without at least one
  // real proof-of-filing document on file (see the disabled state on the
  // button below). This app still has no way to independently verify
  // filing (no e-filing integration with any county), so the customer's
  // own explicit Yes plus a real uploaded document is the one honest source
  // of this fact, same discipline as before — just no longer a single,
  // unconfirmed click.
  async function handleConfirmFiled() {
    if (filingProofDocs.length === 0) return;
    setMarkingFiled(true);
    try {
      await markFiled(protest.id);
      onUpdate({ status: "filed" });
      setFilingStep("closed");
      toast.success("Marked as filed.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not mark this case as filed.");
    } finally {
      setMarkingFiled(false);
    }
  }

  // Reads the customer's own uploaded evidence and drafts a suggestion for
  // Form 50-132's "Facts to resolve protest" field — never auto-inserted,
  // never automatic; only ever runs from the explicit "Generate Suggested
  // Reason" click inside PdfFormEditor, and always lands in an editable
  // field the customer must review before signing. See protest-reason.ts.
  async function handleGenerateReason() {
    setGeneratingReason(true);
    try {
      const text = await draftProtestReason(property, strategyRecommendation, evidenceDocuments);
      // The two forms' aiSuggestable field has a different real name — 50-132's
      // "Facts to resolve protest" vs. 50-283's "Sect5-1" (Section 5,
      // Statement of Facts or Arguments — see EVIDENCE_DECLARATION_SCHEMA).
      handleFieldChange(editingForm === "evidence" ? "Sect5-1" : "Facts to resolve protest", text);
      toast.success("Suggested — review and edit before signing.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not generate a suggestion.");
    } finally {
      setGeneratingReason(false);
    }
  }

  const countyInfo = getCountyProtestInfo(property.cad);
  const hasEvidence = evidenceDocuments.length > 0;

  return (
    <div id="case-documents" className="mt-5 border-t border-border pt-5">
      <h4 className="text-sm font-semibold">Documents</h4>
      <p className="text-xs text-muted-foreground">
        Official Texas Comptroller forms, pre-filled from this case. Review or edit every field
        in-app, then download.
      </p>
      {!hasEvidence && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-accent/30 bg-accent/5 p-3 text-sm">
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Tip (optional):</span> Upload whatever
            evidence you already have first — AI can then suggest a stronger strategy and draft the
            "facts to resolve protest" text for you. Not required — you can also fill out and file
            the protest form directly below.
          </p>
          <button
            onClick={goToModule8}
            className="btn-outline shrink-0 whitespace-nowrap text-xs py-1.5"
          >
            Upload Evidence First →
          </button>
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <button onClick={openProtestEditor} className="btn-accent text-xs py-1.5">
          File Protest
        </button>
        <button
          onClick={openAgentEditor}
          disabled={authLoading || !authorization}
          className="btn-outline text-xs py-1.5 disabled:opacity-60"
          title={
            !authLoading && !authorization
              ? "No signed authorization on file for this case yet"
              : undefined
          }
        >
          Complete Agent Representation Form (Optional)
        </button>
        <button onClick={openEvidenceDeclarationEditor} className="btn-outline text-xs py-1.5">
          Complete Evidence Declaration
        </button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Optional.</span> Complete the Agent
        Representation Form only if a tax agent or other authorized representative will represent
        you. Complete the Evidence Declaration (Form 50-283, a sworn affidavit) only if you won't
        appear in person at your ARB hearing — see Section 6 of your Notice of Protest.
      </p>

      {/* Filing itself always happens on the county's own site or mailbox —
          CorvusRF has no e-filing integration with any appraisal district
          (none publish a public submission API), so this can only ever
          prepare the real forms and point you at every real way this county
          actually accepts one, never submit on your behalf. Shown plainly
          here, every type at once, not buried in a collapsed panel or
          collapsed down to a single "the" method. */}
      <div className="mt-3 rounded-md border border-border p-3 text-sm">
        <p className="font-medium">
          How to actually file this — every way {property.cad ?? "your county"} accepts it
        </p>
        {countyInfo ? (
          <>
            <p className="mt-1 text-xs text-muted-foreground">
              {countyInfo.cad} is a separate system — CorvusRF prepares your real forms above, but
              doesn't submit to any of these on your behalf.
            </p>
            <div className="mt-2 text-xs text-muted-foreground">
              <FilingMethodsList countyInfo={countyInfo} />
            </div>
            {countyInfo.filingMethod.online && (
              <a
                href={countyInfo.filingMethod.online.url}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-accent mt-2 inline-flex text-xs py-1.5"
              >
                File Online at {countyInfo.cad} →
              </a>
            )}
          </>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            We don't have this county's confirmed filing methods on file yet — download your signed
            Notice of Protest above and check {property.cad ?? "your appraisal district"}'s website
            directly for the current address or any online option.
          </p>
        )}
      </div>

      {noticeSignedAt && protest.status === "requested" && filingStep === "closed" && (
        <div className="mt-3 rounded-md border border-accent/30 bg-accent/5 p-3 text-sm">
          <p>
            You've signed your Notice of Protest — that only prepares the document. It isn't filed
            with {property.cad ?? "your county"} until you actually deliver it (online, by mail, or
            in person). Once you have, confirm it below.
          </p>
          <button onClick={handleMarkFiled} className="btn-accent mt-2 text-xs py-1.5">
            Have you filed?
          </button>
        </div>
      )}

      {noticeSignedAt && protest.status === "requested" && filingStep !== "closed" && (
        <FilingConfirmationFlow
          step={filingStep}
          countyInfo={countyInfo}
          proofDocs={filingProofDocs}
          uploadingProof={uploadingProof}
          onUploadProof={handleUploadProof}
          proofCheck={proofCheck}
          checkingProof={checkingProof}
          proofCheckError={proofCheckError}
          onRecheck={() => handleCheckProof()}
          markingFiled={markingFiled}
          onNotYet={handleNotYetFiled}
          onConfirmIntent={handleConfirmIntentToFile}
          onConfirmFiled={handleConfirmFiled}
        />
      )}

      {editingForm && (
        <PdfFormEditor
          title={
            editingForm === "protest"
              ? "Notice of Protest (Form 50-132)"
              : editingForm === "agent"
                ? "Appointment of Agent (Form 50-162)"
                : "Property Owner's Affidavit of Evidence (Form 50-283)"
          }
          sections={schema}
          values={values}
          onChange={handleFieldChange}
          onDownload={handleDownload}
          downloading={downloading}
          onSaveProgress={handleSaveProgress}
          saving={saving}
          allowSigning={allowSigning}
          signingOpen={signingOpen}
          onOpenSigning={() => {
            setSignature(null);
            setSigningOpen(true);
          }}
          onCancelSigning={() => {
            setSigningOpen(false);
            setSignature(null);
          }}
          signature={signature}
          onSignatureChange={setSignature}
          onConfirmSign={handleConfirmSign}
          submitting={submitting}
          expectedSignerName={(() => {
            const key =
              editingForm === "protest"
                ? "Print Name of Property Owner or Authorized Representative"
                : editingForm === "agent"
                  ? "Name of Property Owner"
                  : "Affiant Name_2";
            const v = values[key];
            return typeof v === "string" && v ? v : undefined;
          })()}
          onClose={() => setEditingForm(null)}
          formKind={
            editingForm === "protest"
              ? "protest"
              : editingForm === "agent"
                ? "agent"
                : "evidence-declaration"
          }
          countyInfo={countyInfo}
          signedAt={
            editingForm === "protest"
              ? noticeSignedAt
              : editingForm === "agent"
                ? agentFormSignedAt
                : evidenceDeclarationSignedAt
          }
          caseStatus={protest.status}
          onMarkFiled={handleMarkFiled}
          markingFiled={markingFiled}
          hasEvidence={hasEvidence}
          generatingReason={generatingReason}
          onGenerateReason={handleGenerateReason}
        />
      )}
    </div>
  );
}

// Every real, trackable informal-review sub-state, in the same order the
// product spec listed them — the raw options for the status dropdown below.
// Distinct from INFORMAL_STATUS_LABEL (protests.ts), which collapses these
// to the shorter user-facing badge text; this dropdown shows the real,
// specific state the user is actually setting.
const INFORMAL_STATUS_OPTIONS: { value: InformalStatus; label: string }[] = [
  { value: "not_requested", label: "Not Requested" },
  { value: "requested", label: "Requested" },
  { value: "pending_response", label: "Pending County Response" },
  { value: "scheduled", label: "Scheduled" },
  { value: "proposed_value_received", label: "Proposed Value Received" },
  { value: "accepted", label: "Accepted" },
  { value: "rejected", label: "Rejected" },
  { value: "no_informal_available", label: "No Informal Available" },
];

// "14:30" (the value an <input type="time"> yields) → "2:30 PM", the same
// human display string the hearing-notice extraction stores, so the informal
// review's time reads the same everywhere (calendar title included).
function formatInputTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h)) return hhmm;
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m ?? 0).padStart(2, "0")} ${period}`;
}

// The reverse — a stored "2:30 PM" back to "14:30" so it can seed the
// <input type="time"> when the section re-opens. Returns "" for anything
// that doesn't parse.
function parseTimeToInput(display: string | null | undefined): string {
  if (!display) return "";
  const m = display.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!m) return "";
  let h = Number(m[1]);
  const period = m[3]?.toUpperCase();
  if (period === "PM" && h < 12) h += 12;
  if (period === "AM" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

const INFORMAL_REVIEW_MODES: HearingMode[] = [
  "In Person",
  "Phone",
  "Videoconference",
  "Affidavit",
  "Unknown",
];

function InformalReviewSection({
  protest,
  property,
  strategyRecommendation,
  evidenceDocuments,
  onUpdate,
}: {
  protest: ProtestRecord;
  property: PropertyRecord;
  strategyRecommendation: string | null;
  evidenceDocuments: DocumentRecord[];
  onUpdate: (patch: Partial<ProtestRecord>) => void;
}) {
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [dateInput, setDateInput] = useState(protest.informalReviewDate ?? "");
  const [timeInput, setTimeInput] = useState(parseTimeToInput(protest.informalReviewTime));
  const [modeInput, setModeInput] = useState<HearingMode>(
    protest.informalReviewMode ?? "In Person",
  );
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [guidance, setGuidance] = useState<InformalReviewGuidance | null>(null);
  const [loadingGuidance, setLoadingGuidance] = useState(false);
  const [guidanceError, setGuidanceError] = useState<string | null>(null);
  const [notice, setNotice] = useState<HearingNoticeRecord | null>(null);

  // Inline Q&A — stateless, same engine as the site-wide Ask AI widget
  // (ask-about-document). Only the latest question/answer is kept on screen.
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [qaError, setQaError] = useState<string | null>(null);

  const countyInfo = getCountyProtestInfo(property.cad);

  // The latest hearing/county notice already read for this case — grounds the
  // guidance below (see getInformalReviewGuidance's noticeContext arg). Same
  // call HearingNoticeSection and HearingPrepSection already make.
  useEffect(() => {
    getLatestHearingNotice(protest.id)
      .then((n) => {
        setNotice(n);
        // Seed the date only from a notice that's actually about an informal
        // review — never the formal ARB hearing date.
        if (n?.hearingDate && /informal/i.test(n.hearingType ?? "")) {
          setDateInput((prev) => prev || n.hearingDate!);
        }
      })
      .catch((err) => console.error("Could not load hearing notice:", err));
  }, [protest.id]);

  async function handleStatusChange(status: InformalStatus) {
    setUpdatingStatus(true);
    try {
      await updateInformalStatus(protest.id, status);
      onUpdate({ informalStatus: status });
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not update this status."));
    } finally {
      setUpdatingStatus(false);
    }
  }

  async function handleSaveSchedule(e: FormEvent) {
    e.preventDefault();
    if (!dateInput) return;
    setSavingSchedule(true);
    try {
      const displayTime = timeInput ? formatInputTime(timeInput) : null;
      await scheduleInformalReview(protest.id, dateInput, { time: displayTime, mode: modeInput });
      onUpdate({
        informalStatus: "scheduled",
        informalReviewDate: dateInput,
        informalReviewTime: displayTime,
        informalReviewMode: modeInput,
      });
      toast.success("Informal review scheduled — added to your calendar.");
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not save this schedule."));
    } finally {
      setSavingSchedule(false);
    }
  }

  async function handleGetGuidance() {
    setLoadingGuidance(true);
    setGuidanceError(null);
    try {
      const result = await getInformalReviewGuidance(
        property,
        countyInfo,
        strategyRecommendation,
        property.estimatedSavings,
        evidenceDocuments.map((d) => d.fileName),
        notice,
      );
      setGuidance(result);
      // Saved quietly — never its own prominent field, see the schema
      // comment on informal_appraiser_category — just so it's on file the
      // next time this case's guidance is looked at (by staff, say).
      saveInformalAppraiserCategory(protest.id, result.appraiserCategory).catch((err) =>
        console.error("Could not save appraiser category:", err),
      );
    } catch (err) {
      setGuidanceError(getErrorMessage(err, "Could not get guidance. Please try again."));
    } finally {
      setLoadingGuidance(false);
    }
  }

  async function handleAsk(e: FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q || asking) return;
    setAsking(true);
    setQaError(null);
    setAnswer(null);
    try {
      const context = [
        `Property: ${property.address}${property.cad ? `, ${property.cad}` : ""}`,
        property.accountNumber ? `Account: ${property.accountNumber}` : null,
        property.taxYear ? `Tax year: ${property.taxYear}` : null,
        strategyRecommendation ? `Case strategy: ${strategyRecommendation}` : null,
        countyInfo?.informalReview?.howToRequest
          ? `County informal-review process: ${countyInfo.informalReview.howToRequest}`
          : null,
        notice
          ? `Uploaded notice — hearing date ${notice.hearingDate ?? "n/a"}, evidence deadline ${
              notice.evidenceSubmissionDeadline ?? "n/a"
            }, county contact ${notice.countyContact ?? "n/a"}, informal review available: ${
              notice.informalReviewAvailable
            }. Instructions: ${notice.submissionInstructions ?? "none stated"}`
          : "No county notice uploaded for this case yet.",
        guidance
          ? `Guidance already shown to the user — steps: ${guidance.steps.join(
              " | ",
            )}; where to schedule: ${guidance.whereToSchedule || "unknown"}; deadlines: ${
              guidance.applicableDeadlines.join(" | ") || "none"
            }.`
          : null,
      ]
        .filter(Boolean)
        .join("\n");
      const { answer: a } = await askAboutDocument({
        question: `About the informal review for this Texas property tax protest: ${q}`,
        context,
      });
      setAnswer(a);
    } catch (err) {
      setQaError(getErrorMessage(err, "Could not answer that. Please try again."));
    } finally {
      setAsking(false);
    }
  }

  const mailto = guidance ? buildInformalReviewMailto(guidance) : null;
  const scheduled = protest.informalStatus === "scheduled" && !!protest.informalReviewDate;

  return (
    <div id="case-informal-review" className="mt-5 border-t border-border pt-5">
      <h4 className="text-sm font-semibold">Informal Review</h4>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="badge-soft">{INFORMAL_STATUS_LABEL[protest.informalStatus]}</span>
        <select
          value={protest.informalStatus}
          disabled={updatingStatus}
          onChange={(e) => handleStatusChange(e.target.value as InformalStatus)}
          className="rounded-md border border-input bg-background px-2 py-1 text-xs disabled:opacity-60"
        >
          {INFORMAL_STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {/* Schedule — always available, not gated behind the status dropdown.
          Saving it sets the status to "scheduled" and feeds the in-platform
          calendar + Google/ICS sync (see scheduleInformalReview). */}
      <form onSubmit={handleSaveSchedule} className="mt-3 rounded-md border border-border p-3">
        <div className="text-xs font-semibold text-foreground">Schedule the informal review</div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Enter the date, time, and mode you arranged with the appraisal district — it goes straight
          onto your calendar.
        </p>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-xs">
            Date
            <input
              type="date"
              value={dateInput}
              onChange={(e) => setDateInput(e.target.value)}
              className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            />
          </label>
          <label className="grid gap-1 text-xs">
            Time
            <input
              type="time"
              value={timeInput}
              onChange={(e) => setTimeInput(e.target.value)}
              className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            />
          </label>
          <label className="grid gap-1 text-xs">
            Mode
            <select
              value={modeInput}
              onChange={(e) => setModeInput(e.target.value as HearingMode)}
              className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            >
              {INFORMAL_REVIEW_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={savingSchedule || !dateInput}
            className="btn-accent text-xs py-1.5 disabled:opacity-60"
          >
            {savingSchedule ? "Saving…" : "Save & add to calendar"}
          </button>
        </div>
        {scheduled && (
          <p className="mt-2 text-xs text-muted-foreground">
            On file: {protest.informalReviewDate}
            {protest.informalReviewTime ? ` at ${protest.informalReviewTime}` : ""}
            {protest.informalReviewMode ? ` · ${protest.informalReviewMode}` : ""} ·{" "}
            <Link to="/dashboard/calendar" className="text-accent hover:underline">
              View on calendar
            </Link>
          </p>
        )}
      </form>

      <div className="mt-3">
        <button
          type="button"
          onClick={handleGetGuidance}
          disabled={loadingGuidance}
          className="btn-outline text-xs py-1.5 disabled:opacity-60"
        >
          {loadingGuidance
            ? "Reading your case…"
            : guidance
              ? "Refresh Guidance"
              : "Get Informal Review Guidance"}
        </button>
        {guidanceError && <p className="mt-1 text-xs text-destructive">{guidanceError}</p>}
      </div>

      {guidance && (
        <div className="mt-3 grid gap-3 rounded-md border border-border p-3 text-sm">
          <div>
            <span className="font-semibold">Available: </span>
            <span className="text-muted-foreground">{guidance.available}</span>
          </div>

          {guidance.steps.length > 0 && (
            <div className="text-xs">
              <div className="font-semibold text-foreground">
                Steps to schedule &amp; complete it
              </div>
              <ol className="mt-1 grid list-decimal gap-1 pl-4 text-muted-foreground">
                {guidance.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </div>
          )}

          <div className="grid gap-2 sm:grid-cols-2 text-xs">
            <div>
              <div className="font-semibold text-foreground">Where to Schedule</div>
              <MarkdownLite
                className="text-muted-foreground"
                text={guidance.whereToSchedule || "Not stated."}
              />
            </div>
            <div>
              <div className="font-semibold text-foreground">Who to Contact</div>
              <MarkdownLite
                className="text-muted-foreground"
                text={guidance.whoToContact || "Not confirmed."}
              />
            </div>
            <div>
              <div className="font-semibold text-foreground">How to Request It</div>
              <MarkdownLite
                className="text-muted-foreground"
                text={guidance.howToRequest || "Not confirmed."}
              />
            </div>
            <div>
              <div className="font-semibold text-foreground">What Value to Request</div>
              <MarkdownLite
                className="text-muted-foreground"
                text={guidance.requestedValueGuidance}
              />
            </div>
            <div>
              <div className="font-semibold text-foreground">Responding to a Proposed Value</div>
              <MarkdownLite
                className="text-muted-foreground"
                text={guidance.respondingToProposedValue}
              />
            </div>
            <div>
              <div className="font-semibold text-foreground">What to Say</div>
              <MarkdownLite className="text-muted-foreground" text={guidance.whatToSay} />
            </div>
            <div>
              <div className="font-semibold text-foreground">What Not to Say</div>
              <MarkdownLite className="text-muted-foreground" text={guidance.whatNotToSay} />
            </div>
            <div className="sm:col-span-2">
              <div className="font-semibold text-foreground">Does Accepting End the Case?</div>
              <MarkdownLite className="text-muted-foreground" text={guidance.acceptingEndsCase} />
            </div>
          </div>

          {guidance.applicableDeadlines.length > 0 && (
            <div className="text-xs">
              <div className="font-semibold text-foreground">Applicable Deadlines</div>
              <ul className="mt-0.5 grid gap-0.5 text-muted-foreground">
                {guidance.applicableDeadlines.map((d, i) => (
                  <li key={i}>• {d}</li>
                ))}
              </ul>
            </div>
          )}
          {guidance.documentsToProvide.length > 0 && (
            <div className="text-xs">
              <div className="font-semibold text-foreground">Documents to Provide</div>
              <ul className="mt-0.5 grid gap-0.5 text-muted-foreground">
                {guidance.documentsToProvide.map((d, i) => (
                  <li key={i}>• {d}</li>
                ))}
              </ul>
            </div>
          )}
          {guidance.evidenceToUse.length > 0 && (
            <div className="text-xs">
              <div className="font-semibold text-foreground">Evidence to Use</div>
              <ul className="mt-0.5 grid gap-0.5 text-muted-foreground">
                {guidance.evidenceToUse.map((d, i) => (
                  <li key={i}>• {d}</li>
                ))}
              </ul>
            </div>
          )}

          {(guidance.missingInfo.length > 0 || guidance.nextSteps.length > 0) && (
            <div className="rounded-md bg-accent/5 border border-accent/30 p-2 text-xs">
              {guidance.missingInfo.length > 0 && (
                <>
                  <div className="font-semibold text-foreground">
                    Missing from your notice — do this to fill the gap
                  </div>
                  <ul className="mt-0.5 grid gap-0.5 text-muted-foreground">
                    {guidance.missingInfo.map((d, i) => (
                      <li key={i}>• {d}</li>
                    ))}
                  </ul>
                </>
              )}
              {guidance.nextSteps.length > 0 && (
                <div className={guidance.missingInfo.length > 0 ? "mt-2" : ""}>
                  <div className="font-semibold text-foreground">Next steps</div>
                  <ol className="mt-0.5 grid list-decimal gap-0.5 pl-4 text-muted-foreground">
                    {guidance.nextSteps.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          )}

          {mailto ? (
            <div>
              <a href={mailto} className="btn-accent text-xs py-1.5 inline-flex">
                Draft Email to {guidance.contactEmail}
              </a>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Opens your email app with a suggested request pre-filled — review and edit before
                sending.
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              No confirmed email contact on file for this county — use the phone/contact info above,
              or check {property.cad ?? "your appraisal district"}'s website directly.
            </p>
          )}
        </div>
      )}

      {/* Ask the AI a follow-up about the informal review / preparation. */}
      <form onSubmit={handleAsk} className="mt-3">
        <div className="text-xs font-semibold text-foreground">Ask about the informal review</div>
        <div className="mt-1 flex flex-wrap items-end gap-2">
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={2}
            aria-label="Ask about the informal review"
            placeholder="e.g. Can I bring new comps to the informal that weren't in my protest?"
            className="min-w-[16rem] flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
          <button
            type="submit"
            disabled={asking || !question.trim()}
            className="btn-outline text-xs py-1.5 disabled:opacity-60"
          >
            {asking ? "Asking…" : "Ask"}
          </button>
        </div>
        {qaError && <p className="mt-1 text-xs text-destructive">{qaError}</p>}
        {answer && (
          <div className="mt-2 rounded-md border border-border bg-secondary/30 p-2 text-xs">
            <MarkdownLite text={answer} />
          </div>
        )}
      </form>
    </div>
  );
}

// "Once the protest has been filed" — real AI extraction from the actual
// hearing notice (or other county notice) the user uploads, cross-checked
// against the case's own known facts (see extract-hearing-notice's own
// deterministic discrepancy check), and — once a real hearing date is on
// it — fed straight into scheduleHearing() so it shows up wherever this
// app's calendar sync already reads hearing_date/time/location from (the
// webcal feed and the real Google Calendar sync both pick it up on their
// own next pass, no separate calendar code needed here).
const HEARING_NOTICE_DOCUMENT_TYPE = "Hearing Notice";

function HearingNoticeSection({
  userId,
  protest,
  property,
  onUpdate,
}: {
  userId: string;
  protest: ProtestRecord;
  property: PropertyRecord;
  onUpdate: (patch: Partial<ProtestRecord>) => void;
}) {
  const [notice, setNotice] = useState<HearingNoticeRecord | null>(null);
  const [loadingNotice, setLoadingNotice] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [pending, setPending] = useState<HearingNoticeExtraction | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getLatestHearingNotice(protest.id)
      .then(setNotice)
      .catch((err) => console.error("Could not load hearing notice:", err))
      .finally(() => setLoadingNotice(false));
  }, [protest.id]);

  const countyInfo = getCountyProtestInfo(property.cad);

  async function handleUpload(file: File) {
    setUploading(true);
    setUploadError(null);
    try {
      const extraction = await extractHearingNotice(property, file, countyInfo);
      setPending(extraction);
      setPendingFile(file);
    } catch (err) {
      setUploadError(getErrorMessage(err, "Could not read this notice. Please try again."));
    } finally {
      setUploading(false);
    }
  }

  async function handleConfirm() {
    if (!pending) return;
    setSaving(true);
    try {
      let documentId: string | null = null;
      if (pendingFile) {
        const doc = await uploadDocument(
          userId,
          property.id,
          pendingFile,
          HEARING_NOTICE_DOCUMENT_TYPE,
        );
        documentId = doc.id;
      }
      const saved = await saveHearingNotice(userId, protest.id, documentId, pending);
      setNotice(saved);
      setPending(null);
      setPendingFile(null);
      // Only advances the case (and, by extension, the calendar) when the
      // notice actually stated a real hearing date — a notice that's
      // something else entirely (an exemption denial, a value notice)
      // still saves for its own record, but doesn't invent a hearing.
      if (pending.hearingDate) {
        await scheduleHearing(protest.id, pending.hearingDate, {
          time: pending.hearingTime,
          location: pending.hearingLocation,
          mode: pending.hearingMode,
        });
        onUpdate({
          hearingDate: pending.hearingDate,
          hearingTime: pending.hearingTime,
          hearingLocation: pending.hearingLocation,
          hearingMode: pending.hearingMode,
          status: "hearing_scheduled",
        });
      }
      toast.success("Hearing notice saved.");
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not save this notice."));
    } finally {
      setSaving(false);
    }
  }

  function handleDiscard() {
    setPending(null);
    setPendingFile(null);
    setUploadError(null);
  }

  if (loadingNotice) return null;

  const uploadLabel = notice ? "Upload an Updated Notice" : "Upload Hearing Notice";
  const uploadButton = (
    <label
      className={`inline-flex ${notice ? "btn-outline" : "btn-accent"} cursor-pointer text-xs py-1.5 ${uploading ? "pointer-events-none opacity-60" : ""}`}
    >
      {uploading ? "Reading your notice…" : uploadLabel}
      <input
        type="file"
        accept="image/*,.pdf"
        className="hidden"
        disabled={uploading}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) handleUpload(file);
        }}
      />
    </label>
  );

  return (
    <div id="case-hearing-notice" className="mt-5 border-t border-border pt-5">
      <h4 className="text-sm font-semibold">Hearing Notice</h4>

      {!notice && !pending && (
        <div className="mt-2 rounded-md border border-accent/30 bg-accent/5 p-3 text-sm">
          <p className="font-medium">Next Step</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Upload the hearing notice or other notice received from the county. AI will read it,
            check it against your case, and — if it states a real hearing date — get it onto your
            calendar.
          </p>
          <div className="mt-2">{uploadButton}</div>
          {uploadError && <p className="mt-2 text-xs text-destructive">{uploadError}</p>}
        </div>
      )}

      {!pending && notice && (
        <div className="mt-2 rounded-md border border-border p-3 text-sm">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="grid gap-2 sm:grid-cols-2 text-xs">
              <Field label="Hearing Date" value={notice.hearingDate ?? "Not stated"} />
              <Field label="Hearing Time" value={notice.hearingTime ?? "Not stated"} />
              <Field label="Hearing Location" value={notice.hearingLocation ?? "Not stated"} />
              <Field label="Hearing Mode" value={notice.hearingMode} />
              <Field
                label="Evidence Submission Deadline"
                value={notice.evidenceSubmissionDeadline ?? "Not stated"}
              />
              <Field
                label="Appeal/Escalation Deadline"
                value={notice.appealDeadline ?? "Not stated"}
              />
              <Field label="County Contact" value={notice.countyContact ?? "Not stated"} />
              <Field label="Appraiser/Contact" value={notice.appraiserContact ?? "Not stated"} />
            </div>
            {uploadButton}
          </div>
          {notice.discrepancies.length > 0 && (
            <div className="mt-3 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
              <span className="font-semibold">Discrepancies flagged:</span>
              <ul className="mt-1 grid gap-0.5">
                {notice.discrepancies.map((d, i) => (
                  <li key={i}>• {d}</li>
                ))}
              </ul>
            </div>
          )}
          {notice.submissionInstructions && (
            <div className="mt-3 text-xs">
              <div className="font-semibold text-foreground">Submission Instructions</div>
              <p className="text-muted-foreground">{notice.submissionInstructions}</p>
            </div>
          )}
          {notice.requiredDocuments.length > 0 && (
            <div className="mt-2 text-xs">
              <div className="font-semibold text-foreground">Required Documents</div>
              <ul className="mt-0.5 grid gap-0.5 text-muted-foreground">
                {notice.requiredDocuments.map((d, i) => (
                  <li key={i}>• {d}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-3 rounded-md bg-secondary/40 p-2 text-xs">
            <div className="font-semibold">Informal Review: {notice.informalReviewAvailable}</div>
            <p className="mt-0.5 text-muted-foreground">{notice.proceduralDifferences}</p>
          </div>
          {uploadError && <p className="mt-2 text-xs text-destructive">{uploadError}</p>}
        </div>
      )}

      {pending && (
        <div className="mt-2 rounded-md border border-accent/40 bg-accent/5 p-3 text-sm">
          <p className="font-medium">Review before saving</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Confirm this looks right — discard and re-upload if the wrong file was read.
          </p>
          {pending.discrepancies.length > 0 && (
            <div className="mt-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
              <span className="font-semibold">Discrepancies found:</span>
              <ul className="mt-1 grid gap-0.5">
                {pending.discrepancies.map((d, i) => (
                  <li key={i}>• {d}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-3 grid gap-2 sm:grid-cols-2 text-xs">
            <Field label="Hearing Date" value={pending.hearingDate ?? "Not stated"} />
            <Field label="Hearing Time" value={pending.hearingTime ?? "Not stated"} />
            <Field label="Hearing Location" value={pending.hearingLocation ?? "Not stated"} />
            <Field label="Hearing Mode" value={pending.hearingMode} />
            <Field label="Hearing Type" value={pending.hearingType ?? "Not stated"} />
            <Field
              label="Evidence Submission Deadline"
              value={pending.evidenceSubmissionDeadline ?? "Not stated"}
            />
            <Field
              label="Appeal/Escalation Deadline"
              value={pending.appealDeadline ?? "Not stated"}
            />
            <Field
              label="Account Number (on notice)"
              value={pending.accountNumber ?? "Not stated"}
            />
            <Field label="Tax Year (on notice)" value={pending.taxYear ?? "Not stated"} />
            <Field
              label="Property Address (on notice)"
              value={pending.propertyAddress ?? "Not stated"}
            />
            <Field label="County Contact" value={pending.countyContact ?? "Not stated"} />
            <Field label="Appraiser/Contact" value={pending.appraiserContact ?? "Not stated"} />
          </div>
          {pending.submissionInstructions && (
            <div className="mt-2 text-xs">
              <div className="font-semibold text-foreground">Submission Instructions</div>
              <p className="text-muted-foreground">{pending.submissionInstructions}</p>
            </div>
          )}
          {pending.requiredDocuments.length > 0 && (
            <div className="mt-2 text-xs">
              <div className="font-semibold text-foreground">Required Documents</div>
              <ul className="mt-0.5 grid gap-0.5 text-muted-foreground">
                {pending.requiredDocuments.map((d, i) => (
                  <li key={i}>• {d}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-3 rounded-md bg-secondary/40 p-2 text-xs">
            <div className="font-semibold">Informal Review: {pending.informalReviewAvailable}</div>
            <p className="mt-0.5 text-muted-foreground">{pending.proceduralDifferences}</p>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              onClick={handleConfirm}
              disabled={saving}
              className="btn-accent text-xs py-1.5 disabled:opacity-60"
            >
              {saving ? "Saving…" : "Confirm & Save"}
            </button>
            <button
              onClick={handleDiscard}
              disabled={saving}
              className="btn-outline text-xs py-1.5"
            >
              Discard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function GuideText({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  if (!value) return null;
  return (
    <div className="mt-2">
      <div className="text-xs font-semibold text-foreground">{label}</div>
      <MarkdownLite
        text={value}
        className={`mt-0.5 text-muted-foreground ${bold ? "font-medium text-foreground" : ""}`}
      />
    </div>
  );
}

function GuideList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-2">
      <div className="text-xs font-semibold text-foreground">{label}</div>
      <ul className="mt-0.5 grid gap-0.5 text-muted-foreground">
        {items.map((item, i) => (
          <li key={i}>• {item}</li>
        ))}
      </ul>
    </div>
  );
}

const HEARING_STATUS_STYLE: Record<HearingUserStatus, string> = {
  "Hearing Scheduled": "bg-secondary text-foreground",
  "No Action Needed": "bg-secondary text-muted-foreground",
  "Upload Documents": "bg-amber-500/15 text-amber-700",
  "Attend Hearing": "bg-accent/15 text-accent",
};

const ATTENDANCE_TYPES: AttendanceType[] = ["Property Owner", "Authorized Agent", "Both"];

// The real, step-by-step ARB hearing prep guide — see hearing-prep.ts /
// hearing-prep-guide/index.ts for how it's grounded. Only shown once a
// hearing is actually scheduled; before that there's nothing real yet to
// prepare for.
function HearingPrepSection({
  protest,
  property,
  caseData,
  evidenceDocuments,
  settlementAgreement,
  onUpdate,
}: {
  protest: ProtestRecord;
  property: PropertyRecord;
  caseData: ProtestCase | null;
  evidenceDocuments: DocumentRecord[];
  settlementAgreement: SettlementAgreementRecord | null;
  onUpdate: (patch: Partial<ProtestRecord>) => void;
}) {
  const [notice, setNotice] = useState<HearingNoticeRecord | null>(null);
  const [loadingNotice, setLoadingNotice] = useState(true);
  const [guide, setGuide] = useState<HearingPrepGuide | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [savingAttendance, setSavingAttendance] = useState(false);

  useEffect(() => {
    getLatestHearingNotice(protest.id)
      .then(setNotice)
      .catch((err) => console.error("Could not load hearing notice for prep guide:", err))
      .finally(() => setLoadingNotice(false));
  }, [protest.id]);

  const countyInfo = getCountyProtestInfo(property.cad);
  const hearingStatus = getHearingUserStatus(protest, !!notice, evidenceDocuments.length);

  async function handleGenerate() {
    setGenerating(true);
    setGenError(null);
    try {
      const result = await getHearingPrepGuide(
        property,
        protest,
        caseData?.strategyRecommendation ?? null,
        caseData?.strategyRationale ?? null,
        countyInfo,
        notice,
        evidenceDocuments.map((d) => d.fileName),
        null,
      );
      setGuide(result);
    } catch (err) {
      setGenError(
        getErrorMessage(err, "Could not generate your hearing prep guide. Please try again."),
      );
    } finally {
      setGenerating(false);
    }
  }

  async function handleAttendanceChange(value: AttendanceType) {
    setSavingAttendance(true);
    try {
      await saveAttendanceType(protest.id, value);
      onUpdate({ attendanceType: value });
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not save who's attending."));
    } finally {
      setSavingAttendance(false);
    }
  }

  if (protest.status !== "hearing_scheduled" || loadingNotice) return null;

  return (
    <div id="case-hearing-prep" className="mt-5 border-t border-border pt-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">Hearing Preparation</h4>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${HEARING_STATUS_STYLE[hearingStatus]}`}
        >
          {hearingStatus}
        </span>
      </div>

      <InformalOutcomeBanner protest={protest} agreement={settlementAgreement} inline />

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Who&apos;s attending:</span>
        {ATTENDANCE_TYPES.map((opt) => (
          <button
            key={opt}
            onClick={() => handleAttendanceChange(opt)}
            disabled={savingAttendance}
            className={`rounded-full border px-2 py-1 ${
              protest.attendanceType === opt
                ? "border-accent bg-accent/10 text-accent"
                : "border-border text-muted-foreground"
            }`}
          >
            {opt}
          </button>
        ))}
      </div>

      {!guide && (
        <div className="mt-3">
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="btn-accent text-xs py-1.5 disabled:opacity-60"
          >
            {generating ? "Preparing your guide…" : "Generate Hearing Prep Guide"}
          </button>
          {genError && <p className="mt-2 text-xs text-destructive">{genError}</p>}
        </div>
      )}

      {guide && (
        <div className="mt-3 grid gap-4 text-sm">
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="btn-outline w-fit text-xs py-1.5 disabled:opacity-60"
          >
            {generating ? "Regenerating…" : "Regenerate Guide"}
          </button>

          <div>
            <div className="font-semibold">Hearing Summary</div>
            <MarkdownLite className="mt-1 text-muted-foreground" text={guide.hearingSummary} />
          </div>

          {guide.evidencePacketNote && (
            <div className="rounded-md bg-secondary/40 p-2 text-xs">
              <div className="font-semibold">Evidence Packet</div>
              <MarkdownLite className="mt-0.5" text={guide.evidencePacketNote} />
            </div>
          )}

          <div className="rounded-md border border-border p-3">
            <div className="font-semibold text-accent">Step 1 — Before the Hearing</div>
            <GuideList label="What to review" items={guide.beforeHearing.whatToReview} />
            <GuideList
              label="Documents to have ready"
              items={guide.beforeHearing.documentsToHaveReady}
            />
            <GuideText label="Value to request" value={guide.beforeHearing.valueToRequest} />
            <GuideList label="Key evidence" items={guide.beforeHearing.keyEvidence} />
            <GuideText
              label="How to organize your evidence"
              value={guide.beforeHearing.howToOrganize}
            />
            <GuideText label="Preparing for questions" value={guide.beforeHearing.questionPrep} />
          </div>

          <div className="rounded-md border border-border p-3">
            <div className="font-semibold text-accent">Step 2 — During the Hearing</div>
            <GuideText label="Opening statement" value={guide.duringHearing.openingStatement} />
            <GuideText
              label="Property/value explanation"
              value={guide.duringHearing.valueExplanation}
            />
            <GuideText
              label="Presenting comparable evidence"
              value={guide.duringHearing.comparableEvidencePresentation}
            />
            <GuideText
              label="Condition/obsolescence arguments"
              value={guide.duringHearing.conditionArguments}
            />
            <GuideText label="Requested value" value={guide.duringHearing.requestedValue} bold />
            <GuideText label="Closing statement" value={guide.duringHearing.closingStatement} />
          </div>

          <GuideList label="Property-specific arguments" items={guide.propertySpecificArguments} />
          <GuideList label="Questions to ask" items={guide.questionsToAsk} />
          <GuideList label="Questions the ARB/appraiser may ask" items={guide.questionsArbMayAsk} />
          <GuideList label="Weaknesses & risk notes" items={guide.weaknessesAndRisks} />
          <GuideList label="Documents to have available" items={guide.documentsToHave} />
          <GuideText label="Submission instructions" value={guide.submissionInstructions} />
          <GuideText label="County contact" value={guide.countyContact} />
          <GuideText label="Hearing logistics" value={guide.hearingLogistics} />

          <p className="text-xs italic text-muted-foreground">{guide.disclaimer}</p>
        </div>
      )}
    </div>
  );
}

// After the hearing: upload the ARB Order / hearing decision / settlement /
// revised value notice / other final determination, AI extracts the real
// facts, and confirming applies them to the case via the SAME
// recordArbDecision() CaseProgress's own manual form already uses — this is
// an AI-assisted entry path into that one real mechanism, not a second one.
// decisionType (approved/partial/denied) is deliberately computed HERE from
// the real original/final values, never trusted from the model's own read
// of the document, same discipline as every other derived fact in this app.
function DecisionNoticeSection({
  userId,
  protest,
  property,
  onUpdate,
}: {
  userId: string;
  protest: ProtestRecord;
  property: PropertyRecord;
  onUpdate: (patch: Partial<ProtestRecord>) => void;
}) {
  const [notice, setNotice] = useState<DecisionNoticeRecord | null>(null);
  const [loadingNotice, setLoadingNotice] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [pending, setPending] = useState<DecisionExtraction | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getLatestDecisionNotice(protest.id)
      .then(setNotice)
      .catch((err) => console.error("Could not load decision notice:", err))
      .finally(() => setLoadingNotice(false));
  }, [protest.id]);

  async function handleUpload(file: File) {
    setUploading(true);
    setUploadError(null);
    try {
      const extraction = await extractDecisionDocument(property, protest, file);
      setPending(extraction);
      setPendingFile(file);
    } catch (err) {
      setUploadError(getErrorMessage(err, "Could not read this document. Please try again."));
    } finally {
      setUploading(false);
    }
  }

  async function handleConfirm() {
    if (!pending) return;
    setSaving(true);
    try {
      let documentId: string | null = null;
      if (pendingFile) {
        const doc = await uploadDocument(userId, property.id, pendingFile, DECISION_DOCUMENT_TYPE);
        documentId = doc.id;
      }
      const saved = await saveDecisionNotice(userId, protest.id, documentId, pending);
      setNotice(saved);
      setPending(null);
      setPendingFile(null);

      if (pending.finalValue != null) {
        const decisionType: "partial" | "denied" =
          pending.originalValue != null && pending.finalValue < pending.originalValue
            ? "partial"
            : "denied";
        const decisionDate = pending.decisionDate ?? new Date().toISOString().slice(0, 10);
        await recordArbDecision(protest.id, {
          type: decisionType,
          date: decisionDate,
          finalValue: pending.finalValue,
        });
        onUpdate({
          arbDecision: decisionType,
          arbDecisionDate: decisionDate,
          finalValue: pending.finalValue,
          status: "decision_received",
        });
      }
      toast.success("Decision document saved.");
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not save this document."));
    } finally {
      setSaving(false);
    }
  }

  function handleDiscard() {
    setPending(null);
    setPendingFile(null);
    setUploadError(null);
  }

  if (loadingNotice) return null;
  if (
    protest.status !== "hearing_scheduled" &&
    protest.status !== "decision_received" &&
    protest.status !== "resolved"
  )
    return null;

  const uploadLabel = notice ? "Upload an Updated Decision Document" : "Upload Decision Document";
  const uploadButton = (
    <label
      className={`inline-flex ${notice ? "btn-outline" : "btn-accent"} cursor-pointer text-xs py-1.5 ${uploading ? "pointer-events-none opacity-60" : ""}`}
    >
      {uploading ? "Reading your document…" : uploadLabel}
      <input
        type="file"
        accept="image/*,.pdf"
        className="hidden"
        disabled={uploading}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) handleUpload(file);
        }}
      />
    </label>
  );

  const reduction =
    protest.originalValue != null && protest.finalValue != null
      ? protest.originalValue - protest.finalValue
      : null;
  const savings =
    reduction != null && reduction > 0 ? reduction * getEffectiveTaxRate(property.cad) : null;

  return (
    <div id="case-decision-notice" className="mt-5 border-t border-border pt-5">
      <h4 className="text-sm font-semibold">Hearing Decision</h4>
      <p className="mt-1 text-xs text-muted-foreground">
        After your hearing, upload the ARB Order, hearing decision, settlement, revised value
        notice, or other final determination you receive.
      </p>

      {!notice && !pending && (
        <div className="mt-2">
          {uploadButton}
          {uploadError && <p className="mt-2 text-xs text-destructive">{uploadError}</p>}
        </div>
      )}

      {!pending && notice && (
        <div className="mt-2 rounded-md border border-border p-3 text-sm">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="grid gap-2 sm:grid-cols-2 text-xs">
              <Field label="Document Type" value={notice.documentCategory} />
              <Field label="Decision Date" value={notice.decisionDate ?? "Not stated"} />
              <Field
                label="Original Value"
                value={notice.originalValue != null ? currency(notice.originalValue) : "Not stated"}
              />
              <Field
                label="Final Value"
                value={notice.finalValue != null ? currency(notice.finalValue) : "Not stated"}
              />
              <Field label="Appeal Deadline" value={notice.appealDeadline ?? "Not stated"} />
              <Field label="Refund" value={notice.refundIndicator ?? "Not stated"} />
            </div>
            {uploadButton}
          </div>
          {notice.discrepancies.length > 0 && (
            <div className="mt-3 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
              <span className="font-semibold">Discrepancies flagged:</span>
              <ul className="mt-1 grid gap-0.5">
                {notice.discrepancies.map((d, i) => (
                  <li key={i}>• {d}</li>
                ))}
              </ul>
            </div>
          )}
          {notice.settlementTerms && (
            <div className="mt-3 text-xs">
              <div className="font-semibold text-foreground">Terms</div>
              <p className="text-muted-foreground">{notice.settlementTerms}</p>
            </div>
          )}
          {notice.otherConditions && (
            <div className="mt-2 text-xs">
              <div className="font-semibold text-foreground">Other Conditions</div>
              <p className="text-muted-foreground">{notice.otherConditions}</p>
            </div>
          )}
        </div>
      )}

      {pending && (
        <div className="mt-2 rounded-md border border-accent/40 bg-accent/5 p-3 text-sm">
          <p className="font-medium">Review before saving</p>
          {pending.discrepancies.length > 0 && (
            <div className="mt-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
              <span className="font-semibold">Discrepancies found:</span>
              <ul className="mt-1 grid gap-0.5">
                {pending.discrepancies.map((d, i) => (
                  <li key={i}>• {d}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-3 grid gap-2 sm:grid-cols-2 text-xs">
            <Field label="Document Type" value={pending.documentCategory} />
            <Field label="Decision Date" value={pending.decisionDate ?? "Not stated"} />
            <Field
              label="Original Value"
              value={pending.originalValue != null ? currency(pending.originalValue) : "Not stated"}
            />
            <Field
              label="Final Value"
              value={pending.finalValue != null ? currency(pending.finalValue) : "Not stated"}
            />
            <Field label="Tax Year (on document)" value={pending.taxYear ?? "Not stated"} />
            <Field
              label="Account Number (on document)"
              value={pending.accountNumber ?? "Not stated"}
            />
            <Field label="Appeal Deadline" value={pending.appealDeadline ?? "Not stated"} />
            <Field label="Refund" value={pending.refundIndicator ?? "Not stated"} />
          </div>
          {pending.settlementTerms && (
            <div className="mt-2 text-xs">
              <div className="font-semibold text-foreground">Terms</div>
              <p className="text-muted-foreground">{pending.settlementTerms}</p>
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <button
              onClick={handleConfirm}
              disabled={saving}
              className="btn-accent text-xs py-1.5 disabled:opacity-60"
            >
              {saving ? "Saving…" : "Confirm & Save"}
            </button>
            <button
              onClick={handleDiscard}
              disabled={saving}
              className="btn-outline text-xs py-1.5"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {protest.arbDecision && protest.finalValue != null && (
        <div className="mt-3 grid gap-2 rounded-md bg-secondary/40 p-3 text-xs sm:grid-cols-2">
          <Field label="Decision Received" value={protest.arbDecisionDate ?? "Yes"} success />
          <Field
            label="Original Value"
            value={protest.originalValue != null ? currency(protest.originalValue) : "Not on file"}
          />
          <Field label="Final Value" value={currency(protest.finalValue)} bold />
          <Field
            label="Value Reduction"
            value={reduction != null ? currency(reduction) : "N/A"}
            success={reduction != null && reduction > 0}
          />
          <Field
            label="Estimated Tax Savings"
            value={savings != null ? `${currency(savings)}/yr` : "N/A"}
            success={savings != null}
          />
        </div>
      )}
    </div>
  );
}

// Amber, non-blocking notice at the top of the case (and inline in
// HearingPrepSection) whenever the county's informal proposed value is on
// the table but the owner hasn't recorded what came of it. Product asked
// for a warning, not a hard gate — the case still works, this just keeps
// the history honest.
function InformalOutcomeBanner({
  protest,
  agreement,
  inline = false,
}: {
  protest: ProtestRecord;
  agreement: SettlementAgreementRecord | null;
  inline?: boolean;
}) {
  const unresolved =
    protest.status !== "resolved" &&
    (protest.informalStatus === "proposed_value_received" ||
      (!!agreement && !agreement.outcomeConfirmedAt));
  if (!unresolved) return null;
  return (
    <div
      className={`${inline ? "mt-3" : "mt-4"} rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs`}
    >
      <div className="font-semibold text-amber-700">Informal outcome not confirmed yet</div>
      <p className="mt-1 text-muted-foreground">
        The county&apos;s informal proposed value hasn&apos;t been resolved. Record whether you
        accepted or rejected it, and whether you&apos;re satisfied, before working the formal
        hearing — otherwise the case history and savings won&apos;t be right.
      </p>
      <button
        type="button"
        onClick={() =>
          document
            .getElementById("case-settlement-signature")
            ?.scrollIntoView({ behavior: "smooth", block: "start" })
        }
        className="btn-outline mt-2 text-xs py-1"
      >
        Go to the settlement section
      </button>
    </div>
  );
}

// The county's proposed value / settlement offer, end to end: AI reads the
// real settled value/terms off the uploaded document, the owner says
// whether they've already accepted/rejected it, otherwise they confirm it
// looks right and sign here (or upload the copy they signed in person for
// AI to verify), and finally they confirm Satisfied / Not Satisfied — which
// resolves the case at the settled value or unlocks formal-hearing prep.
// See settlement-agreement.ts for the read/verify/sign/outcome mechanics.
function SettlementSignatureSection({
  userId,
  protest,
  property,
  agreement,
  onAgreementChange,
  onUpdate,
}: {
  userId: string;
  protest: ProtestRecord;
  property: PropertyRecord;
  agreement: SettlementAgreementRecord | null;
  onAgreementChange: (a: SettlementAgreementRecord | null) => void;
  onUpdate: (patch: Partial<ProtestRecord>) => void;
}) {
  const [originalDoc, setOriginalDoc] = useState<DocumentRecord | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [pending, setPending] = useState<DecisionExtraction | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [signature, setSignature] = useState<SignatureValue | null>(null);
  const [signerName, setSignerName] = useState("");
  const [signing, setSigning] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [recordingResponse, setRecordingResponse] = useState(false);
  const [verifyingCopy, setVerifyingCopy] = useState(false);
  const [signedCopyExtraction, setSignedCopyExtraction] = useState<DecisionExtraction | null>(null);
  const [confirmingOutcome, setConfirmingOutcome] = useState(false);

  useEffect(() => {
    if (agreement?.documentId) {
      getDocumentById(userId, agreement.documentId)
        .then(setOriginalDoc)
        .catch(() => {});
    }
  }, [agreement?.documentId, userId]);

  async function handleUpload(file: File) {
    setUploading(true);
    setUploadError(null);
    try {
      const extraction = await extractSettlementDocument(property, protest, file);
      setPending(extraction);
      setPendingFile(file);
    } catch (err) {
      setUploadError(getErrorMessage(err, "Could not read this document. Please try again."));
    } finally {
      setUploading(false);
    }
  }

  async function handleSaveExtraction() {
    if (!pending || !pendingFile) return;
    setSaving(true);
    try {
      const doc = await uploadDocument(userId, property.id, pendingFile, SETTLEMENT_DOCUMENT_TYPE);
      setOriginalDoc(doc);
      const saved = await saveSettlementAgreement(userId, protest.id, doc.id, pending);
      onAgreementChange(saved);
      setPending(null);
      setPendingFile(null);
      toast.success("Settlement document saved — tell us what came of it below.");
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not save this document."));
    } finally {
      setSaving(false);
    }
  }

  async function handleResponse(status: "not_yet" | "accepted" | "rejected") {
    if (!agreement) return;
    setRecordingResponse(true);
    try {
      await recordSettlementResponse(protest.id, agreement.id, status);
      onAgreementChange({
        ...agreement,
        responseStatus: status,
        responseRecordedAt: new Date().toISOString(),
      });
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not save your response."));
    } finally {
      setRecordingResponse(false);
    }
  }

  async function handleConfirmLooksCorrect() {
    if (!agreement) return;
    setConfirming(true);
    try {
      await confirmSettlementAgreement(agreement.id);
      onAgreementChange({ ...agreement, userConfirmedAt: new Date().toISOString() });
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not save your confirmation."));
    } finally {
      setConfirming(false);
    }
  }

  async function handleSign() {
    if (!agreement || !signature || !originalDoc || !signerName.trim()) return;
    setSigning(true);
    try {
      const { record } = await signSettlementAgreement(
        userId,
        agreement,
        property,
        originalDoc,
        signature,
        signerName.trim(),
      );
      onAgreementChange(record);
      toast.success(
        "Signed. Download the completed settlement below, then confirm whether you're satisfied.",
      );
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not sign this document."));
    } finally {
      setSigning(false);
    }
  }

  async function handleVerifySignedCopy(file: File) {
    if (!agreement) return;
    setVerifyingCopy(true);
    try {
      const { record, extraction } = await verifySignedSettlementCopy(
        userId,
        agreement,
        property,
        protest,
        file,
      );
      onAgreementChange(record);
      setSignedCopyExtraction(extraction);
      toast.success(
        extraction.signaturePresent === "No"
          ? "Uploaded, but AI couldn't find a completed signature on it — double-check the copy."
          : "Signed copy verified.",
      );
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not verify this signed copy."));
    } finally {
      setVerifyingCopy(false);
    }
  }

  async function handleDownloadSigned() {
    if (!agreement?.signedDocumentId) return;
    setDownloading(true);
    try {
      const doc = await getDocumentById(userId, agreement.signedDocumentId);
      if (!doc) throw new Error("Could not find the signed document.");
      const url = await getDocumentUrl(doc.storagePath);
      const res = await fetch(url);
      const bytes = new Uint8Array(await res.arrayBuffer());
      downloadPdf(bytes, doc.fileName);
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not download the signed document."));
    } finally {
      setDownloading(false);
    }
  }

  async function handleOutcome(outcome: "satisfied" | "not_satisfied") {
    if (!agreement) return;
    const accepted = agreement.responseStatus === "accepted" || !!agreement.signedAt;
    if (accepted && outcome === "satisfied" && agreement.settledValue == null) {
      toast.error("No settled value on file yet — upload the settlement document above first.");
      return;
    }
    setConfirmingOutcome(true);
    try {
      await confirmSettlementOutcome(protest.id, agreement.id, outcome);
      onAgreementChange({
        ...agreement,
        outcome,
        outcomeConfirmedAt: new Date().toISOString(),
      });
      if (accepted && outcome === "satisfied") {
        const settledValue = agreement.settledValue as number;
        await resolveInformalSettlement(protest.id, settledValue);
        onUpdate({
          status: "resolved",
          finalValue: settledValue,
          escalationPath: "accept",
          closedAt: new Date().toISOString(),
          informalStatus: "accepted",
        });
        toast.success(`Settlement accepted — case resolved at ${currency(settledValue)}.`);
      } else {
        await updateInformalStatus(protest.id, "rejected");
        onUpdate({ informalStatus: "rejected" });
        toast.success("Outcome recorded — formal-hearing prep is now unlocked.");
      }
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not record this outcome."));
    } finally {
      setConfirmingOutcome(false);
    }
  }

  function handleDiscard() {
    setPending(null);
    setPendingFile(null);
    setUploadError(null);
  }

  if (protest.status === "requested" || protest.status === "resolved") return null;

  const uploadButton = (
    <label
      className={`inline-flex ${agreement ? "btn-outline" : "btn-accent"} cursor-pointer text-xs py-1.5 ${uploading ? "pointer-events-none opacity-60" : ""}`}
    >
      {uploading
        ? "Reading your document…"
        : agreement
          ? "Upload a Different Settlement Offer"
          : "Upload Settlement Offer"}
      <input
        type="file"
        accept="image/*,.pdf"
        className="hidden"
        disabled={uploading}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) handleUpload(file);
        }}
      />
    </label>
  );

  const notResponded = agreement != null && agreement.responseStatus == null && !agreement.signedAt;
  const signHerePath =
    agreement != null &&
    !agreement.signedAt &&
    (agreement.responseStatus === "not_yet" || agreement.responseStatus == null);
  const canOfferSignedCopy =
    agreement != null &&
    !agreement.signedAt &&
    !agreement.signedCopyVerifiedAt &&
    agreement.responseStatus !== "rejected";
  const readyForOutcome =
    agreement != null &&
    !agreement.outcomeConfirmedAt &&
    (agreement.responseStatus === "accepted" ||
      agreement.responseStatus === "rejected" ||
      !!agreement.signedAt ||
      !!agreement.signedCopyVerifiedAt);

  return (
    <div id="case-settlement-signature" className="mt-5 border-t border-border pt-5">
      <h4 className="text-sm font-semibold">Settlement / Proposed Value</h4>
      <p className="mt-1 text-xs text-muted-foreground">
        When the county proposes a value or sends a settlement, upload it here. AI reads the real
        settled value and terms; you tell us whether you&apos;ve already accepted or rejected it, or
        sign it here (or upload the copy you signed in person), then confirm whether you&apos;re
        satisfied with the outcome.
      </p>

      {!agreement && !pending && (
        <div className="mt-2">
          {uploadButton}
          {uploadError && <p className="mt-2 text-xs text-destructive">{uploadError}</p>}
        </div>
      )}

      {pending && (
        <div className="mt-2 rounded-md border border-accent/40 bg-accent/5 p-3 text-sm">
          <p className="font-medium">Review before saving</p>
          {pending.discrepancies.length > 0 && (
            <div className="mt-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
              <span className="font-semibold">Discrepancies found:</span>
              <ul className="mt-1 grid gap-0.5">
                {pending.discrepancies.map((d, i) => (
                  <li key={i}>• {d}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-3 grid gap-2 sm:grid-cols-2 text-xs">
            <Field
              label="Settled Value"
              value={pending.finalValue != null ? currency(pending.finalValue) : "Not stated"}
              bold
            />
            <Field label="Tax Year (on document)" value={pending.taxYear ?? "Not stated"} />
            <Field
              label="Account Number (on document)"
              value={pending.accountNumber ?? "Not stated"}
            />
          </div>
          {pending.settlementTerms && (
            <div className="mt-2 text-xs">
              <div className="font-semibold text-foreground">Terms</div>
              <p className="text-muted-foreground">{pending.settlementTerms}</p>
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <button
              onClick={handleSaveExtraction}
              disabled={saving}
              className="btn-accent text-xs py-1.5 disabled:opacity-60"
            >
              {saving ? "Saving…" : "Save & Continue"}
            </button>
            <button
              onClick={handleDiscard}
              disabled={saving}
              className="btn-outline text-xs py-1.5"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {!pending && agreement && (
        <div className="mt-2 rounded-md border border-border p-3 text-sm">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="grid gap-2 sm:grid-cols-2 text-xs">
              <Field
                label="Settled Value"
                value={
                  agreement.settledValue != null ? currency(agreement.settledValue) : "Not stated"
                }
                bold
              />
              <Field label="Tax Year (on document)" value={agreement.taxYear ?? "Not stated"} />
            </div>
            {uploadButton}
          </div>
          {agreement.discrepancies.length > 0 && (
            <div className="mt-3 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
              <span className="font-semibold">Discrepancies flagged:</span>
              <ul className="mt-1 grid gap-0.5">
                {agreement.discrepancies.map((d, i) => (
                  <li key={i}>• {d}</li>
                ))}
              </ul>
            </div>
          )}
          {agreement.termsSummary && (
            <div className="mt-3 text-xs">
              <div className="font-semibold text-foreground">Terms</div>
              <p className="text-muted-foreground">{agreement.termsSummary}</p>
            </div>
          )}

          {notResponded && (
            <div className="mt-3 border-t border-border pt-3">
              <div className="text-xs font-semibold">Have you already responded to this offer?</div>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  onClick={() => handleResponse("accepted")}
                  disabled={recordingResponse}
                  className="btn-outline text-xs py-1.5 disabled:opacity-60"
                >
                  I&apos;ve accepted it
                </button>
                <button
                  onClick={() => handleResponse("rejected")}
                  disabled={recordingResponse}
                  className="btn-outline text-xs py-1.5 disabled:opacity-60"
                >
                  I&apos;ve rejected it
                </button>
                <button
                  onClick={() => handleResponse("not_yet")}
                  disabled={recordingResponse}
                  className="btn-outline text-xs py-1.5 disabled:opacity-60"
                >
                  Not yet
                </button>
              </div>
            </div>
          )}

          {signHerePath && !agreement.userConfirmedAt && (
            <div className="mt-3 border-t border-border pt-3">
              <button
                onClick={handleConfirmLooksCorrect}
                disabled={confirming}
                className="btn-accent text-xs py-1.5 disabled:opacity-60"
              >
                {confirming ? "Saving…" : "This Looks Correct — OK to Sign"}
              </button>
            </div>
          )}

          {signHerePath && agreement.userConfirmedAt && (
            <div className="mt-3 rounded-md border border-accent/40 bg-accent/5 p-3">
              <div className="text-xs font-semibold">Sign to accept this settlement</div>
              <label className="mt-2 grid gap-1 text-xs">
                Your full legal name
                <input
                  value={signerName}
                  onChange={(e) => setSignerName(e.target.value)}
                  placeholder="Full legal name"
                  className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                />
              </label>
              <div className="mt-2">
                <SignaturePad onChange={setSignature} />
              </div>
              <button
                onClick={handleSign}
                disabled={signing || !signature || !signerName.trim() || !originalDoc}
                className="btn-accent mt-3 text-xs py-1.5 disabled:opacity-60"
              >
                {signing ? "Signing…" : "Sign & Accept"}
              </button>
              {!originalDoc && (
                <p className="mt-2 text-xs text-destructive">
                  The original uploaded document couldn&apos;t be found — re-upload it above.
                </p>
              )}
            </div>
          )}

          {canOfferSignedCopy && (
            <div className="mt-3 border-t border-border pt-3">
              <div className="text-xs font-semibold">Signed it in person at the CAD office?</div>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Upload the copy you signed — AI verifies the value, date, tax year, terms, and that
                it&apos;s actually signed.
              </p>
              <label
                className={`mt-2 inline-flex btn-outline cursor-pointer text-xs py-1.5 ${
                  verifyingCopy ? "pointer-events-none opacity-60" : ""
                }`}
              >
                {verifyingCopy ? "Verifying…" : "Upload Signed Copy"}
                <input
                  type="file"
                  accept="image/*,.pdf"
                  className="hidden"
                  disabled={verifyingCopy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) handleVerifySignedCopy(file);
                  }}
                />
              </label>
            </div>
          )}

          {agreement.signedCopyVerifiedAt && (
            <div className="mt-3 rounded-md bg-secondary/40 p-2 text-xs">
              <div className="font-semibold text-foreground">
                Signed copy verified {new Date(agreement.signedCopyVerifiedAt).toLocaleDateString()}
              </div>
              <div className="mt-1 grid gap-1 sm:grid-cols-2">
                <Field
                  label="Value on signed copy"
                  value={
                    signedCopyExtraction?.finalValue != null
                      ? currency(signedCopyExtraction.finalValue)
                      : agreement.settledValue != null
                        ? currency(agreement.settledValue)
                        : "Not stated"
                  }
                />
                <Field
                  label="Signed date"
                  value={signedCopyExtraction?.signedDate ?? "Not stated"}
                />
                <Field
                  label="Tax year on copy"
                  value={signedCopyExtraction?.taxYear ?? agreement.taxYear ?? "Not stated"}
                />
                <Field
                  label="Signature present"
                  value={signedCopyExtraction?.signaturePresent ?? "Unclear"}
                />
              </div>
              {signedCopyExtraction?.discrepancies &&
                signedCopyExtraction.discrepancies.length > 0 && (
                  <div className="mt-2 rounded-md bg-destructive/10 p-2 text-destructive">
                    <span className="font-semibold">Discrepancies on the signed copy:</span>
                    <ul className="mt-1 grid gap-0.5">
                      {signedCopyExtraction.discrepancies.map((d, i) => (
                        <li key={i}>• {d}</li>
                      ))}
                    </ul>
                  </div>
                )}
            </div>
          )}

          {agreement.signedAt && (
            <div className="mt-3 rounded-md bg-secondary/40 p-3 text-xs">
              <div className="font-semibold text-foreground">
                Signed {new Date(agreement.signedAt).toLocaleDateString()}
              </div>
              <p className="mt-1 text-muted-foreground">
                Download the completed settlement and submit it to your county — there&apos;s no
                county-wide e-filing system, so delivering it is still on you.
              </p>
              <button
                onClick={handleDownloadSigned}
                disabled={downloading}
                className="btn-accent mt-2 text-xs py-1.5 disabled:opacity-60"
              >
                {downloading ? "Preparing…" : "Download Completed Settlement"}
              </button>
            </div>
          )}

          {readyForOutcome && (
            <div className="mt-3 rounded-md border border-accent/40 bg-accent/5 p-3">
              <div className="text-xs font-semibold">Are you satisfied with this outcome?</div>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                This is what moves the case forward. Satisfied with an accepted value closes the
                case at that value. Not satisfied — or a rejected offer — unlocks formal-hearing
                prep.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  onClick={() => handleOutcome("satisfied")}
                  disabled={confirmingOutcome || agreement.responseStatus === "rejected"}
                  className="btn-accent text-xs py-1.5 disabled:opacity-60"
                >
                  Satisfied
                </button>
                <button
                  onClick={() => handleOutcome("not_satisfied")}
                  disabled={confirmingOutcome}
                  className="btn-outline text-xs py-1.5 disabled:opacity-60"
                >
                  Not satisfied
                </button>
              </div>
            </div>
          )}

          {agreement.outcomeConfirmedAt && (
            <div className="mt-3 rounded-md bg-secondary/40 p-3 text-xs">
              <div className="font-semibold text-foreground">
                Outcome recorded:{" "}
                {agreement.outcome === "satisfied" ? "Satisfied" : "Not satisfied"}
              </div>
              <p className="mt-1 text-muted-foreground">
                {agreement.outcome === "satisfied" &&
                (agreement.responseStatus === "accepted" || agreement.signedAt)
                  ? "Case resolved at the settled value."
                  : "Proceeding to the formal hearing — prep is unlocked below."}
              </p>
            </div>
          )}

          <p className="mt-3 text-[11px] text-muted-foreground">
            Your county&apos;s CAD website usually reflects an accepted value within a few business
            days — check there to confirm it took effect.
          </p>
        </div>
      )}
    </div>
  );
}

// The complete case record — every proof/record item a fully-documented
// protest should hold (see src/lib/case-record.ts), what's on file, and what
// is still outstanding *for a stage the case has already reached*. Those are
// surfaced first as "needed now" prompts so the user uploads proof at each
// stage rather than scrambling at the end.
const RECORD_STAGE_LABEL: Record<string, string> = {
  filing: "Filing",
  informal: "Informal review",
  hearing: "Formal hearing",
  decision: "Decision",
  escalation: "Escalation",
  resolved: "Resolved",
};

function CaseRecordSection({
  userId,
  protest,
  property,
  onUpdate,
}: {
  userId: string;
  protest: ProtestRecord;
  property: PropertyRecord;
  onUpdate: (patch: Partial<ProtestRecord>) => void;
}) {
  const [docs, setDocs] = useState<DocumentRecord[]>([]);
  const [countyCommLogged, setCountyCommLogged] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confNum, setConfNum] = useState(protest.filingConfirmationNumber ?? "");
  const [channel, setChannel] = useState(protest.filingChannel ?? "");
  const [tracking, setTracking] = useState(protest.certifiedMailTracking ?? "");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let live = true;
    Promise.all([listDocuments(userId), getCaseAuditTrail(protest.id)])
      .then(([allDocs, events]) => {
        if (!live) return;
        setDocs(allDocs.filter((d) => d.propertyId === property.id));
        setCountyCommLogged(events.some((e) => e.kind === "county_communication"));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [userId, property.id, protest.id, reloadKey]);

  const stage = caseRecordStage(protest);
  const items = getCaseRecord(protest, {
    documents: docs,
    hearingNoticeOnFile: !!(protest.hearingLocation || protest.hearingTime),
    countyCommunicationLogged: countyCommLogged,
  });
  const prompts = outstandingProofPrompts(items, stage);
  const { onFile, applicable } = caseRecordCompletion(items);

  async function uploadFor(item: CaseRecordItem, files: File[]) {
    if (!item.docType || files.length === 0) return;
    setBusy(item.id);
    try {
      for (const file of files) {
        const doc = await uploadDocument(userId, property.id, file, item.docType);
        void logCaseEvent(protest.id, "document_added", `${item.label}: uploaded ${doc.fileName}.`);
      }
      toast.success("Added to the case record.");
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not upload this file.");
    } finally {
      setBusy(null);
    }
  }

  async function saveField(patch: Parameters<typeof saveCaseRecordFields>[1], label: string) {
    setBusy(label);
    try {
      await saveCaseRecordFields(protest.id, patch);
      onUpdate(patch as Partial<ProtestRecord>);
      toast.success("Saved to the case record.");
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save this.");
    } finally {
      setBusy(null);
    }
  }

  const byStage = new Map<string, CaseRecordItem[]>();
  for (const it of items) {
    byStage.set(it.stage, [...(byStage.get(it.stage) ?? []), it]);
  }

  return (
    <div id="case-record" className="mt-5 border-t border-border pt-5">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold">Case Record</h4>
        <span className="text-xs text-muted-foreground">
          {onFile}/{applicable} on file
        </span>
      </div>

      {prompts.length > 0 && (
        <div className="mt-2 rounded-md border border-warning/40 bg-warning/10 p-3">
          <p className="text-xs font-semibold text-warning-foreground">
            Upload proof for the current stage
          </p>
          <ul className="mt-1.5 space-y-1.5">
            {prompts.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="text-warning-foreground">{p.label}</span>
                {p.fulfil === "document" && p.docType && (
                  <label className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full border border-accent/40 bg-background px-2.5 py-1 font-semibold text-accent hover:bg-accent/10">
                    <input
                      type="file"
                      accept="image/*,.pdf"
                      multiple
                      disabled={busy === p.id}
                      className="hidden"
                      onChange={(e) => {
                        void uploadFor(p, Array.from(e.target.files ?? []));
                        e.target.value = "";
                      }}
                    />
                    {busy === p.id ? "Uploading…" : "Upload"}
                  </label>
                )}
                {p.fulfil === "field" && (
                  <span className="shrink-0 text-[11px] text-muted-foreground">Enter it below</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Field entry for the structured items */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-medium text-muted-foreground">
          Filing confirmation number
          <div className="mt-1 flex gap-1">
            <input
              value={confNum}
              onChange={(e) => setConfNum(e.target.value)}
              placeholder="Portal / email / clerk number"
              className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground"
            />
            <button
              type="button"
              disabled={busy === "conf" || confNum === (protest.filingConfirmationNumber ?? "")}
              onClick={() =>
                saveField(
                  {
                    filingConfirmationNumber: confNum,
                    ...(channel
                      ? {
                          filingChannel: channel as "online" | "mail" | "in_person" | "email",
                        }
                      : {}),
                  },
                  "conf",
                )
              }
              className="btn-outline shrink-0 text-xs disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </label>
        <label className="text-xs font-medium text-muted-foreground">
          Filed by
          <select
            value={channel}
            onChange={(e) => {
              setChannel(e.target.value);
              if (e.target.value)
                saveField(
                  {
                    filingChannel: e.target.value as "online" | "mail" | "in_person" | "email",
                  },
                  "channel",
                );
            }}
            className="mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground"
          >
            <option value="">—</option>
            <option value="online">Online portal</option>
            <option value="mail">Mail</option>
            <option value="in_person">In person</option>
            <option value="email">Email</option>
          </select>
        </label>
        {(channel === "mail" || channel === "" || protest.filingChannel === "mail") && (
          <label className="text-xs font-medium text-muted-foreground">
            Certified-mail tracking number
            <div className="mt-1 flex gap-1">
              <input
                value={tracking}
                onChange={(e) => setTracking(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground"
              />
              <button
                type="button"
                disabled={busy === "tracking" || tracking === (protest.certifiedMailTracking ?? "")}
                onClick={() => saveField({ certifiedMailTracking: tracking }, "tracking")}
                className="btn-outline shrink-0 text-xs disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </label>
        )}
        {!protest.evidenceSubmittedConfirmedAt && stage !== "filing" && (
          <div className="text-xs font-medium text-muted-foreground">
            Evidence submitted to the ARB?
            <button
              type="button"
              disabled={busy === "evsub"}
              onClick={() =>
                saveField({ evidenceSubmittedConfirmedAt: new Date().toISOString() }, "evsub")
              }
              className="btn-outline mt-1 block text-xs disabled:opacity-50"
            >
              Yes — I submitted it before the deadline
            </button>
          </div>
        )}
      </div>

      {/* Full record, grouped by stage */}
      <div className="mt-4 space-y-3">
        {["filing", "informal", "hearing", "decision", "escalation", "resolved"]
          .filter((s) => (byStage.get(s) ?? []).length > 0)
          .map((s) => (
            <div key={s}>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {RECORD_STAGE_LABEL[s]}
              </p>
              <ul className="mt-1 space-y-1">
                {(byStage.get(s) ?? []).map((it) => (
                  <li key={it.id} className="flex items-start gap-2 text-xs">
                    <span
                      className={
                        it.status === "on_file"
                          ? "text-success"
                          : it.status === "outstanding"
                            ? "text-warning-foreground"
                            : "text-muted-foreground"
                      }
                    >
                      {it.status === "on_file" ? "●" : it.status === "outstanding" ? "○" : "–"}
                    </span>
                    <span className="flex-1">
                      <span className="font-medium text-foreground">{it.label}</span>
                      <span className="text-muted-foreground"> — {it.detail}</span>
                    </span>
                    {it.status === "outstanding" && it.fulfil === "document" && it.docType && (
                      <label className="shrink-0 cursor-pointer text-accent hover:underline">
                        <input
                          type="file"
                          accept="image/*,.pdf"
                          multiple
                          disabled={busy === it.id}
                          className="hidden"
                          onChange={(e) => {
                            void uploadFor(it, Array.from(e.target.files ?? []));
                            e.target.value = "";
                          }}
                        />
                        {busy === it.id ? "Uploading…" : "Upload"}
                      </label>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
      </div>
    </div>
  );
}

// Append-only audit trail for this case (public.case_audit_events) — every
// status change, document, form, signature, submission, deadline, county
// communication and value recorded, newest first. Plus a control to log a
// county call/email that has no other home.
function CaseAuditTrailSection({ protestId }: { protestId: string }) {
  const [events, setEvents] = useState<CaseAuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    getCaseAuditTrail(protestId)
      .then((e) => {
        if (live) setEvents(e);
      })
      .catch(() => {})
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [protestId, reloadKey]);

  async function logCommunication(e: FormEvent) {
    e.preventDefault();
    if (!note.trim()) return;
    setBusy(true);
    try {
      await logCaseEvent(protestId, "county_communication", note.trim());
      setNote("");
      setReloadKey((k) => k + 1);
      toast.success("Logged.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="case-audit-trail" className="mt-5 border-t border-border pt-5">
      <h4 className="text-sm font-semibold">Audit Trail</h4>

      <form onSubmit={logCommunication} className="mt-2 flex gap-1">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Log a county call or email (who, when, what was said)"
          className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground"
        />
        <button
          type="submit"
          disabled={busy || !note.trim()}
          className="btn-outline shrink-0 text-xs disabled:opacity-50"
        >
          {busy ? "Logging…" : "Log"}
        </button>
      </form>

      {loading ? (
        <div className="mt-3 grid gap-2">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-3 w-56" />
        </div>
      ) : events.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          No recorded events yet — case actions you take here are logged automatically.
        </p>
      ) : (
        <ol className="mt-3 space-y-2">
          {events.map((ev) => (
            <li key={ev.id} className="flex gap-2 text-xs">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
              <span className="flex-1">
                <span className="text-foreground">{ev.summary}</span>
                <span className="block text-[10px] text-muted-foreground">
                  {caseAuditKindLabel(ev.kind)} ·{" "}
                  {new Date(ev.occurredAt).toLocaleString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// "Escalation May Be Available" — shown only once the informal review and the
// formal ARB hearing have both closed unfavourably (see evaluateEscalation's
// availability gate). Every figure is deterministic (escalation-eval.ts): the
// statutory deadline windows, the real Comptroller deposit schedule, savings
// from the value gap × the county effective tax rate. It is explicitly an
// evaluation of options, not a prediction — the disclaimer says so and so
// does every option row.
function EscalationEvaluationSection({
  protest,
  property,
  evidenceDocumentCount,
  onUpdate,
}: {
  protest: ProtestRecord;
  property: PropertyRecord;
  evidenceDocumentCount: number;
  onUpdate: (patch: Partial<ProtestRecord>) => void;
}) {
  const [opinionInput, setOpinionInput] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [showApprove, setShowApprove] = useState(false);
  const [approveId, setApproveId] = useState("");
  const [showClose, setShowClose] = useState(false);
  const [closeValue, setCloseValue] = useState(String(protest.finalValue ?? ""));
  const [busy, setBusy] = useState(false);

  const opinionOfValue = opinionInput ? Number(opinionInput.replace(/[^0-9.]/g, "")) : null;
  const evalr: EscalationEvaluation = evaluateEscalation(
    property,
    protest,
    evidenceDocumentCount,
    opinionOfValue && opinionOfValue > 0 ? opinionOfValue : null,
  );
  if (!evalr.available) return null;

  const eligibleValueRemedies = evalr.options.filter(
    (o) =>
      o.eligible &&
      (o.id === "binding_arbitration" || o.id === "district_court" || o.id === "soah"),
  );
  const recommended = evalr.options.find((o) => o.recommended) ?? null;
  const pathFor = (id: string): "appeal" | "arbitration" =>
    id === "district_court" ? "appeal" : "arbitration";

  async function approveEscalation() {
    const id = approveId || recommended?.id || eligibleValueRemedies[0]?.id;
    if (!id || id === "no_further_action") return;
    const path = pathFor(id);
    setBusy(true);
    try {
      await recordEscalation(protest.id, path);
      onUpdate({ escalationPath: path, status: path === "appeal" ? "appealing" : "arbitrating" });
      toast.success(
        path === "appeal"
          ? "Recorded — district court appeal. This proceeds outside CorvusPT."
          : "Recorded — binding arbitration. This is handled with the Comptroller's office.",
      );
      setShowApprove(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not record this next step.");
    } finally {
      setBusy(false);
    }
  }

  async function closeNow(e: FormEvent) {
    e.preventDefault();
    if (!closeValue) return;
    setBusy(true);
    try {
      const finalValue = Number(closeValue);
      await closeCase(protest.id, finalValue);
      onUpdate({ finalValue, closedAt: new Date().toISOString(), status: "resolved" });
      toast.success("Case closed.");
      setShowClose(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not close this case.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="case-escalation" className="mt-5 border-t border-border pt-5">
      <h4 className="text-sm font-semibold">Escalation May Be Available</h4>
      <p className="mt-1 text-sm text-foreground">{evalr.headline}</p>
      <p className="mt-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] leading-snug text-warning-foreground">
        {evalr.disclaimer}
      </p>

      <label className="mt-3 block text-xs font-medium text-muted-foreground">
        Your opinion of value (optional — enables the savings &amp; ROI columns)
        <input
          inputMode="numeric"
          value={opinionInput}
          onChange={(e) => setOpinionInput(e.target.value)}
          placeholder="e.g. 11,000,000"
          className="mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground"
        />
      </label>

      <ul className="mt-3 grid gap-2">
        {evalr.options.map((o) => (
          <EscalationOptionRow key={o.id} o={o} expanded={expanded} />
        ))}
      </ul>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="btn-outline text-sm py-1.5"
        >
          {expanded ? "Hide detail" : "Review Escalation"}
        </button>
        {eligibleValueRemedies.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setApproveId(recommended?.id ?? eligibleValueRemedies[0].id);
              setShowApprove((v) => !v);
              setShowClose(false);
            }}
            className="btn-primary text-sm py-1.5"
          >
            Approve Escalation
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            setShowClose((v) => !v);
            setShowApprove(false);
          }}
          className="btn-outline text-sm py-1.5"
        >
          Close Case
        </button>
      </div>

      {showApprove && eligibleValueRemedies.length > 0 && (
        <div className="mt-3 rounded-md border border-border p-3">
          <label className="block text-xs font-medium text-muted-foreground">
            Record which escalation you're pursuing
            <select
              value={approveId}
              onChange={(e) => setApproveId(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground"
            >
              {eligibleValueRemedies.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.title} ({o.statute})
                </option>
              ))}
            </select>
          </label>
          <p className="mt-2 text-[11px] text-muted-foreground">
            This records your decision on the case. CorvusPT does not file the arbitration request
            or court petition for you — you or your attorney do that with the appraisal district by
            the deadline shown above.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={approveEscalation}
            className="btn-primary mt-2 text-sm py-1.5 disabled:opacity-60"
          >
            {busy ? "Recording…" : "Confirm"}
          </button>
        </div>
      )}

      {showClose && (
        <form onSubmit={closeNow} className="mt-3 rounded-md border border-border p-3">
          <label className="block text-xs font-medium text-muted-foreground">
            Final value to record
            <input
              inputMode="numeric"
              value={closeValue}
              onChange={(e) => setCloseValue(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground"
            />
          </label>
          <button
            type="submit"
            disabled={busy || !closeValue}
            className="btn-primary mt-2 text-sm py-1.5 disabled:opacity-60"
          >
            {busy ? "Closing…" : "Close case at this value"}
          </button>
        </form>
      )}
    </div>
  );
}

function EscalationOptionRow({ o, expanded }: { o: EscalationOption; expanded: boolean }) {
  return (
    <li
      className={`rounded-md border p-3 text-sm ${
        o.recommended ? "border-success/50 bg-success/5" : "border-border"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-foreground">{o.title}</span>
        <span className="text-[11px] text-muted-foreground">{o.statute}</span>
        {o.recommended && (
          <span className="rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-semibold text-success">
            Suggested
          </span>
        )}
        {!o.eligible && (
          <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
            Not available
          </span>
        )}
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[12px] sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Deadline</dt>
          <dd className="font-medium">
            {o.deadline.date
              ? new Date(`${o.deadline.date}T00:00:00`).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })
              : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Est. cost</dt>
          <dd className="font-medium">
            {o.estimatedCost
              ? o.estimatedCost.min === o.estimatedCost.max
                ? currency(o.estimatedCost.min)
                : `${currency(o.estimatedCost.min)}–${currency(o.estimatedCost.max)}`
              : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Added savings / yr</dt>
          <dd className="font-medium">
            {o.potentialAdditionalSavings.amount != null
              ? currency(o.potentialAdditionalSavings.amount)
              : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Est. ROI</dt>
          <dd className="font-medium">
            {o.estimatedRoi.ratio != null ? `${o.estimatedRoi.ratio}×` : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Evidence</dt>
          <dd className="font-medium capitalize">{o.evidenceStrength}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Risk</dt>
          <dd className="font-medium capitalize">{o.risk.band}</dd>
        </div>
      </dl>
      {expanded && (
        <div className="mt-2 space-y-1 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
          <p>{o.practicalBenefit}</p>
          <p>
            <span className="font-medium text-foreground">Eligibility:</span> {o.eligibilityBasis}
          </p>
          <p>
            <span className="font-medium text-foreground">Deadline basis:</span> {o.deadline.basis}
          </p>
          {o.estimatedCost && (
            <p>
              <span className="font-medium text-foreground">Cost basis:</span>{" "}
              {o.estimatedCost.basis}
            </p>
          )}
          <p>
            <span className="font-medium text-foreground">Savings basis:</span>{" "}
            {o.potentialAdditionalSavings.basis}
          </p>
          <p>
            <span className="font-medium text-foreground">Risk basis:</span> {o.risk.basis}
          </p>
        </div>
      )}
    </li>
  );
}

export function CaseProgress({
  protest,
  property,
  caseData,
  onUpdate,
}: {
  protest: ProtestRecord;
  property: PropertyRecord;
  caseData: ProtestCase | null;
  onUpdate: (patch: Partial<ProtestRecord>) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [showOfferForm, setShowOfferForm] = useState(false);
  const [offerValue, setOfferValue] = useState("");
  const [offerDate, setOfferDate] = useState(new Date().toISOString().slice(0, 10));
  const [showHearingForm, setShowHearingForm] = useState(false);
  const [hearingDateInput, setHearingDateInput] = useState("");
  const [showHearingSummary, setShowHearingSummary] = useState(false);
  const [showDecisionForm, setShowDecisionForm] = useState(false);
  const [decisionType, setDecisionType] = useState<"approved" | "partial" | "denied">("partial");
  const [decisionDate, setDecisionDate] = useState(new Date().toISOString().slice(0, 10));
  const [decisionValue, setDecisionValue] = useState("");
  const [showCloseForm, setShowCloseForm] = useState(false);
  const [closeValue, setCloseValue] = useState("");

  async function submitOffer(e: FormEvent) {
    e.preventDefault();
    if (!offerValue) return;
    setBusy(true);
    try {
      const value = Number(offerValue);
      await recordSettlementOffer(protest.id, { value, receivedAt: offerDate });
      onUpdate({
        settlementOfferValue: value,
        settlementOfferReceivedAt: offerDate,
        status: "offer_received",
      });
      setShowOfferForm(false);
      toast.success("Settlement offer recorded.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not record this offer.");
    } finally {
      setBusy(false);
    }
  }

  async function handleAcceptOffer() {
    if (protest.settlementOfferValue == null) return;
    setBusy(true);
    try {
      await acceptSettlement(protest.id, protest.settlementOfferValue);
      onUpdate({
        finalValue: protest.settlementOfferValue,
        escalationPath: "accept",
        closedAt: new Date().toISOString(),
        status: "resolved",
      });
      toast.success("Offer accepted — case closed.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not accept this offer.");
    } finally {
      setBusy(false);
    }
  }

  async function submitHearing(e: FormEvent) {
    e.preventDefault();
    if (!hearingDateInput) return;
    setBusy(true);
    try {
      await scheduleHearing(protest.id, hearingDateInput);
      onUpdate({ hearingDate: hearingDateInput, status: "hearing_scheduled" });
      setShowHearingForm(false);
      toast.success("Hearing date recorded.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not record this hearing date.");
    } finally {
      setBusy(false);
    }
  }

  async function submitDecision(e: FormEvent) {
    e.preventDefault();
    if (!decisionValue) return;
    setBusy(true);
    try {
      const finalValue = Number(decisionValue);
      await recordArbDecision(protest.id, { type: decisionType, date: decisionDate, finalValue });
      const resolved = decisionType === "approved";
      onUpdate({
        arbDecision: decisionType,
        arbDecisionDate: decisionDate,
        finalValue,
        status: resolved ? "resolved" : "decision_received",
        ...(resolved ? { closedAt: new Date().toISOString(), escalationPath: "accept" } : {}),
      });
      setShowDecisionForm(false);
      toast.success("ARB decision recorded.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not record this decision.");
    } finally {
      setBusy(false);
    }
  }

  async function handleEscalate(path: "appeal" | "arbitration") {
    setBusy(true);
    try {
      await recordEscalation(protest.id, path);
      onUpdate({ escalationPath: path, status: path === "appeal" ? "appealing" : "arbitrating" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not record this next step.");
    } finally {
      setBusy(false);
    }
  }

  async function handleAcceptDecision() {
    if (protest.finalValue == null) return;
    setBusy(true);
    try {
      await acceptSettlement(protest.id, protest.finalValue);
      onUpdate({
        escalationPath: "accept",
        closedAt: new Date().toISOString(),
        status: "resolved",
      });
      toast.success("Decision accepted — case closed.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not close this case.");
    } finally {
      setBusy(false);
    }
  }

  async function submitClose(e: FormEvent) {
    e.preventDefault();
    if (!closeValue) return;
    setBusy(true);
    try {
      const finalValue = Number(closeValue);
      await closeCase(protest.id, finalValue);
      onUpdate({ finalValue, closedAt: new Date().toISOString(), status: "resolved" });
      setShowCloseForm(false);
      toast.success("Case closed.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not close this case.");
    } finally {
      setBusy(false);
    }
  }

  const results = getCaseResults(protest, property);

  return (
    <div id="case-progress" className="mt-5 border-t border-border pt-5">
      <h4 className="text-sm font-semibold">Case Progress</h4>

      {protest.status === "resolved" ? (
        results ? (
          <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
            <Field label="Original Value" value={currency(protest.originalValue ?? undefined)} />
            <Field label="Final Value" value={currency(protest.finalValue ?? undefined)} />
            <Field label="Value Reduction" value={currency(results.valueReduction)} bold />
            <Field
              label="Actual Tax Savings"
              value={currency(results.actualSavings)}
              bold
              success
            />
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            Case closed — no final value on file.
          </p>
        )
      ) : (
        <div className="mt-3 grid gap-4">
          {/* Settlement offer */}
          {protest.status === "offer_received" ? (
            <div className="rounded-md border border-border p-3 text-sm">
              <div className="font-medium">
                Settlement offer: {currency(protest.settlementOfferValue ?? undefined)}
                {protest.settlementOfferReceivedAt && ` (${protest.settlementOfferReceivedAt})`}
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={handleAcceptOffer}
                  disabled={busy}
                  className="btn-accent text-xs py-1.5 disabled:opacity-60"
                >
                  Accept Offer
                </button>
                <span className="text-xs text-muted-foreground self-center">
                  or schedule a hearing below to proceed instead
                </span>
              </div>
            </div>
          ) : (
            protest.status !== "decision_received" &&
            protest.status !== "appealing" &&
            protest.status !== "arbitrating" && (
              <div>
                {showOfferForm ? (
                  <form
                    onSubmit={submitOffer}
                    className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] items-end"
                  >
                    <label className="grid gap-1 text-xs">
                      Offer amount<span className="text-destructive"> *</span>
                      <input
                        required
                        value={offerValue}
                        onChange={(e) => setOfferValue(e.target.value)}
                        inputMode="decimal"
                        className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                      />
                    </label>
                    <label className="grid gap-1 text-xs">
                      Date received<span className="text-destructive"> *</span>
                      <input
                        required
                        type="date"
                        value={offerDate}
                        onChange={(e) => setOfferDate(e.target.value)}
                        className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                      />
                    </label>
                    <button
                      type="submit"
                      disabled={busy}
                      className="btn-accent text-xs py-1.5 disabled:opacity-60"
                    >
                      Save
                    </button>
                  </form>
                ) : (
                  <button
                    onClick={() => setShowOfferForm(true)}
                    className="btn-outline text-xs py-1.5"
                  >
                    Record Settlement Offer
                  </button>
                )}
              </div>
            )
          )}

          {/* Hearing */}
          {(protest.status === "hearing_scheduled" ||
            (protest.status !== "decision_received" &&
              protest.status !== "appealing" &&
              protest.status !== "arbitrating")) && (
            <div>
              {protest.status === "hearing_scheduled" ? (
                <div className="rounded-md border border-border p-3 text-sm">
                  <div className="font-medium">Hearing scheduled: {protest.hearingDate}</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      onClick={() => setShowHearingSummary((v) => !v)}
                      className="btn-outline text-xs py-1.5"
                    >
                      {showHearingSummary ? "Hide" : "View"} Hearing Summary
                    </button>
                    <button
                      onClick={() => setShowDecisionForm((v) => !v)}
                      className="btn-outline text-xs py-1.5"
                    >
                      Record ARB Decision
                    </button>
                  </div>
                  {showHearingSummary && caseData && (
                    <pre className="mt-3 whitespace-pre-wrap rounded-md bg-secondary/40 p-3 text-xs">
                      {getHearingPrep(caseData, property.address)}
                    </pre>
                  )}
                  {showDecisionForm && (
                    <form onSubmit={submitDecision} className="mt-3 grid gap-2 sm:grid-cols-2">
                      <label className="grid gap-1 text-xs">
                        Decision
                        <select
                          value={decisionType}
                          onChange={(e) => setDecisionType(e.target.value as typeof decisionType)}
                          className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                        >
                          <option value="approved">Approved (full reduction granted)</option>
                          <option value="partial">Partial reduction</option>
                          <option value="denied">Denied</option>
                        </select>
                      </label>
                      <label className="grid gap-1 text-xs">
                        Decision date<span className="text-destructive"> *</span>
                        <input
                          required
                          type="date"
                          value={decisionDate}
                          onChange={(e) => setDecisionDate(e.target.value)}
                          className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                        />
                      </label>
                      <label className="grid gap-1 text-xs sm:col-span-2">
                        Final determined value<span className="text-destructive"> *</span>
                        <input
                          required
                          value={decisionValue}
                          onChange={(e) => setDecisionValue(e.target.value)}
                          inputMode="decimal"
                          className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                        />
                      </label>
                      <button
                        type="submit"
                        disabled={busy}
                        className="btn-accent text-xs py-1.5 w-fit disabled:opacity-60"
                      >
                        Save Decision
                      </button>
                    </form>
                  )}
                </div>
              ) : (
                <div>
                  {showHearingForm ? (
                    <form onSubmit={submitHearing} className="flex flex-wrap items-end gap-2">
                      <label className="grid gap-1 text-xs">
                        Hearing date<span className="text-destructive"> *</span>
                        <input
                          required
                          type="date"
                          value={hearingDateInput}
                          onChange={(e) => setHearingDateInput(e.target.value)}
                          className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                        />
                      </label>
                      <button
                        type="submit"
                        disabled={busy}
                        className="btn-accent text-xs py-1.5 disabled:opacity-60"
                      >
                        Save
                      </button>
                    </form>
                  ) : (
                    <button
                      onClick={() => setShowHearingForm(true)}
                      className="btn-outline text-xs py-1.5"
                    >
                      Schedule a Hearing
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Decision received, non-approved — next steps */}
          {protest.status === "decision_received" && (
            <div className="rounded-md border border-border p-3 text-sm">
              <div className="font-medium">
                ARB decision: {protest.arbDecision} — final value{" "}
                {currency(protest.finalValue ?? undefined)}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">What's next?</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  onClick={handleAcceptDecision}
                  disabled={busy}
                  className="btn-accent text-xs py-1.5 disabled:opacity-60"
                >
                  Accept
                </button>
                <button
                  onClick={() => handleEscalate("appeal")}
                  disabled={busy}
                  className="btn-outline text-xs py-1.5 disabled:opacity-60"
                >
                  File Judicial Appeal
                </button>
                <button
                  onClick={() => handleEscalate("arbitration")}
                  disabled={busy}
                  className="btn-outline text-xs py-1.5 disabled:opacity-60"
                >
                  Request Binding Arbitration
                </button>
              </div>
            </div>
          )}

          {/* Appealing / arbitrating */}
          {(protest.status === "appealing" || protest.status === "arbitrating") && (
            <div className="rounded-md border border-border p-3 text-sm">
              <div className="font-medium">
                {protest.status === "appealing"
                  ? "Judicial appeal in progress."
                  : "Binding arbitration in progress."}
              </div>
              {protest.status === "arbitrating" ? (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Texas requires agents to file a Request for Binding Arbitration online, not on
                  paper — file at{" "}
                  <a
                    href="https://www.texas.gov/propertytaxarbitration"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline"
                  >
                    texas.gov/propertytaxarbitration
                  </a>
                  . A deposit is required with the request (refunded if the arbitrator's value lands
                  closer to the owner's opinion of value than the ARB's).
                </p>
              ) : (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  A judicial appeal is a lawsuit filed in district court (Tax Code Chapter 42), not
                  a Comptroller form — it typically requires an attorney and isn't something this
                  app files. See the Comptroller's{" "}
                  <a
                    href="https://comptroller.texas.gov/taxes/property-tax/protests/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline"
                  >
                    Appraisal Protests and Appeals
                  </a>{" "}
                  overview for background.
                </p>
              )}
              {showCloseForm ? (
                <form onSubmit={submitClose} className="mt-2 flex flex-wrap items-end gap-2">
                  <label className="grid gap-1 text-xs">
                    Final determined value<span className="text-destructive"> *</span>
                    <input
                      required
                      value={closeValue}
                      onChange={(e) => setCloseValue(e.target.value)}
                      inputMode="decimal"
                      className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={busy}
                    className="btn-accent text-xs py-1.5 disabled:opacity-60"
                  >
                    Save
                  </button>
                </form>
              ) : (
                <button
                  onClick={() => setShowCloseForm(true)}
                  className="btn-outline text-xs py-1.5 mt-2"
                >
                  Record Final Outcome
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  bold,
  success,
}: {
  label: string;
  value: string;
  bold?: boolean;
  success?: boolean;
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`${bold ? "font-semibold" : ""} ${success ? "text-success" : ""}`}>
        {value}
      </div>
    </div>
  );
}
