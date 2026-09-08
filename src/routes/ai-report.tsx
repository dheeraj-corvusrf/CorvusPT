import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { getErrorMessage } from "@/lib/error-message";
import {
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  Lock,
  FileWarning,
  Target,
  FileText,
  BarChart3,
  ArrowRight,
  MapPin,
  Building2,
  Home,
  Percent,
  DollarSign,
  Activity,
  TrendingUp,
  TrendingDown,
  ShieldCheck,
  Wrench,
  RefreshCw,
  ArrowDown,
  ChevronDown,
  Upload,
  User,
  Cpu,
  Scale,
  Gauge,
  type LucideIcon,
} from "lucide-react";
import {
  RadialBarChart,
  RadialBar,
  PolarAngleAxis,
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Cell,
  LabelList,
  ScatterChart,
  Scatter,
  ReferenceLine,
} from "recharts";
import {
  readIntake,
  updateIntake,
  currency,
  UPLOAD_LIMITS,
  fileToDataUrl,
  type IntakeState,
} from "@/lib/intake-store";
import { MODULES, type Module } from "@/lib/modules";
import type { IconColor } from "@/lib/icon-colors";
import { useAuth } from "@/lib/auth";
import {
  getMyBilling,
  startPropertyCheckout,
  bracketForValue,
  formatMoney,
  TIER_BRACKET_PRICES,
  type PlanValue,
  type Tier,
} from "@/lib/billing";
import {
  getHealthScore,
  type HealthScoreResult,
  type HealthScoreBreakdownEntry,
} from "@/lib/ai-health-score";
import {
  getModuleAnalysis,
  askModuleQuestion,
  type BatchModuleId,
  type ModuleAnalysisInput,
  type ModuleResultMap,
  type StrategyEntry,
} from "@/lib/ai-report-modules";
import { getComps, type CompsResult, type CompProperty } from "@/lib/cad-comps";
import { getSiteGis, type SiteGisResult } from "@/lib/site-gis";
import { geocodeAddress, type GeocodedPoint } from "@/lib/geocode";
import { pickHeadlineFactor, countDataGaps, type SiteFactor } from "@/lib/site-condition";
import { getTypicalEconomicLife, computeDepreciation } from "@/lib/improvement-condition";
import { getCadRecordUrl, isDirectCadRecordUrl } from "@/lib/cad-record-url";
import {
  computeComparableStats,
  type RankedComp,
  type ComparableStats,
} from "@/lib/comps-analysis";
import { estimateSavings } from "@/lib/savings-estimate";
import { getExecutiveSummary, getDefenseReadinessScore } from "@/lib/executive-summary";
import {
  getPreFilingCheck,
  isPreFilingBlocked,
  type PreFilingCheckItem,
} from "@/lib/pre-filing-check";
import {
  classifyPropertyCategory,
  getAssessmentRatioInfo,
  applyValueTrendAdjustment,
} from "@/lib/texas-tax-rates";
import { CompsMap, useLeaflet } from "@/components/CompsMap";
import { findExistingProperty, addProperty, type PropertyRecord } from "@/lib/properties";
import { listProtests, requestProtest, type ProtestRecord } from "@/lib/protests";
import { generateCasePrep } from "@/lib/protest-case";
import {
  uploadDocument,
  listDocuments,
  getDocumentUrl,
  EVIDENCE_DOCUMENT_TYPE,
  PROTEST_EVIDENCE_DOCUMENT_TYPE,
  type DocumentRecord,
} from "@/lib/documents";
import { analyzeEvidence, type EvidenceAnalysis, type DocumentStatus } from "@/lib/protest-reason";
import { buildEvidencePacket } from "@/lib/evidence-packet";
import { categorizeEvidenceUploads } from "@/lib/evidence-categorize";
import { downloadPdf } from "@/lib/protest-documents";
import {
  listModuleOverrides,
  markNotApplicable as markModuleNotApplicable,
  clearNotApplicable as clearModuleNotApplicable,
  isModuleNotApplicable,
  isItemNotApplicable,
  itemsNotApplicable,
  WHOLE_MODULE_KEY,
  type ModuleOverride,
} from "@/lib/module-overrides";
import {
  listCompSelections,
  upsertCompSelection,
  deleteCompSelection,
  excludedCompKeys,
  compSelectionsToExtraComps,
  extractCompSale,
  type CompSelection,
  type CompSelectionInput,
  type CompSaleExtraction,
} from "@/lib/comp-selections";
import { ProtestAuthorizationFlow } from "@/components/ProtestAuthorizationFlow";
import { AnimatedNumber } from "@/components/AnimatedNumber";
import { ValueHistorySection } from "@/components/ValueHistorySection";
import { Modal } from "@/components/Modal";

type ModuleAsyncState = {
  data: unknown;
  loading: boolean;
  error: string | null;
};

export const Route = createFileRoute("/ai-report")({
  head: () => ({
    meta: [
      { title: "AI Property Review — CorvusPT" },
      { name: "description", content: "AI-generated property tax review with 10 premium modules." },
      { property: "og:title", content: "AI Property Review" },
      {
        property: "og:description",
        content: "AI analysis of your Texas commercial or residential property.",
      },
    ],
  }),
  // Lets a deep link (CaseDetailModal's "Upload Evidence — Go to Module 8"
  // button) auto-open a specific module's modal on load, same
  // validateSearch pattern sign-in.tsx already uses for its own `redirect`.
  validateSearch: (search: Record<string, unknown>): { openModule?: string } => ({
    openModule: typeof search.openModule === "string" ? search.openModule : undefined,
  }),
  component: Report,
});

// Modules 1-3 are free for everyone, signed in or not. Modules 4-10 require a
// paid subscription — there is no sign-in-only tier and no per-user "pick any
// 3" quota; which modules are free is fixed by module number, not user choice.
const FREE_MODULE_COUNT = 3;

// Real comps-derived signal fed into Module 2's prompt (see loadModule() below) —
// median/min/max of the same real comparable market values CompsMap/CompsValueScatter
// already render, not a new fetch or an invented figure.
function buildCompsSummary(compsData: CompsResult | null) {
  const values = (compsData?.comps ?? [])
    .map((c) => c.marketValue)
    .filter((v): v is number => v != null);
  if (values.length === 0 || !compsData) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
    count: compsData.comps.length,
  };
}

// Real value-history-jump signal fed into Module 2's prompt — same
// applyValueTrendAdjustment() real trend-vs-own-history check success-
// probability.ts already reuses; baseReductionPct is passed as 0 since only the
// jump detection is needed here, not a reduction percentage.
function buildValueTrend(valueHistory: IntakeState["valueHistory"]) {
  const history = (valueHistory ?? [])
    .map((h) => ({ year: h.year, value: h.appraisedValue ?? h.marketValue ?? null }))
    .filter((h): h is { year: number; value: number } => h.value != null);
  const trend = applyValueTrendAdjustment(0, history);
  return { jumpTriggered: trend.jumpTriggered, jumpPct: trend.jumpPct };
}

function Report() {
  const nav = useNavigate();
  const { user } = useAuth();
  const { openModule: deepLinkModuleId } = Route.useSearch();
  const [state, setState] = useState<IntakeState>({ previewsUsed: [] });
  const [analyzing, setAnalyzing] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showWall, setShowWall] = useState(false);
  const [hasFullAccess, setHasFullAccess] = useState(false);
  // The raw plan value, not just the hasFullAccess boolean below — owner_managed
  // means the customer files their own protest (no agent-appointment agreement,
  // no CorvusPT staff in the loop); startProtest() branches on this directly
  // rather than routing every plan through the same "hire CorvusPT as agent"
  // ProtestAuthorizationFlow.
  const [myPlan, setMyPlan] = useState<PlanValue | null>(null);
  // Set once the billing check below has actually resolved (true either way —
  // real access or not; also true immediately when there's no signed-in user
  // to check) — a deep link (?openModule=evidence, from CaseDetailModal's
  // "Upload Evidence" button) must wait for this before deciding real vs.
  // paywalled, or a paying customer would see a flash of the paywall before
  // hasFullAccess catches up.
  const [billingChecked, setBillingChecked] = useState(false);
  // AI content for every module (health + the 8 batch modules) is fetched lazily —
  // only when the user clicks "Unlock preview" on that specific module, via
  // loadModule() below — rather than all up front, so tokens are only spent on
  // modules the user actually opens.
  const [moduleData, setModuleData] = useState<Record<string, ModuleAsyncState>>({});
  // Separate from moduleData since it's not an AI call and has its own real/empty
  // result shape (CompsResult, not the free-text ModuleResultMap) — only fetched
  // when the Comps module (module 3) is opened.
  // `attempted` distinguishes "settled, genuinely no subject" from "not
  // started yet" — same reason siteGisMap below carries its own.
  const [compsMap, setCompsMap] = useState<{
    data: CompsResult | null;
    loading: boolean;
    attempted: boolean;
  }>({
    data: null,
    loading: false,
    attempted: false,
  });
  // Fallback coordinates for every county getComps() has no comps platform
  // for (see its own comment — only 4 counties return a real subject/lat-
  // lng). Only attempted once compsMap has genuinely settled with no
  // subject of its own (see the firing effect below) — CAD's own
  // coordinates are preferred when they exist, tied to the actual parcel
  // rather than a geocoder's best guess at the mailing address.
  const [geocodedSubject, setGeocodedSubject] = useState<{
    data: GeocodedPoint | null;
    loading: boolean;
    attempted: boolean;
  }>({
    data: null,
    loading: false,
    attempted: false,
  });
  // Real FEMA flood-zone + USGS elevation for the subject's lat/lng, once
  // compsMap resolves one (see loadSiteGis()/its firing effect below). Same
  // rationale as compsMap: not an AI call, its own real/empty result shape.
  // `attempted` distinguishes "settled, genuinely no data" from "not started
  // yet" — see loadSiteGis's own comment.
  const [siteGisMap, setSiteGisMap] = useState<{
    data: SiteGisResult | null;
    loading: boolean;
    attempted: boolean;
  }>({
    data: null,
    loading: false,
    attempted: false,
  });
  // Lets "Request Protest Filing" work from the report page too, not just the
  // Properties dashboard — resolves (or, on first click, creates) the real saved
  // PropertyRecord this report is for, reusing the exact same dedup lookup
  // properties.ts already uses elsewhere so this never creates a duplicate row for
  // a property the user already has on file.
  const [resolvedProperty, setResolvedProperty] = useState<PropertyRecord | null>(null);
  const [existingProtest, setExistingProtest] = useState<ProtestRecord | null>(null);
  const [authorizing, setAuthorizing] = useState(false);
  // Which tier's checkout is currently redirecting, for the unpaid-property
  // "Subscribe" buttons in the banner below (real, one-click checkout right
  // here — see handleSubscribeToProperty — rather than sending the user off
  // to the Properties list to find this same property again).
  const [subscribingTier, setSubscribingTier] = useState<Tier | null>(null);
  // Evidence (photos/repair estimates/appraisals) the user has uploaded for this
  // property, fed into the Improvement Condition module's analysis — see
  // handleUploadEvidence() and loadModule() below.
  const [evidenceDocs, setEvidenceDocs] = useState<DocumentRecord[]>([]);
  const [uploadingEvidence, setUploadingEvidence] = useState(false);
  // Real, user-confirmed "not applicable" marks for gated modules/factors/
  // components — see module-overrides.ts. Loaded once resolvedProperty
  // exists (same gate as the evidence-docs effect below, since overrides
  // are keyed by property id too).
  const [overrides, setOverrides] = useState<ModuleOverride[]>([]);
  // Module 3 (Market Value) — the user's include/exclude/add decisions for
  // comparable sales. Loaded once per property; every mutation is optimistic
  // (same pattern as `overrides` above) and re-runs the comps AI so its
  // per-comp verdicts stay consistent with the set the user actually kept.
  const [compSelections, setCompSelections] = useState<CompSelection[]>([]);

  useEffect(() => {
    const s = readIntake();
    if (!s.confirmed) {
      setState(s);
      nav({ to: "/intake" });
      return;
    }
    // Real "reached AI Review" signal for JourneyTracker (see aiReviewReached's
    // own comment in intake-store.ts) — set once, here, rather than every
    // render, since updateIntake's write is otherwise harmless but pointless
    // to repeat.
    setState(s.aiReviewReached ? s : updateIntake({ aiReviewReached: true }));
    const t = setTimeout(() => setAnalyzing(false), 1800);
    return () => clearTimeout(t);
  }, [nav]);

  useEffect(() => {
    if (!user || !state.address) return;
    findExistingProperty(user.id, {
      address: state.address,
      cad: state.cad,
      accountNumber: state.accountNumber,
    })
      .then((property) => {
        setResolvedProperty(property);
        if (!property) return;
        return listProtests(user.id).then((protests) => {
          setExistingProtest(protests.find((p) => p.propertyId === property.id) ?? null);
        });
      })
      .catch((err) => console.error("Could not resolve this property for protest filing:", err));
    // user?.id, not the user object — a background TOKEN_REFRESHED hands us a
    // fresh user object and would otherwise re-run this (and everything keyed
    // on resolvedProperty) on every tab focus, briefly nulling the resolved
    // property and remounting the protest-authorization modal mid-flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, state.address, state.cad, state.accountNumber]);

  useEffect(() => {
    if (!user || !resolvedProperty) return;
    listDocuments(user.id)
      .then((docs) =>
        setEvidenceDocs(
          docs.filter(
            (d) =>
              d.propertyId === resolvedProperty.id &&
              d.useAsEvidence !== false &&
              (d.useAsEvidence === true ||
                d.documentType === EVIDENCE_DOCUMENT_TYPE ||
                d.documentType === PROTEST_EVIDENCE_DOCUMENT_TYPE ||
                d.documentType?.startsWith("Strategy Evidence: ")),
          ),
        ),
      )
      .catch((err) => console.error("Could not load uploaded evidence for this property:", err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, resolvedProperty]);

  useEffect(() => {
    if (!resolvedProperty) return;
    listModuleOverrides(resolvedProperty.id)
      .then(setOverrides)
      .catch((err) => console.error("Could not load module overrides for this property:", err));
  }, [resolvedProperty]);

  useEffect(() => {
    if (!resolvedProperty) return;
    listCompSelections(resolvedProperty.id)
      .then(setCompSelections)
      .catch((err) => console.error("Could not load comp selections for this property:", err));
  }, [resolvedProperty]);

  // Include/exclude a comp, or save a hand-added / document-extracted comp.
  // Optimistic local update, then re-run Module 3's AI so recommendedKeys /
  // perComp / protestRecommendation reflect the new set.
  async function saveCompSelection(sel: CompSelectionInput) {
    if (!user || !resolvedProperty) return;
    setCompSelections((prev) => [
      ...prev.filter((s) => s.compKey !== sel.compKey),
      {
        compKey: sel.compKey,
        action: sel.action,
        address: sel.address ?? null,
        latitude: sel.latitude ?? null,
        longitude: sel.longitude ?? null,
        salePrice: sel.salePrice ?? null,
        saleDate: sel.saleDate ?? null,
        landSqft: sel.landSqft ?? null,
        buildingSqft: sel.buildingSqft ?? null,
        source: sel.source ?? null,
        notes: sel.notes ?? null,
        saleVerified: sel.saleVerified ?? false,
        sourceDocumentId: sel.sourceDocumentId ?? null,
      },
    ]);
    try {
      await upsertCompSelection(user.id, resolvedProperty.id, sel);
      loadModule("comps", { force: true });
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not save — please try again."));
      listCompSelections(resolvedProperty.id)
        .then(setCompSelections)
        .catch(() => {});
    }
  }

  async function removeCompSelection(compKey: string) {
    if (!resolvedProperty) return;
    setCompSelections((prev) => prev.filter((s) => s.compKey !== compKey));
    try {
      await deleteCompSelection(resolvedProperty.id, compKey);
      loadModule("comps", { force: true });
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not save — please try again."));
      listCompSelections(resolvedProperty.id)
        .then(setCompSelections)
        .catch(() => {});
    }
  }

  // Marks a module (itemKey omitted) or a specific site-factor/building-
  // component (itemKey set) as not applicable — persists it, updates local
  // state immediately (optimistic — the write above almost never fails, and
  // this is the exact same pattern uploadDocument-adjacent state already
  // uses elsewhere on this page), and force-reloads any module whose prompt
  // depends on this signal so the AI's own text stays consistent with what
  // just changed, not just the client-side display.
  async function markNotApplicable(moduleId: string, itemKey: string = WHOLE_MODULE_KEY) {
    if (!user || !resolvedProperty) return;
    try {
      await markModuleNotApplicable(user.id, resolvedProperty.id, moduleId, itemKey);
      setOverrides((prev) => [
        ...prev.filter((o) => !(o.moduleId === moduleId && o.itemKey === itemKey)),
        { moduleId, itemKey },
      ]);
      reloadDependentModules(moduleId);
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not save — please try again."));
    }
  }

  async function clearNotApplicable(moduleId: string, itemKey: string = WHOLE_MODULE_KEY) {
    if (!resolvedProperty) return;
    try {
      await clearModuleNotApplicable(resolvedProperty.id, moduleId, itemKey);
      setOverrides((prev) =>
        prev.filter((o) => !(o.moduleId === moduleId && o.itemKey === itemKey)),
      );
      reloadDependentModules(moduleId);
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not save — please try again."));
    }
  }

  // Only force-reloads a module that's already loaded (data or error) —
  // never triggers a fresh AI call for a module the user hasn't opened yet,
  // same discipline as every other loadModule() call on this page.
  function reloadDependentModules(moduleId: string) {
    const dependents =
      moduleId === "income"
        ? ["strategy", "executive"]
        : moduleId === "site" || moduleId === "improvement" || moduleId === "zoning"
          ? [moduleId, "strategy", "evidence", "executive"]
          : [moduleId];
    for (const id of dependents) {
      if (moduleData[id]?.data || moduleData[id]?.error) loadModule(id, { force: true });
    }
  }

  // Shared by startProtest (below) and handleUploadEvidence — resolves the real
  // saved PropertyRecord this report is for, creating it on first use if the user
  // hasn't saved it yet. Both actions need a real property_id to attach to.
  async function ensureProperty(): Promise<PropertyRecord | null> {
    if (!user) return null;
    if (resolvedProperty) return resolvedProperty;
    try {
      const property = await addProperty(user.id, {
        address: state.address ?? "",
        cad: state.cad,
        accountNumber: state.accountNumber,
        ownerName: state.ownerName,
        propertyType: state.propertyType,
        landValue: state.landValue,
        improvementValue: state.improvementValue,
        totalValue: state.totalValue,
        taxYear: state.taxYear,
        valueHistory: state.valueHistory,
      });
      setResolvedProperty(property);
      return property;
    } catch (err) {
      console.error("Could not save this property:", err);
      return null;
    }
  }

  // Real, one-click checkout for THIS property, right from the banner below
  // — no detour through /dashboard/properties to find it again. The bracket
  // is already known from the property's own value; only the tier
  // (Owner-Managed vs CorvusPT-Managed) is a real choice only the customer
  // can make, so both real prices are shown rather than picking one. Opens
  // in a new tab (newTab: true) so the report stays put underneath; since
  // this tab never navigates away, the loading state is always released
  // here, not just on the failure path.
  async function handleSubscribeToProperty(tier: Tier) {
    const property = await ensureProperty();
    if (!property) {
      toast.error("Could not save this property. Please try again.");
      return;
    }
    setSubscribingTier(tier);
    try {
      await startPropertyCheckout(property.id, tier, { newTab: true });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not start checkout. Please try again.",
      );
    } finally {
      setSubscribingTier(null);
    }
  }

  async function startProtest() {
    // Real payment gate, not just a hidden/disabled button — startProtest is
    // reachable from more than one place (the banner button below AND
    // onStartProtest passed into the module preview modal), so the check
    // belongs here, once, rather than trusted to whichever caller happens to
    // render a button. myPlan alone isn't enough: it's an account-level
    // signal ("owner_managed" once ANY property is active), so a customer
    // with one paid property could otherwise file a protest on a second,
    // unpaid one — hasFullAccess is the real per-property answer (reads
    // resolvedProperty's own subscriptionStatus; see its own effect above).
    if (!hasFullAccess) {
      toast.error("Subscribe to this property before filing a protest.");
      return;
    }
    const property = await ensureProperty();
    if (!property) return;
    // Owner-managed customers file their own protest — ProtestAuthorizationFlow
    // is the CorvusPT Service Agreement (appoints CorvusPT as agent, 25%
    // contingency fee, "CorvusPT staff will follow up"), the correct flow only
    // for corvusrf_managed. Owner-managed skips straight to a real protest
    // record and their own case, where the real form they'll actually sign is
    // Form 50-132 itself (via File Protest), not an agent appointment.
    if (myPlan === "owner_managed") {
      if (!user) return;
      try {
        const created = await requestProtest(user.id, property.id, {
          address: property.address,
          userEmail: user.email ?? undefined,
          originalValue: property.totalValue,
          taxYear: property.taxYear,
        });
        setExistingProtest(created);
        generateCasePrep(created.id, user.id, property).catch((err) =>
          console.error("Case prep generation failed:", err),
        );
        toast.success("Protest started — let's get your form filed.");
        nav({ to: "/dashboard/case", search: { propertyId: property.id } });
      } catch (err) {
        toast.error(getErrorMessage(err, "Could not start your protest."));
      }
      return;
    }
    setAuthorizing(true);
  }

  // Shared pool across Improvement Condition's evidence upload and Module 2's
  // per-strategy evidence gate (up to 5-6 strategies) — raised from the original
  // 4 (Improvement-only) to give each a realistic amount of headroom.
  const MAX_EVIDENCE_FILES = 8;

  // Takes a plain File[] rather than the FileList straight off an <input> — FileList
  // is a live view of the input, so if the caller clears input.value right after
  // selecting (to allow re-picking the same file later), the FileList empties out
  // before this async function gets around to reading it. Converting to an array in
  // the onChange handler itself, before the input is cleared, avoids that.
  //
  // `strategyId` tags uploads coming from Module 2's per-strategy evidence gate
  // (see StrategyDetail in ModulePreviewBody) with which strategy they satisfy;
  // omitted, it falls back to the original Improvement Condition document type so
  // that module's existing upload flow is unchanged.
  async function handleUploadEvidence(
    files: File[],
    strategyId?: string,
    // Explicit override for a caller that isn't Module 2 (strategyId) or
    // Module 5 (the EVIDENCE_DOCUMENT_TYPE default below) — Module 8's own
    // upload widget passes PROTEST_EVIDENCE_DOCUMENT_TYPE here so its files
    // are tagged the same as CaseDetailModal's evidence-checklist uploads,
    // not lumped in with Improvement Condition's.
    documentTypeOverride?: string,
  ) {
    if (!user) return;
    const property = await ensureProperty();
    if (!property) {
      toast.error("Could not save this property. Please try again.");
      return;
    }
    const room = MAX_EVIDENCE_FILES - evidenceDocs.length;
    if (room <= 0) {
      toast.error(`You can upload up to ${MAX_EVIDENCE_FILES} evidence files per property.`);
      return;
    }
    const toUpload = files.slice(0, room);
    const documentType =
      documentTypeOverride ??
      (strategyId ? `Strategy Evidence: ${strategyId}` : EVIDENCE_DOCUMENT_TYPE);
    setUploadingEvidence(true);
    try {
      const uploaded: DocumentRecord[] = [];
      for (const file of toUpload) {
        if (file.size > UPLOAD_LIMITS.maxFileBytes) {
          toast.error(
            `${file.name} exceeds ${Math.round(UPLOAD_LIMITS.maxFileBytes / (1024 * 1024))} MB.`,
          );
          continue;
        }
        uploaded.push(await uploadDocument(user.id, property.id, file, documentType));
      }
      if (uploaded.length > 0) {
        setEvidenceDocs((prev) => [...prev, ...uploaded]);
        toast.success(`Added ${uploaded.length} evidence file${uploaded.length === 1 ? "" : "s"}.`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not upload evidence.");
    } finally {
      setUploadingEvidence(false);
    }
  }

  // Module 3 — upload one sale document (closing statement / appraisal /
  // contract), read it with extract-comp-sale, and hand the pulled figures
  // back to AddCompForm so the user can confirm them before the comp is
  // saved as verified. Tagged "Comp Sale Evidence" so it's filterable in
  // Documents but kept out of the protest-evidence packet.
  async function extractCompSaleFromFile(file: File): Promise<CompSaleExtraction | null> {
    if (!user) return null;
    const property = await ensureProperty();
    if (!property) {
      toast.error("Could not save this property. Please try again.");
      return null;
    }
    if (file.size > UPLOAD_LIMITS.maxFileBytes) {
      toast.error(
        `${file.name} exceeds ${Math.round(UPLOAD_LIMITS.maxFileBytes / (1024 * 1024))} MB.`,
      );
      return null;
    }
    const doc = await uploadDocument(user.id, property.id, file, "Comp Sale Evidence");
    setEvidenceDocs((prev) => [...prev, doc]);
    return await extractCompSale(doc.id);
  }

  // Free-text fallback for Module 2's per-strategy evidence gate (see
  // StrategyDetail) — persisted the same way the rest of intake state is, via
  // sessionStorage, so it survives a refresh but never leaves the browser.
  function answerStrategy(strategyId: string, answer: string) {
    const next = updateIntake({
      strategyAnswers: { ...(state.strategyAnswers ?? {}), [strategyId]: answer },
    });
    setState(next);
    toast.success("Answer saved.");
  }

  // Powers every module's "Ask AI" box (see ModuleQABox) — grounded in the
  // same record loadModule() sends plus whatever that module has already
  // generated, so an answer never comes from a blank slate.
  async function askQuestion(moduleId: string, question: string): Promise<string> {
    const input: ModuleAnalysisInput = {
      address: state.address,
      cad: state.cad,
      propertyType: state.propertyType,
      landValue: state.landValue,
      improvementValue: state.improvementValue,
      totalValue: state.totalValue,
      taxYear: state.taxYear,
    };
    return askModuleQuestion(moduleId, question, input, moduleData[moduleId]?.data ?? null);
  }

  function loadModule(id: string, opts?: { force?: boolean }) {
    // No AI call backs this module anymore — it renders straight from the
    // deterministic `estimated` value (see estimateSavings() above).
    if (id === "savings") return;
    const existing = moduleData[id];
    if ((existing && (existing.loading || (existing.data && !opts?.force))) || !state.totalValue)
      return;
    setModuleData((prev) => ({ ...prev, [id]: { data: null, loading: true, error: null } }));
    const input: ModuleAnalysisInput = {
      address: state.address,
      cad: state.cad,
      propertyType: state.propertyType,
      landValue: state.landValue,
      improvementValue: state.improvementValue,
      totalValue: state.totalValue,
      taxYear: state.taxYear,
    };

    // Module 2 ("strategy") ranks the same 5 arguments modules 3/4/5/7/6
    // investigate — scoped to just this module's own entry (not the whole
    // ranking) so its prompt gets one clear priority signal, not noise from
    // strategies it has nothing to do with. Only present once Module 2 has
    // resolved — see the eager-load effect's sequencing below.
    const strategyData = moduleData.strategy?.data as ModuleResultMap["strategy"] | undefined;
    if (strategyData) {
      const relevant = strategyData.strategies
        .filter((s) => s.relatedModules.includes(id))
        .map((s) => ({ strategy: s.name, score: s.strengthScore }));
      if (relevant.length > 0) input.priorityContext = relevant;
    }

    // Real, user-confirmed exclusions — see module-overrides.ts. Site/
    // improvement get their own exact factor/component list, hard-clamped
    // server-side (enforceSiteFactorRealData/enforceBuildingComponentRealData);
    // strategy/evidence/executive get prose context only, since their
    // missing-evidence output is free text, not a fixed schema this page
    // could reclamp itself — see notApplicableContext's own comment in the
    // edge function.
    if (id === "site") {
      const na = itemsNotApplicable(overrides, "site");
      if (na.length > 0) input.notApplicableFactors = na;
    }
    if (id === "improvement") {
      const na = itemsNotApplicable(overrides, "improvement");
      if (na.length > 0) input.notApplicableComponents = na;
    }
    if (id === "strategy" || id === "evidence" || id === "executive") {
      const context: string[] = [];
      if (isModuleNotApplicable(overrides, "income")) {
        context.push(
          "Income Approach: user confirmed no P&L, rent roll, or operating statement is " +
            "available for this property.",
        );
      }
      const siteNA = itemsNotApplicable(overrides, "site");
      if (siteNA.length > 0) {
        context.push(`Site Condition: no documentation available for ${siteNA.join(", ")}.`);
      }
      const improvementNA = itemsNotApplicable(overrides, "improvement");
      if (improvementNA.length > 0) {
        context.push(`Improvement Condition: no photo available for ${improvementNA.join(", ")}.`);
      }
      // Module 6's finding flows downstream — comps selection, strategy
      // ranking, evidence needs, and the executive recommendation should all
      // be aware of a zoning/classification discrepancy and, separately,
      // whether it has valuation relevance.
      const zoningData = moduleData.zoning?.data as ModuleResultMap["zoning"] | undefined;
      if (zoningData) {
        const disc = zoningData.discrepancies[0]?.detail ?? "none detected";
        const exempt =
          zoningData.possibleExemptions.length > 0
            ? zoningData.possibleExemptions.join("; ")
            : "none";
        context.push(
          `Zoning & Classification (Module 6): classification looks ${zoningData.matches}. ` +
            `Detected discrepancy: ${disc}. Valuation relevance (separate): ${zoningData.valuationRelevance} ` +
            `Possible exemptions to raise with the ARB: ${exempt}.`,
        );
      }
      if (context.length > 0) input.notApplicableContext = context;
    }

    // Real signals (never fabricated) shared by Module 1 (health) and Module
    // 2 (strategy) — same helpers, same real sources, for both.
    if (id === "health" || id === "strategy") {
      input.compsSummary = buildCompsSummary(compsMap.data);
      input.assessmentRatio = getAssessmentRatioInfo(
        state.cad,
        classifyPropertyCategory(state.propertyType),
      );
      input.valueTrend = buildValueTrend(state.valueHistory);
      if (id === "health") {
        input.valueHistory = (state.valueHistory ?? [])
          .map((h) => ({ year: h.year, total: h.appraisedValue ?? h.marketValue ?? null }))
          .filter((h): h is { year: number; total: number } => h.total != null)
          .sort((a, b) => a.year - b.year);
      }
      input.evidenceFileNames = evidenceDocs.map((d) => d.fileName);
    }

    async function run() {
      if (id === "health") return getHealthScore(input);

      // Grounds the Market Value module's guidance in the real comps already
      // fetched for this property (median/range/count) instead of generic
      // advice — same real signal, same helper, as the Strategy module above.
      // Sends every ranked comp (same computation the modal renders — see
      // computeComparableStats) with a stable key + the user's own
      // exclude marks and any hand-added comps, so the model can recommend
      // the strongest 3-5 and judge each one against the real numbers.
      if (id === "comps") {
        input.compsSummary = buildCompsSummary(compsMap.data);
        const stats = computeComparableStats(
          compsMap.data?.subject ?? null,
          compsMap.data?.comps ?? [],
          state.totalValue,
          {
            excludedKeys: excludedCompKeys(compSelections),
            extraComps: compSelectionsToExtraComps(compSelections),
          },
        );
        if (stats.ranked.length > 0) {
          input.topComps = stats.ranked.slice(0, 25).map((c) => ({
            key: c.key,
            address: c.address || `Property #${c.pid}`,
            distanceMi: c.distanceMi,
            marketValue: c.marketValue,
            similarity: c.similarity,
            excluded: c.excluded,
            userAdded: c.userAdded,
            saleVerified: c.saleVerified ?? undefined,
          }));
        }
        input.compsSubjectValue = stats.subjectValue;
      }

      // Module 4's real point GIS facts, when the sequencing effect above
      // already resolved them for this property's lat/lng — absent
      // entirely, never fabricated, for the counties with no lat/lng at
      // all. See enforceSiteFactorRealData in the edge function for how
      // this gates every factor's status server-side, not just here.
      if (id === "site" && siteGisMap.data) {
        input.siteGis = siteGisMap.data;
      }

      // Module 6 — the real classification/zoning data this app has (the
      // comps subject carries a zoning string for the TrueProdigy counties),
      // the comps' own classifications, and any docs the user uploaded onto
      // a zoning aspect. enforceZoningRealData gates each aspect on these.
      if (id === "zoning") {
        const subj = compsMap.data?.subject ?? null;
        input.zoningData = {
          cadClassification: state.propertyType ?? null,
          cadZoning: subj?.zoning ?? null,
          legalDescription: state.legalDescription ?? null,
          subdivision: state.subdivision ?? null,
          comps: (compsMap.data?.comps ?? []).slice(0, 15).map((c) => ({
            classification: c.propType ?? null,
            zoning: c.zoning ?? null,
          })),
          uploadedDocs: evidenceDocs
            .filter((d) => d.documentType?.startsWith("Zoning: "))
            .map((d) => d.fileName),
        };
      }

      // Module 10 reconciles Modules 2/3/8/9's already-real outputs — see the
      // sequencing effect above that waits for strategy + evidence to settle
      // before this ever fires, so these reads are the real thing, not
      // whatever happened to be in state on the first render.
      if (id === "executive") {
        const strategyData = moduleData.strategy?.data as ModuleResultMap["strategy"] | undefined;
        if (strategyData && strategyData.strategies.length > 0) {
          input.topStrategies = strategyData.strategies.slice(0, 2).map((s) => ({
            name: s.name,
            primaryReason: s.primaryReason,
            strengthScore: s.strengthScore,
            whySelected: s.whySelected,
            existingEvidence: s.existingEvidence,
            missingEvidence: s.missingEvidence,
          }));
        }
        const evidenceData = moduleData.evidence?.data as ModuleResultMap["evidence"] | undefined;
        if (evidenceData) {
          input.evidenceReadiness = {
            criticalMissing: evidenceData.items
              .filter((i) => i.importance === "High" && i.availability === "Low")
              .map((i) => i.item),
            importantMissing: evidenceData.items
              .filter(
                (i) =>
                  !(i.importance === "High" && i.availability === "Low") &&
                  i.availability === "Low",
              )
              .map((i) => i.item),
            uploadedCount: evidenceDocs.length,
          };
        }
        const execStats = computeComparableStats(
          compsMap.data?.subject ?? null,
          compsMap.data?.comps ?? [],
          state.totalValue,
        );
        if (execStats.indicated) {
          input.compsIndicated = {
            min: execStats.indicated.min,
            median: execStats.indicated.median,
            max: execStats.indicated.max,
            gapPct: execStats.valuationGapPct,
            confidencePct: execStats.confidencePct,
          };
        }
        if (savingsEstimate) {
          input.financialSummary = {
            savings: savingsEstimate.amount,
            basis: savingsEstimate.basis,
            reductionPct: savingsEstimate.basis === "formula" ? savingsEstimate.reductionPct : null,
          };
        }
        if (existingProtest && resolvedProperty) {
          const items = getPreFilingCheck(resolvedProperty, existingProtest);
          input.preFilingStatus = {
            missingBlocking: items
              .filter((i) => i.blocking && i.status === "missing")
              .map((i) => i.label),
          };
        }
      }

      // Real typical economic-life range for this property's type (see
      // src/lib/improvement-condition.ts) — always attached, not gated on
      // anything, so the AI's effective-age estimate (when it has real
      // photo grounding for one) is anchored to an honest industry-general
      // figure rather than an unmoored guess.
      if (id === "improvement") {
        input.economicLifeYears = getTypicalEconomicLife(state.propertyType);
      }

      // Improvement Condition reads uploaded evidence (photos/repair estimates/
      // appraisals) back from storage and attaches it so the AI grounds its
      // guidance in what's actually shown rather than only general advice — see
      // handleUploadEvidence() above and ai-report-modules/index.ts's evidence
      // handling. Capped to the 4 most recent, mirroring the server-side cap.
      const improvementDocs = evidenceDocs.filter((d) => d.documentType === EVIDENCE_DOCUMENT_TYPE);
      if (id === "improvement" && improvementDocs.length > 0) {
        const recent = improvementDocs.slice(-4);
        const evidenceImages = await Promise.all(
          recent.map(async (doc) => {
            const url = await getDocumentUrl(doc.storagePath);
            const blob = await fetch(url).then((r) => r.blob());
            const dataUrl = await fileToDataUrl(blob);
            return { mimeType: blob.type || "image/jpeg", dataUrl };
          }),
        );
        return getModuleAnalysis("improvement", { ...input, evidenceImages });
      }
      return getModuleAnalysis(id as BatchModuleId, input);
    }

    run()
      .then((data) =>
        setModuleData((prev) => ({ ...prev, [id]: { data, loading: false, error: null } })),
      )
      .catch((err) =>
        setModuleData((prev) => ({
          ...prev,
          [id]: {
            data: null,
            loading: false,
            error: err instanceof Error ? err.message : "Could not generate this analysis.",
          },
        })),
      );
  }

  // Auto-retry a module that landed in an error state, instead of making the
  // user click "click to view & retry" themselves. invokeEdgeFunction already
  // retries transient 429/504s internally before ever surfacing an error here
  // (see src/lib/edge-functions.ts) — a module reaching this state exhausted
  // that whole budget, which live testing while chasing this same "modules
  // keep erroring" report showed happens during genuinely bad stretches of
  // Gemini congestion (per-call failure rates swinging from ~0% to 50%+
  // minute to minute), not a permanent problem. Capped at AUTO_RETRY_MAX so a
  // truly broken call (missing secret, bad input) doesn't hammer the API
  // forever — the existing manual retry link is still there as the fallback
  // once this budget is spent.
  const autoRetryRef = useRef<
    Record<string, { count: number; timer: ReturnType<typeof setTimeout> | null }>
  >({});
  const AUTO_RETRY_MAX = 3;
  const AUTO_RETRY_DELAY_MS = 6000;
  useEffect(() => {
    for (const [id, entry] of Object.entries(moduleData)) {
      const tracked = autoRetryRef.current[id];
      // A retry attempt itself sets {data: null, loading: true, error: null}
      // — indistinguishable from "never failed" by entry.error alone, which
      // would otherwise hit the branch below and wipe the count this same
      // attempt just incremented, before its outcome is even known (making
      // AUTO_RETRY_MAX effectively unbounded — confirmed by tracing it
      // through). Skip entirely while in flight; only a real settled result
      // (success below, or a fresh error two branches down) should touch
      // tracking.
      if (entry.loading) continue;
      if (!entry.error) {
        // A genuine success — clear tracking so a future failure on this
        // same module gets a fresh retry budget instead of inheriting an
        // old count.
        if (tracked) {
          if (tracked.timer) clearTimeout(tracked.timer);
          delete autoRetryRef.current[id];
        }
        continue;
      }
      if (tracked?.timer) continue; // a retry is already scheduled for this module
      const count = tracked?.count ?? 0;
      if (count >= AUTO_RETRY_MAX) continue;
      const timer = setTimeout(() => {
        autoRetryRef.current[id] = { count: count + 1, timer: null };
        loadModule(id, { force: true });
      }, AUTO_RETRY_DELAY_MS);
      autoRetryRef.current[id] = { count, timer };
    }
    // loadModule is intentionally excluded — same rationale as the eager-load
    // effects elsewhere on this page (it closes over moduleData for its own
    // fetch guard and would otherwise re-fire this effect on every load it
    // itself triggers).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleData]);
  // Cleanup only, run once — cancels any still-pending auto-retry timers if
  // the user navigates away mid-retry rather than letting them fire (and
  // call setModuleData) against an unmounted page. Deliberately reads
  // autoRetryRef.current live inside the cleanup rather than a captured
  // snapshot — this ref isn't a DOM node, it's a running tally that keeps
  // growing for as long as the page is mounted, so the exhaustive-deps
  // warning's usual "copy .current to a variable" fix would only ever see
  // the empty object from right after mount, before any retry was ever
  // scheduled.
  useEffect(() => {
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      for (const entry of Object.values(autoRetryRef.current)) {
        if (entry.timer) clearTimeout(entry.timer);
      }
    };
  }, []);

  function loadCompsMap() {
    if (compsMap.data || compsMap.loading) return;
    setCompsMap({ data: null, loading: true, attempted: true });
    getComps({ cad: state.cad, accountNumber: state.accountNumber })
      .then((data) => setCompsMap({ data, loading: false, attempted: true }))
      .catch(() => setCompsMap({ data: null, loading: false, attempted: true }));
  }

  // Real coordinates for Module 4's map/FEMA-flood/USGS-elevation/highway-
  // rail lookups — the real CAD subject when getComps() has one, otherwise
  // the geocoded fallback below. Neither is ever fabricated: a property with
  // no CAD coordinates AND a failed/no-match geocode simply has none, and
  // Module 4 honestly shows "Additional Data Needed" throughout, same as
  // before this fallback existed.
  const cadSubject = compsMap.data?.subject;
  const siteCoords: GeocodedPoint | null = cadSubject
    ? { lat: cadSubject.latitude, lng: cadSubject.longitude }
    : geocodedSubject.data;
  // True once we know for certain whether real coordinates exist at all —
  // either a CAD subject was there all along, or the geocode fallback has
  // itself settled (found something or genuinely didn't). Lets the firing
  // sequence below wait for a real answer instead of firing "site" with a
  // premature "no data" the instant compsMap alone settles.
  const siteCoordsSettled = !!cadSubject || geocodedSubject.attempted;

  // Only reachable once compsMap has settled with no subject of its own —
  // most counties (see getComps' own comment), so this is the common path,
  // not a rare edge case.
  useEffect(() => {
    if (!compsMap.attempted || compsMap.loading || compsMap.data?.subject) return;
    if (geocodedSubject.attempted || geocodedSubject.loading) return;
    const address = resolvedProperty?.address || state.address;
    if (!address) return;
    setGeocodedSubject({ data: null, loading: true, attempted: false });
    geocodeAddress(address)
      .then((point) => setGeocodedSubject({ data: point, loading: false, attempted: true }))
      .catch(() => setGeocodedSubject({ data: null, loading: false, attempted: true }));
  }, [
    compsMap.attempted,
    compsMap.loading,
    compsMap.data,
    resolvedProperty,
    state.address,
    geocodedSubject.attempted,
    geocodedSubject.loading,
  ]);

  // Real point GIS facts (Module 4) — only ever fetched once compsMap has
  // resolved a real lat/lng (see the firing effect below); most counties
  // have no lat/lng at all yet, in which case this is simply never called
  // and Module 4 honestly shows "Additional Data Needed" throughout.
  // `attempted` (distinct from `loading`) is what lets the sequencing effect
  // below tell "settled, no data" apart from "not started yet" — `loading:
  // false` alone can't, since both the initial and the post-fetch state
  // share it.
  function loadSiteGis(lat: number, lng: number) {
    if (siteGisMap.attempted || siteGisMap.loading) return;
    setSiteGisMap({ data: null, loading: true, attempted: true });
    getSiteGis({ lat, lng })
      .then((data) => setSiteGisMap({ data, loading: false, attempted: true }))
      .catch(() => setSiteGisMap({ data: null, loading: false, attempted: true }));
  }

  useEffect(() => {
    if (!user) {
      setBillingChecked(true);
      return;
    }
    getMyBilling(user.id)
      .then(({ plan }) => {
        setMyPlan(plan);
        // beta and the legacy flat-rate plans (from before the per-property
        // model existed) grant unconditional access from the account plan
        // alone. owner_managed/corvusrf_managed no longer do — each
        // property now has its own independent Stripe subscription (see
        // src/lib/properties.ts), so access for those two plans is fully
        // decided by the effect below instead, keyed on resolvedProperty's
        // own subscriptionStatus — left untouched here (not set to false)
        // so that effect, which runs after this one resolves myPlan, is
        // never raced into briefly reading a stale null plan as "not
        // owner_managed" and skipping its own real check.
        if (plan === "ai_report" || plan === "managed_protest" || plan === "beta") {
          setHasFullAccess(true);
        }
      })
      .catch(() => setHasFullAccess(false))
      .finally(() => setBillingChecked(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Per-property access for owner_managed/corvusrf_managed — confirmed live
  // bug this replaces: the previous version only ever set hasFullAccess to
  // true and never back to false, so once ANY property in a session was
  // found active, it stayed "true" for every OTHER property viewed
  // afterward too (switching from a paid property to a different, unpaid
  // one never revoked access — a real protest got filed on a property that
  // was never paid for). This always recomputes the full real answer from
  // scratch on every resolvedProperty change instead of only ever upgrading
  // it, so switching properties can revoke access, not just grant it. Never
  // touches beta/legacy plans (guarded by myPlan), which effect above
  // already decided unconditionally.
  useEffect(() => {
    if (myPlan !== "owner_managed" && myPlan !== "corvusrf_managed") return;
    setHasFullAccess(resolvedProperty?.subscriptionStatus === "active");
  }, [myPlan, resolvedProperty]);

  // Auto-opens a module for a deep link (CaseDetailModal's "Upload Evidence —
  // Go to Module 8" button, ?openModule=evidence) — waits for billingChecked
  // so a paying customer never sees a flash of the paywall first, and only
  // ever fires once (openId stays whatever the user does with it after).
  const [deepLinkHandled, setDeepLinkHandled] = useState(false);
  useEffect(() => {
    if (!deepLinkModuleId || deepLinkHandled || !billingChecked) return;
    const target = MODULES.find((m) => m.id === deepLinkModuleId);
    if (target) openModule(target);
    setDeepLinkHandled(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkModuleId, deepLinkHandled, billingChecked, hasFullAccess]);

  // The exact same estimateSavings() call the intake savings screen uses (see
  // savings-estimate.ts) — comps tier first, then the formula tier (base rate +
  // real assessment-ratio + real 10-year value-trend adjustments). Previously
  // this page reimplemented a simplified version (base rate only, no
  // adjustments) and could additionally have this number overridden by a
  // Gemini-guessed percentage once the Savings module was opened — the same
  // property could show two different, and non-deterministic, savings figures
  // depending on which page you were on. Calling the one real function here
  // instead means this page and the intake flow always agree for the same
  // property, and the number never depends on an AI call.
  const [savingsEstimate, setSavingsEstimate] =
    useState<Awaited<ReturnType<typeof estimateSavings>>>(null);
  useEffect(() => {
    if (!state.totalValue) return;
    estimateSavings({
      cad: state.cad,
      accountNumber: state.accountNumber,
      address: state.address,
      propertyType: state.propertyType,
      landValue: state.landValue,
      improvementValue: state.improvementValue,
      totalValue: state.totalValue,
      taxYear: state.taxYear,
      valueHistory: state.valueHistory,
    })
      .then(setSavingsEstimate)
      .catch((err) => console.error("Savings estimate failed:", err));
  }, [
    state.totalValue,
    state.cad,
    state.accountNumber,
    state.address,
    state.propertyType,
    state.landValue,
    state.improvementValue,
    state.taxYear,
    state.valueHistory,
  ]);

  const estimated = useMemo(() => {
    if (!savingsEstimate || !state.totalValue)
      return { reduction: 0, savings: 0, rationale: null as string | null, effectiveTaxRatePct: 0 };
    if (savingsEstimate.basis === "comps") {
      return {
        reduction: Math.max(0, state.totalValue - savingsEstimate.compsMedian),
        savings: savingsEstimate.amount,
        rationale: `Estimated from ${savingsEstimate.compsCount} real comparable properties, at your county's ~${savingsEstimate.effectiveTaxRatePct}% effective tax rate.`,
        effectiveTaxRatePct: savingsEstimate.effectiveTaxRatePct,
      };
    }
    return {
      reduction: Math.round(state.totalValue * (savingsEstimate.reductionPct / 100)),
      savings: savingsEstimate.amount,
      rationale: savingsEstimate.rationale,
      effectiveTaxRatePct: savingsEstimate.effectiveTaxRatePct,
    };
  }, [savingsEstimate, state.totalValue]);
  // Drives the analysis banner's hero savings figure sizing below — the
  // formatted string's own length, not viewport width, since a large enough
  // property can produce a 6+ digit savings figure on any screen size.
  const savingsDigits = useMemo(() => currency(estimated.savings).length, [estimated.savings]);

  // Eager-loads real data for the module overview grid below (real scores,
  // checklists, etc. instead of generic teaser text) as soon as the property
  // is known. Free-preview modules (1-3) load for everyone; the rest only
  // once hasFullAccess resolves true, so a signed-out visitor or an
  // unsubscribed user never burns an AI call analyzing a module they can't
  // see yet — they still get the same "Subscribe to unlock" card either way.
  // "savings" needs no call (estimateSavings() above already runs
  // unconditionally) and "income" needs user-uploaded data that doesn't
  // exist yet, so both are skipped here exactly like loadModule() itself
  // already skips "savings".
  // comps/site/improvement/zoning investigate the exact 5 strategies Module 2
  // ranks, so they're sequenced to fire after it (see the effect below) rather
  // than in this immediate batch, which is why they're excluded here.
  const SEQUENCED_AFTER_STRATEGY = new Set(["comps", "site", "improvement", "zoning"]);
  // Module 10 (executive) reconciles Module 2's strategy AND Module 8's
  // evidence — firing it in this same immediate batch (as it did before this
  // sequencing was added) meant its own AI call went out before either had
  // resolved, reading moduleData.strategy/evidence as still undefined. See
  // the dedicated effect below.

  useEffect(() => {
    if (!state.totalValue) return;
    for (const m of MODULES) {
      if (
        m.id === "savings" ||
        m.id === "income" ||
        m.id === "executive" ||
        SEQUENCED_AFTER_STRATEGY.has(m.id)
      )
        continue;
      if (m.n <= FREE_MODULE_COUNT || hasFullAccess) loadModule(m.id);
    }
    // loadModule closes over moduleData for its own-fetch guard, which is
    // exactly why it's left out of this dependency list — including it would
    // re-fire this effect (and, via the loading-state update inside
    // loadModule, immediately re-fire itself again) on every single module's
    // own load, an infinite loop just like the hub doors' entrance-animation
    // bug earlier. Property identity and access level are the only real
    // triggers for "should we start loading modules."
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.totalValue, hasFullAccess]);

  // comps/site/improvement/zoning wait for Module 2 (Strategy) to resolve —
  // or a capped 6s timeout, so a slow/failed Strategy call never stalls the
  // rest of the page indefinitely — before firing, so loadModule() above can
  // attach Module 2's per-strategy score as priorityContext to each. Also
  // kicks off the comps map fetch immediately (unsequenced): it's not an AI
  // call, and Module 2 itself wants compsSummary as an input when available.
  useEffect(() => {
    if (!state.totalValue) return;
    loadCompsMap();
    if (siteCoords) loadSiteGis(siteCoords.lat, siteCoords.lng);
    const strategyState = moduleData.strategy;
    const fire = () => {
      for (const id of SEQUENCED_AFTER_STRATEGY) {
        // "comps" specifically also wants compsMap.data already populated
        // (see loadModule()'s own comps branch, which sends real topComps
        // for the Recommended Protest Use field) — loadCompsMap() right
        // above is fire-and-forget, so without this check "comps" could
        // fire in the very same tick as loadCompsMap() itself, well before
        // that fetch resolves (confirmed live: compsMap.data was still null
        // at the exact moment this ran). compsMap.loading is in the
        // dependency array below specifically so this effect re-runs once
        // that fetch actually settles, giving "comps" a second real chance
        // to fire with real data instead of silently going out ungrounded.
        if (id === "comps" && compsMap.loading) continue;
        // "site" needs real coordinates settled (either a CAD subject or the
        // geocode fallback — see siteCoordsSettled above) AND, only when
        // coordinates actually exist, siteGisMap itself settled too —
        // otherwise it could fire while the GIS fetch is merely not-yet-
        // started instead of genuinely unavailable, and Module 4 would show
        // "Additional Data Needed" for something that was actually about to
        // resolve. `!siteGisMap.attempted` (not `siteGisMap.loading`) is the
        // right check here — `loading` is also false before the fetch
        // starts, so it can't tell "not started" apart from "settled" on
        // its own.
        if (
          id === "site" &&
          (compsMap.loading ||
            !siteCoordsSettled ||
            (!!siteCoords && (!siteGisMap.attempted || siteGisMap.loading)))
        ) {
          continue;
        }
        const m = MODULES.find((mm) => mm.id === id);
        if (m && (m.n <= FREE_MODULE_COUNT || hasFullAccess)) loadModule(m.id);
      }
    };
    if (strategyState?.data || strategyState?.error) {
      fire();
      return;
    }
    const t = setTimeout(fire, 6000);
    return () => clearTimeout(t);
    // Same rationale as the effect above for omitting loadModule/loadCompsMap/
    // loadSiteGis; moduleData.strategy's data/error (plus compsMap.loading/
    // .data, geocodedSubject's own settle state, and siteGisMap's own settle
    // state, for the races described above) are read explicitly instead of
    // the whole moduleData/compsMap/siteGisMap objects so this only re-fires
    // on those specific state transitions, not every other module's load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.totalValue,
    hasFullAccess,
    moduleData.strategy?.data,
    moduleData.strategy?.error,
    compsMap.loading,
    compsMap.data,
    geocodedSubject.attempted,
    geocodedSubject.loading,
    geocodedSubject.data,
    siteGisMap.attempted,
    siteGisMap.loading,
  ]);

  // Module 10 (executive) reconciles Module 2's strategy and Module 8's
  // evidence into one final recommendation — it needs to actually read their
  // real output, so it waits for both to settle (data or error) before firing
  // its own call, same 6s-capped-timeout pattern as the comps/strategy effect
  // above (a slow/failed dependency shouldn't stall Module 10 indefinitely).
  useEffect(() => {
    if (!state.totalValue || !hasFullAccess) return;
    const strategyState = moduleData.strategy;
    const evidenceState = moduleData.evidence;
    const strategyDone = !!(strategyState?.data || strategyState?.error);
    const evidenceDone = !!(evidenceState?.data || evidenceState?.error);
    if (strategyDone && evidenceDone) {
      loadModule("executive");
      return;
    }
    const t = setTimeout(() => loadModule("executive"), 6000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.totalValue,
    hasFullAccess,
    moduleData.strategy?.data,
    moduleData.strategy?.error,
    moduleData.evidence?.data,
    moduleData.evidence?.error,
  ]);

  function openModule(m: Module) {
    if (hasFullAccess || m.n <= FREE_MODULE_COUNT) {
      setOpenId(m.id);
      if (!m.requiresUserData) loadModule(m.id);
      if (m.id === "comps") loadCompsMap();
      return;
    }
    setShowWall(true);
  }

  const openModel = MODULES.find((m) => m.id === openId) ?? null;

  return (
    <div className="container-page py-10">
      {/* Summary */}
      <section className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="card-elev p-6">
          <div className="flex items-center gap-2">
            <span className="badge-soft">Property Summary</span>
            <span className="text-xs text-muted-foreground">Source: Official CAD Record</span>
          </div>
          <h1 className="mt-3 font-serif text-3xl font-semibold">{state.address}</h1>
          <p className="text-muted-foreground text-sm">{state.cad}</p>
          <dl className="mt-5 grid gap-3 sm:grid-cols-3 text-sm">
            <Field label="Owner" value={state.ownerName} />
            <Field label="Account #" value={state.accountNumber} />
            <Field label="Type" value={state.propertyType} />
            <Field label="Land" value={currency(state.landValue)} />
            <Field label="Improvement" value={currency(state.improvementValue)} />
            <Field label="Total" value={currency(state.totalValue)} bold />
          </dl>
          <ValueHistorySection history={state.valueHistory ?? []} />
        </div>
        <div className="card-elev overflow-hidden">
          <iframe
            title="Property Map"
            className="w-full h-64 lg:h-full min-h-[240px]"
            src={`https://www.google.com/maps?q=${encodeURIComponent(state.address ?? "Texas")}&output=embed`}
            loading="lazy"
          />
        </div>
      </section>

      {/* Analysis banner — the savings figure is the whole point of this page for
          most visitors, so it gets a hero-scale treatment (was the same text-lg
          size as the "AI analysis completed" label above it, easy to skim past)
          rather than reading as one more line of body copy. Previously had
          continuous confetti bursts here; removed per explicit feedback that
          it read as cartoonish for what's otherwise a professional tax-filing
          tool — the gradient/glow/sheen surface below carries the "this is a
          good moment" read on its own, without particle animation. */}
      <section className="relative mt-6 card-elev overflow-hidden text-primary-foreground">
        {/* Richer than a flat bg-primary fill — a diagonal gradient with a
            faint accent-green undertone, so the banner reads as an
            intentionally celebratory surface even before any motion kicks in. */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(135deg, var(--primary) 0%, color-mix(in oklch, var(--primary) 82%, var(--accent) 18%) 50%, var(--primary) 100%)",
          }}
        />
        {/* Two ambient glow blobs — a flat solid-navy card read as plain/
            static for what's meant to be the page's one exciting moment.
            Emerald top-left near the number, warm gold bottom-right (offset
            pulse timing via the CSS itself), both z-0'd behind the real
            content below. */}
        {!analyzing && (
          <>
            <div
              className="savings-glow pointer-events-none absolute -left-24 -top-24 z-0 h-96 w-96 rounded-full"
              style={{
                background:
                  "radial-gradient(circle, color-mix(in oklch, var(--accent) 55%, transparent) 0%, transparent 70%)",
              }}
            />
            <div
              className="savings-glow-warm pointer-events-none absolute -bottom-24 -right-24 z-0 h-96 w-96 rounded-full"
              style={{
                background:
                  "radial-gradient(circle, color-mix(in oklch, var(--warning) 50%, transparent) 0%, transparent 70%)",
              }}
            />
            {/* Slow diagonal light sweep across the whole banner surface —
                see the savings-sheen-sweep keyframe in styles.css. */}
            <div className="savings-sheen pointer-events-none absolute -inset-y-12 left-0 z-0 w-1/3 bg-white/10" />
          </>
        )}
        <div className="relative z-10 flex flex-wrap items-start justify-between gap-6 p-5 sm:p-8">
          <div className="min-w-0">
            <p className="text-sm text-primary-foreground/80">
              {analyzing ? "AI is analyzing your property..." : "AI analysis completed."}
            </p>
            {analyzing ? (
              <p className="mt-1 font-serif text-lg sm:text-xl">
                Preparing your property valuation review...
              </p>
            ) : estimated.savings >= 1 ? (
              <>
                <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-primary-foreground/70">
                  Estimated tax savings this year
                </p>
                {/* Sized off the actual formatted string's length, not just the
                    viewport — a fixed text-6xl/7xl/8xl scale (confirmed live)
                    clips off-card on a narrow phone once a large property's
                    savings run to 6+ digits ("$135,675" and up), since a wider
                    viewport can't be assumed to always mean a shorter number.
                    Common case (the vast majority of real properties) still
                    gets the full hero size below. */}
                <p
                  className={`mt-1 flex w-fit items-center gap-2 font-serif font-bold leading-none text-accent ${
                    savingsDigits <= 7
                      ? "text-6xl sm:text-7xl lg:text-8xl"
                      : savingsDigits <= 9
                        ? "text-5xl sm:text-6xl lg:text-7xl"
                        : "text-4xl sm:text-5xl lg:text-6xl"
                  }`}
                >
                  <TrendingUp className="h-8 w-8 shrink-0 sm:h-10 sm:w-10 lg:h-14 lg:w-14" />
                  <AnimatedNumber value={estimated.savings} format={currency} duration={900} />
                </p>
              </>
            ) : (
              // Same reasoning as intake.tsx's Savings step — a real analysis
              // that lands on (near-)$0 isn't a failure, it means this
              // property's own assessed value already looks in line with real
              // comps/protest-outcome data. >= 1, not > 0: currency() rounds
              // to whole dollars, so a positive-but-sub-$1 amount would
              // otherwise still render as a bare, confusing "$0" hero.
              <>
                <p className="mt-2 font-serif text-2xl font-bold text-accent sm:text-3xl">
                  Good news!
                </p>
                <p className="mt-2 max-w-md text-sm text-primary-foreground/80">
                  Your property appears to be fairly assessed. We found little or no opportunity for
                  additional tax savings this year.
                </p>
              </>
            )}
          </div>
          <div className="print:hidden shrink-0 text-right text-sm">
            {hasFullAccess ? (
              <div className="text-primary-foreground/70 text-xs">
                AI Report subscription active
              </div>
            ) : (
              <>
                <div>
                  {FREE_MODULE_COUNT} of {MODULES.length} modules free
                </div>
                <div className="text-primary-foreground/70 text-xs">
                  Subscribe to unlock the rest
                </div>
              </>
            )}
          </div>
        </div>
        {user && (
          <div className="relative z-10 border-t border-primary-foreground/20 px-5 pb-5 pt-3 print:hidden sm:px-8 sm:pb-8">
            {existingProtest ? (
              <div className="flex items-center gap-3">
                <span className="badge-soft">
                  Protest {existingProtest.status.replace("_", " ")}
                </span>
                {resolvedProperty && (
                  <Link
                    to="/dashboard/case"
                    search={{ propertyId: resolvedProperty.id }}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-outline border-white/30 text-primary-foreground hover:bg-background/10 text-sm py-1.5"
                  >
                    View Case
                  </Link>
                )}
              </div>
            ) : hasFullAccess ? (
              <button onClick={startProtest} className="btn-accent text-sm py-1.5">
                {myPlan === "owner_managed" ? "File Protest" : "Request Protest Filing"}
              </button>
            ) : (
              // Real payment gate (see startProtest's own check) reflected
              // honestly here — real, one-click checkout for THIS property
              // right in the banner, not a dead-end link to go find it again
              // on the Properties list. The bracket is already known from
              // the property's own value; only the tier is a real choice,
              // so both real prices are shown.
              <div className="flex flex-wrap gap-2">
                {(["owner_managed", "corvusrf_managed"] as const).map((tier) => {
                  const bracket = bracketForValue(resolvedProperty?.totalValue ?? state.totalValue);
                  return (
                    <button
                      key={tier}
                      disabled={!!subscribingTier}
                      onClick={() => handleSubscribeToProperty(tier)}
                      className="btn-accent text-sm py-1.5 disabled:opacity-60"
                    >
                      {subscribingTier === tier
                        ? "Redirecting…"
                        : `Subscribe — ${tier === "owner_managed" ? "Owner-Managed" : "CorvusPT-Managed"} $${formatMoney(TIER_BRACKET_PRICES[tier][bracket])}/mo`}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </section>

      {/* Modules */}
      <section className="mt-8 print:hidden">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-serif text-2xl font-semibold">10 Premium AI Modules</h2>
          <button onClick={() => window.print()} className="btn-outline text-sm py-2">
            Export Report
          </button>
        </div>
        <p className="text-muted-foreground text-sm">
          {hasFullAccess
            ? "All modules unlocked with your AI Report subscription."
            : `Modules 1-${FREE_MODULE_COUNT} are free for everyone. Subscribe to unlock modules ${FREE_MODULE_COUNT + 1}-${MODULES.length}.`}
        </p>
        <div className="mt-5 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {MODULES.map((m) => (
            <ModuleCard
              key={m.id}
              m={m}
              unlocked={hasFullAccess || m.n <= FREE_MODULE_COUNT}
              hasFullAccess={hasFullAccess}
              moduleState={moduleData[m.id]}
              moduleData={moduleData}
              compsMap={compsMap}
              siteGisMap={siteGisMap}
              siteCoords={siteCoords}
              estimated={estimated}
              propertyType={state.propertyType}
              totalValue={state.totalValue}
              improvementValue={state.improvementValue}
              overrides={overrides}
              onOpen={() => openModule(m)}
              onForceReload={() => loadModule(m.id, { force: true })}
            />
          ))}
        </div>
      </section>

      {/* Print-only linear report — reuses the exact same module-rendering logic as
          the modal above (ModulePreviewBody), stacking every module the user has
          already unlocked and viewed into one printable document. Deliberately
          does NOT trigger new AI calls at export time (no re-fetch here) — export
          captures "your report so far," the same content already shown on screen,
          rather than firing up to 9 fresh AI calls the moment someone clicks print. */}
      <section className="hidden print:block mt-8">
        <h2 className="font-serif text-2xl font-semibold">AI Property Tax Report</h2>
        <p className="text-sm text-muted-foreground">
          {state.address} · {state.cad} · Generated {new Date().toLocaleDateString()}
        </p>
        {(() => {
          const printable = MODULES.filter(
            (m) => moduleData[m.id]?.data != null || (m.id === "comps" && compsMap.data),
          );
          if (printable.length === 0) {
            return (
              <p className="mt-4 text-sm text-muted-foreground">
                Open a module above, then use Export Report again to include it here.
              </p>
            );
          }
          return printable.map((m) => (
            <div key={m.id} className="mt-6" style={{ breakInside: "avoid" }}>
              <h3 className="font-serif text-lg font-semibold">{m.shortName}</h3>
              <div className="text-xs font-medium text-muted-foreground">{m.title}</div>
              <p className="text-sm text-muted-foreground">{m.question}</p>
              <ModulePreviewBody
                m={m}
                estimated={estimated}
                state={state}
                moduleState={moduleData[m.id]}
                moduleData={moduleData}
                compsMap={compsMap}
                siteGisMap={siteGisMap}
                siteCoords={siteCoords}
                onRetry={() => {}}
                allowEvidenceUpload={false}
                evidenceDocs={evidenceDocs}
                uploadingEvidence={false}
                onUploadEvidence={() => {}}
                onForceReload={() => {}}
                onAnswerStrategy={() => {}}
                onAskQuestion={() => Promise.resolve("")}
                existingProtest={null}
                resolvedProperty={null}
                onOpenModule={() => {}}
                onStartProtest={() => {}}
                onViewCase={() => {}}
                overrides={overrides}
                onMarkNotApplicable={() => {}}
                onClearNotApplicable={() => {}}
                compSelections={compSelections}
                onSaveCompSelection={() => {}}
                onRemoveCompSelection={() => {}}
                onExtractCompSale={async () => null}
              />
            </div>
          ));
        })()}
      </section>

      {/* Preview modal */}
      {openModel && (
        <Modal onClose={() => setOpenId(null)} wide>
          <span className="badge-soft">{hasFullAccess ? "Unlocked" : "Free Preview"}</span>
          <div className="mt-2 flex items-center gap-2">
            <NumberBadge n={openModel.n} color={openModel.color} size="lg" />
            <h3 className="font-serif text-2xl font-semibold">{openModel.shortName}</h3>
          </div>
          <div className="text-sm font-medium text-muted-foreground">{openModel.title}</div>
          <p className="text-muted-foreground">{openModel.question}</p>
          <ModulePreviewBody
            m={openModel}
            estimated={estimated}
            state={state}
            moduleState={moduleData[openModel.id]}
            moduleData={moduleData}
            compsMap={compsMap}
            siteGisMap={siteGisMap}
            siteCoords={siteCoords}
            onRetry={() => loadModule(openModel.id)}
            allowEvidenceUpload
            evidenceDocs={evidenceDocs}
            uploadingEvidence={uploadingEvidence}
            onUploadEvidence={handleUploadEvidence}
            onForceReload={() => loadModule(openModel.id, { force: true })}
            onAnswerStrategy={answerStrategy}
            onAskQuestion={askQuestion}
            existingProtest={existingProtest}
            resolvedProperty={resolvedProperty}
            onOpenModule={(id) => {
              const target = MODULES.find((mm) => mm.id === id);
              if (target) openModule(target);
            }}
            onStartProtest={startProtest}
            onViewCase={() => {
              if (!resolvedProperty) return;
              // Same-window navigation (per product direction) — opening it
              // in a new tab left two tabs that each reloaded on focus.
              nav({ to: "/dashboard/case", search: { propertyId: resolvedProperty.id } });
            }}
            overrides={overrides}
            onMarkNotApplicable={markNotApplicable}
            onClearNotApplicable={clearNotApplicable}
            compSelections={compSelections}
            onSaveCompSelection={saveCompSelection}
            onRemoveCompSelection={removeCompSelection}
            onExtractCompSale={extractCompSaleFromFile}
          />
          <div className="mt-6 flex gap-2 justify-end">
            <button onClick={() => setOpenId(null)} className="btn-outline">
              Return to Property Summary
            </button>
            {!hasFullAccess && (
              <Link to="/pricing" className="btn-accent">
                Subscribe & Unlock Full Report
              </Link>
            )}
          </div>
        </Modal>
      )}

      {/* Subscription wall */}
      {showWall && (
        <Modal onClose={() => setShowWall(false)}>
          <h3 className="font-serif text-2xl font-semibold">
            Unlock Your Complete AI Property Analysis
          </h3>
          <p className="text-muted-foreground mt-2">
            Modules 1-{FREE_MODULE_COUNT} are free to preview. Subscribe to unlock modules{" "}
            {FREE_MODULE_COUNT + 1}-{MODULES.length} and the complete property analysis.
          </p>
          <div className="mt-6 grid gap-2 sm:grid-cols-2">
            <Link to="/pricing" className="btn-accent">
              Subscribe & Unlock Full Report
            </Link>
            <Link to="/pricing" className="btn-outline">
              Compare Plans
            </Link>
            <button onClick={() => setShowWall(false)} className="btn-outline sm:col-span-2">
              Return to Property Summary
            </button>
          </div>
        </Modal>
      )}

      {authorizing && user && resolvedProperty && (
        <ProtestAuthorizationFlow
          userId={user.id}
          property={resolvedProperty}
          userEmail={user.email}
          isPaid={hasFullAccess}
          open={authorizing}
          onOpenChange={(open) => setAuthorizing(open)}
          onDone={(created) => {
            setExistingProtest(created);
            generateCasePrep(created.id, user.id, resolvedProperty).catch((err) =>
              console.error("Case prep generation failed:", err),
            );
          }}
        />
      )}
    </div>
  );
}

function ModuleCard({
  m,
  unlocked,
  hasFullAccess,
  moduleState,
  moduleData,
  compsMap,
  siteGisMap,
  siteCoords,
  estimated,
  propertyType,
  totalValue,
  improvementValue,
  overrides,
  onOpen,
  onForceReload,
}: {
  m: Module;
  unlocked: boolean;
  hasFullAccess: boolean;
  moduleState: ModuleAsyncState | undefined;
  moduleData: Record<string, ModuleAsyncState>;
  compsMap: { data: CompsResult | null; loading: boolean };
  siteGisMap: { data: SiteGisResult | null; loading: boolean };
  siteCoords: GeocodedPoint | null;
  estimated: {
    reduction: number;
    savings: number;
    rationale: string | null;
    effectiveTaxRatePct: number;
  };
  propertyType?: string;
  totalValue?: number | null;
  improvementValue?: number | null;
  overrides: ModuleOverride[];
  onOpen: () => void;
  onForceReload: () => void;
}) {
  // Reflects what's actually happening now that the grid eager-loads real
  // data (see the effect above Report()), not the old static per-module
  // metadata — "Completed" used to show even for a module nobody had opened
  // yet, before it had actually run.
  const status: CardStatus = !unlocked
    ? "Locked"
    : m.id === "income"
      ? isModuleNotApplicable(overrides, "income")
        ? "Not Applicable"
        : "Needs Data"
      : m.id === "savings"
        ? "Completed"
        : !moduleState || moduleState.loading
          ? "Analyzing"
          : moduleState.error
            ? "Error"
            : "Completed";
  const insight = unlocked
    ? moduleInsight(m, moduleState, compsMap, estimated, totalValue, overrides)
    : null;
  // Module 2's own score for this module's strategy, once it's resolved — see
  // the priorityContext sequencing in loadModule()/the eager-load effects
  // above. Only comps/site/improvement/income/zoning map to one of Module 2's
  // 5 fixed strategies; other modules never show this badge.
  const strategyData = moduleData.strategy?.data as ModuleResultMap["strategy"] | undefined;
  const priorityScore = strategyData?.strategies.find((s) =>
    s.relatedModules.includes(m.id),
  )?.strengthScore;
  return (
    <div className="card-elev overflow-hidden flex flex-col">
      <div className="p-5 flex-1 flex flex-col">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <NumberBadge n={m.n} color={m.color} size="lg" />
            {/* Wraps instead of truncating — confirmed live on a narrow
                mobile card that even the already-shortened names ("Zoning &
                Classification", "Executive Protest Report") still don't fit
                one line alongside the status chip/refresh button, and
                ellipsis-cutting a module's own name reads far worse than two
                short lines. Every real shortName is only 2-4 words, so this
                only ever wraps on the rare tight case, not routinely. */}
            <h3 className="min-w-0 font-serif text-sm font-bold uppercase tracking-wide">
              {m.shortName}
            </h3>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {priorityScore != null && (
              <span
                className="whitespace-nowrap text-[10px] font-semibold"
                style={{ color: scoreColor(priorityScore) }}
                title="Strategy module's priority ranking for this argument"
              >
                Priority {priorityScore}
              </span>
            )}
            <StatusChip status={status} />
            {/* Hidden for a locked/gated card (nothing to refetch), "Needs
                Data"/"Not Applicable" (income — that's a P&L upload gate,
                not an AI call this page ever fires, whether or not the user
                has marked it not applicable), and "savings" (deterministic,
                no AI call at all — loadModule() no-ops for it). Spins in
                place, doubling as the loading indicator the user asked for,
                and doubles as a one-click retry for a genuinely slow/stuck
                module without having to open the modal's own Retry
                button. */}
            {unlocked &&
              m.id !== "savings" &&
              status !== "Locked" &&
              status !== "Needs Data" &&
              status !== "Not Applicable" && (
                <button
                  type="button"
                  onClick={onForceReload}
                  disabled={status === "Analyzing"}
                  title={status === "Analyzing" ? "Analyzing…" : "Refresh this module"}
                  aria-label={status === "Analyzing" ? "Analyzing" : "Refresh this module"}
                  className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:cursor-default disabled:hover:bg-transparent"
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${status === "Analyzing" ? "animate-spin" : ""}`}
                  />
                </button>
              )}
          </div>
        </div>
        <div className="mt-4 flex-1 flex flex-col justify-center">
          <ModuleVisual
            m={m}
            unlocked={unlocked}
            moduleState={moduleState}
            moduleData={moduleData}
            compsMap={compsMap}
            siteGisMap={siteGisMap}
            siteCoords={siteCoords}
            estimated={estimated}
            propertyType={propertyType}
            totalValue={totalValue}
            improvementValue={improvementValue}
            overrides={overrides}
            onOpen={onOpen}
          />
        </div>
      </div>
      {insight && <InsightBanner text={insight} color={m.color} onClick={onOpen} />}
      <div className="px-5 pb-5 pt-3 flex items-center justify-between gap-2">
        {hasFullAccess ? (
          <span className="text-xs font-medium text-success">Included in your plan</span>
        ) : unlocked ? (
          <span className="text-xs font-medium text-success">Free preview</span>
        ) : (
          <span className="text-xs text-muted-foreground">Requires subscription</span>
        )}
        {/* The colored insight band above is the big affordance; this stays
            as the explicit, always-present control — a subtle text link for
            an unlocked module, the real "Subscribe" CTA for a locked one. */}
        {unlocked ? (
          <button
            onClick={onOpen}
            className="inline-flex items-center gap-1 text-sm font-semibold text-accent hover:underline"
          >
            Open <ArrowRight className="h-3.5 w-3.5" />
          </button>
        ) : (
          <button onClick={onOpen} className="btn-outline text-sm py-2">
            Subscribe to unlock
          </button>
        )}
      </div>
    </div>
  );
}

type CardStatus = "Locked" | "Analyzing" | "Completed" | "Needs Data" | "Not Applicable" | "Error";

function StatusChip({ status }: { status: CardStatus }) {
  const map: Record<CardStatus, string> = {
    Locked: "bg-secondary text-muted-foreground",
    Analyzing: "bg-secondary text-muted-foreground",
    Completed: "bg-success/15 text-success",
    "Needs Data": "bg-warning/20 text-warning-foreground",
    "Not Applicable": "bg-secondary text-muted-foreground",
    Error: "bg-destructive/10 text-destructive",
  };
  return (
    <span
      className={`text-[10px] font-semibold px-2 py-1 rounded-full whitespace-nowrap ${map[status]}`}
    >
      {status}
    </span>
  );
}

// The small, glanceable visual each overview card shows in place of the old
// paragraph of teaser text — real data once loaded (see the eager-load
// effect above Report()), a skeleton while it's in flight, and a lock
// (never a fetch attempt) for gated modules nobody has subscribed to yet.
function ModuleVisual({
  m,
  unlocked,
  moduleState,
  moduleData,
  compsMap,
  siteGisMap,
  siteCoords,
  estimated,
  propertyType,
  totalValue,
  improvementValue,
  overrides,
  onOpen,
}: {
  m: Module;
  unlocked: boolean;
  moduleState: ModuleAsyncState | undefined;
  moduleData: Record<string, ModuleAsyncState>;
  compsMap: { data: CompsResult | null; loading: boolean };
  siteGisMap: { data: SiteGisResult | null; loading: boolean };
  siteCoords: GeocodedPoint | null;
  estimated: {
    reduction: number;
    savings: number;
    rationale: string | null;
    effectiveTaxRatePct: number;
  };
  propertyType?: string;
  totalValue?: number | null;
  improvementValue?: number | null;
  overrides: ModuleOverride[];
  onOpen: () => void;
}) {
  if (!unlocked) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Lock className="h-4 w-4 shrink-0" />
        <span className="text-xs">Subscribe to see this analysis</span>
      </div>
    );
  }

  if (m.id === "savings") {
    return (
      <div className="grid gap-1.5">
        <FormulaChain
          reduction={estimated.reduction}
          ratePct={estimated.effectiveTaxRatePct}
          savings={estimated.savings}
        />
        {estimated.savings > 0 && <CostBenefitRow savings={estimated.savings} />}
      </div>
    );
  }

  if (m.id === "income") {
    return isModuleNotApplicable(overrides, "income") ? (
      <div className="flex items-center gap-2 text-muted-foreground">
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        <span className="text-xs">Marked not applicable — excluded from this protest</span>
      </div>
    ) : (
      <div className="flex items-center gap-2 text-muted-foreground">
        <FileWarning className="h-4 w-4 shrink-0" />
        <span className="text-xs">Upload financials to run this analysis</span>
      </div>
    );
  }

  if (m.id === "comps" && compsMap.data?.comps.length) {
    const stats = computeComparableStats(compsMap.data.subject, compsMap.data.comps, totalValue);
    return (
      <div>
        <div className="flex items-baseline gap-1.5">
          <span className="font-serif text-xl font-bold">{compsMap.data.comps.length}</span>
          <span className="text-xs text-muted-foreground">comparable properties found nearby</span>
        </div>
        <div className="mt-3">
          <CompsValueScatter
            subject={compsMap.data.subject}
            subjectValue={stats.subjectValue}
            comps={stats.ranked}
          />
        </div>
        {stats.limitedData ? (
          <div className="mt-3 rounded-md bg-warning/15 px-2 py-1 text-[11px] text-warning-foreground">
            Limited Comparable Data
          </div>
        ) : (
          stats.indicated && (
            <>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <div className="rounded-lg bg-success/10 px-2 py-2 text-center">
                  <div className="text-[9px] font-medium uppercase tracking-wide text-success">
                    Market Value Range
                  </div>
                  <div className="mt-0.5 truncate text-sm font-bold text-success">
                    {compactCurrency(stats.indicated.min)}–{compactCurrency(stats.indicated.max)}
                  </div>
                </div>
                {stats.subjectValue != null && (
                  <div className="rounded-lg bg-destructive/10 px-2 py-2 text-center">
                    <div className="text-[9px] font-medium uppercase tracking-wide text-destructive">
                      CAD Value
                    </div>
                    <div className="mt-0.5 truncate text-sm font-bold text-destructive">
                      {compactCurrency(stats.subjectValue)}
                    </div>
                  </div>
                )}
              </div>
              {stats.valuationGapPct != null && (
                <div className="mt-1.5 flex justify-center">
                  <ArrowDown className={`h-4 w-4 ${m.color.text}`} />
                </div>
              )}
            </>
          )
        )}
      </div>
    );
  }

  const loading = !moduleState || moduleState.loading || (m.id === "comps" && compsMap.loading);
  if (loading) return <SkeletonVisual />;
  if (moduleState?.error) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="text-left text-xs text-destructive underline underline-offset-2 hover:text-destructive/80"
      >
        Couldn't load — click to view &amp; retry
      </button>
    );
  }
  if (!moduleState?.data) return null;

  switch (m.id) {
    case "health": {
      const d = moduleState.data as HealthScoreResult;
      const label =
        d.score >= 70
          ? "Strong Opportunity"
          : d.score >= 40
            ? "Moderate Opportunity"
            : "Limited Opportunity";
      const top3 = d.scoreBreakdown.slice(0, 3);
      return (
        <div>
          <SpeedometerGauge value={d.score} size="sm" />
          <div className="text-center text-sm font-semibold" style={{ color: scoreColor(d.score) }}>
            {label}
          </div>
          {!d.dataSufficient && (
            <div className="mt-1.5 text-center text-[10px] font-semibold text-warning-foreground">
              Additional Data Needed
            </div>
          )}
          {top3.length > 0 && (
            <div className="mt-3 grid grid-cols-3 gap-1.5 text-center">
              {top3.map((b) => {
                const Icon = breakdownIcon(b.label);
                return (
                  <div key={b.label} className="flex flex-col items-center gap-1">
                    <span
                      className={`grid h-8 w-8 place-items-center rounded-full ${m.color.bg} ${m.color.text}`}
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="text-[9px] leading-tight text-muted-foreground">
                      {b.label}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          {estimated.savings > 0 && (
            <div className="mt-3 rounded-lg bg-success/10 px-3 py-2.5 text-center">
              <div className="font-serif text-2xl font-bold leading-none text-success">
                {currency(estimated.savings)}
              </div>
              {totalValue ? (
                <div className="mt-1 text-base font-bold text-success/90">
                  {Math.round((estimated.reduction / totalValue) * 100)}% of assessed value
                </div>
              ) : null}
              <div className="mt-1 text-[10px] text-muted-foreground">
                estimated savings if your protest succeeds
              </div>
            </div>
          )}
          {d.executiveConclusion && (
            <p className="mt-2 text-center text-[11px] leading-snug text-muted-foreground">
              {d.executiveConclusion}
            </p>
          )}
          <div className="mt-2 flex items-center justify-center gap-1.5 text-[10px] text-muted-foreground">
            <ShieldCheck className="h-3 w-3" />
            Confidence: {d.confidencePct}%
          </div>
        </div>
      );
    }
    case "strategy": {
      const d = moduleState.data as ModuleResultMap["strategy"];
      if (d.strategies.length === 0) return null;
      return <StrategyRankList strategies={d.strategies} color={m.color} max={5} />;
    }
    case "comps": {
      const d = moduleState.data as ModuleResultMap["comps"];
      return (
        <div className="text-xs text-muted-foreground">
          {d.checklist.length} evidence item{d.checklist.length === 1 ? "" : "s"} to gather
        </div>
      );
    }
    case "site": {
      const d = moduleState.data as ModuleResultMap["site"];
      const headline = pickHeadlineFactor(d.factors);
      return (
        <div>
          <div className="relative">
            {siteCoords ? (
              <SiteMapThumb lat={siteCoords.lat} lng={siteCoords.lng} height={128} />
            ) : (
              <div className="grid h-32 place-items-center rounded-lg bg-secondary/40">
                <MapPin className="h-6 w-6 text-muted-foreground" />
              </div>
            )}
            <FloodZoneBadge floodZone={siteGisMap.data?.floodZone} />
          </div>
          <div className="mt-2.5">
            <MiniMeter value={d.priorityScore} label="documentation priority" />
            <div className="mt-1.5">
              {headline ? (
                <SiteImpactChain factor={headline} />
              ) : (
                <p className="text-[10px] text-muted-foreground">
                  {countDataGaps(d.factors)} of {d.factors.length} site factors need more data.
                </p>
              )}
            </div>
            {d.keyFinding && (
              <p className="mt-1.5 line-clamp-2 text-[10px] text-muted-foreground">
                {d.keyFinding}
              </p>
            )}
            {/* Static hint, not a link — the card's own "View report" button
                below already opens this module's modal, where the real
                clickable Next Step bar (to Module 5) lives. */}
            <p className="mt-1.5 flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
              Next: Improvement Condition
              <ArrowRight className="h-2.5 w-2.5" />
            </p>
          </div>
        </div>
      );
    }
    case "improvement": {
      // Card stays minimal by design — a building visual + the 1-2 numbers
      // that actually matter (Total Depreciation, Value Impact). The full
      // pipeline/4-component breakdown/6-tile metrics only live in the
      // modal ("View report") — repeating them here was too much text for
      // a glance-able card.
      const d = moduleState.data as ModuleResultMap["improvement"];
      const depreciation = computeDepreciation(
        d.effectiveAgeYears,
        getTypicalEconomicLife(propertyType),
        d.functionalObsolescencePct,
        d.externalObsolescencePct,
        improvementValue ?? null,
      );
      const withPhoto = d.buildingComponents.filter((c) => c.hasPhoto);
      const needsAttention = withPhoto.filter((c) => c.condition !== "Good");
      return (
        <div className="grid gap-2">
          <BuildingIllustration className="mx-auto h-28 w-auto" />
          {depreciation.conditionAdjustedValue != null ? (
            <div className="grid grid-cols-2 gap-1.5">
              <ExecutiveStat
                label="Total Depreciation"
                value={`${depreciation.totalDepreciationPct}%`}
              />
              <ExecutiveStat label="Value Impact" value={`${depreciation.impactPct}%`} />
            </div>
          ) : (
            <p className="text-center text-[10px] text-muted-foreground">
              Additional data needed — upload photos to assess condition.
            </p>
          )}
          {needsAttention.length > 0 && (
            <p className="text-center text-[10px] text-muted-foreground">
              {needsAttention.length} of {withPhoto.length} components need attention
            </p>
          )}
          <div className="flex flex-col items-center">
            <SpeedometerGauge value={d.priorityScore} size="sm" />
            <div className="-mt-1 text-xs text-muted-foreground">condition priority</div>
          </div>
        </div>
      );
    }
    case "zoning": {
      const d = moduleState.data as ModuleResultMap["zoning"];
      return <ZoningAspectTiles aspects={d.aspects} matches={d.matches} />;
    }
    case "evidence": {
      const d = moduleState.data as ModuleResultMap["evidence"];
      return <EvidenceQuadrant items={d.items} />;
    }
    case "executive": {
      const d = moduleState.data as ModuleResultMap["executive"];
      const evidenceData = moduleData.evidence?.data as ModuleResultMap["evidence"] | undefined;
      const strategyData = moduleData.strategy?.data as ModuleResultMap["strategy"] | undefined;
      const execStats = computeComparableStats(
        compsMap.data?.subject ?? null,
        compsMap.data?.comps ?? [],
        totalValue,
      );
      const summary = getExecutiveSummary(
        execStats,
        estimated.savings,
        evidenceData?.items ?? [],
        null,
      );
      const defenseScore = getDefenseReadinessScore(d.defenseQA);
      return (
        <div className="grid gap-2">
          {/* Real Executive Summary tiles — overvaluation range (comps
              math), primary strategy name (Module 2's own top pick), market
              value range (comps math) — same 3-tile layout as the
              reference this card was matched to, all real numbers. */}
          <div className="grid grid-cols-3 gap-1.5">
            <div
              className={`min-w-0 rounded-md px-1 py-1.5 text-center ${summary.overvaluationRange ? "bg-destructive/10" : "bg-secondary/40"}`}
            >
              <div
                className={`truncate text-[7px] uppercase tracking-wide ${summary.overvaluationRange ? "text-destructive" : "text-muted-foreground"}`}
              >
                Overvaluation
              </div>
              <div
                className={`truncate text-[11px] font-bold ${summary.overvaluationRange ? "text-destructive" : "text-muted-foreground"}`}
              >
                {summary.overvaluationRange
                  ? `${compactCurrency(summary.overvaluationRange.minDollar)}–${compactCurrency(summary.overvaluationRange.maxDollar)}`
                  : summary.indicatedValueRange
                    ? "Not Indicated"
                    : "Insufficient Data"}
              </div>
              {summary.overvaluationRange && (
                <div className="text-[8px] text-destructive/80">
                  ({summary.overvaluationRange.minPct}%–{summary.overvaluationRange.maxPct}%)
                </div>
              )}
            </div>
            <div className="min-w-0 rounded-md bg-accent/10 px-1 py-1.5 text-center">
              <div className="truncate text-[7px] uppercase tracking-wide text-accent">
                Primary Strategy
              </div>
              <div className="truncate text-[10px] font-bold">
                {strategyData?.strategies[0]?.name ?? "—"}
              </div>
              {strategyData?.strategies[0] && (
                <div className="text-[8px] text-muted-foreground">
                  {strategyData.strategies[0].strengthScore >= 70 ? "Strongest" : "Best available"}
                </div>
              )}
            </div>
            <div
              className={`min-w-0 rounded-md px-1 py-1.5 text-center ${summary.indicatedValueRange ? "bg-success/10" : "bg-secondary/40"}`}
            >
              <div
                className={`truncate text-[7px] uppercase tracking-wide ${summary.indicatedValueRange ? "text-success" : "text-muted-foreground"}`}
              >
                Value Range
              </div>
              <div
                className={`truncate text-[11px] font-bold ${summary.indicatedValueRange ? "text-success" : "text-muted-foreground"}`}
              >
                {summary.indicatedValueRange
                  ? `${compactCurrency(summary.indicatedValueRange.min)}–${compactCurrency(summary.indicatedValueRange.max)}`
                  : "Insufficient Data"}
              </div>
              {summary.currentCadValue != null && (
                <div className="truncate text-[8px] text-muted-foreground">
                  vs CAD {compactCurrency(summary.currentCadValue)}
                </div>
              )}
            </div>
          </div>
          {!summary.indicatedValueRange && (
            <p className="text-[9px] text-muted-foreground">
              No comparable properties with a usable market value were found for this property yet —
              comps math above can&apos;t run without at least one.
            </p>
          )}

          {/* Key Supporting Factors — real AI findings, short titles only. */}
          {d.majorFindings.length > 0 && (
            <div className="grid gap-0.5">
              {d.majorFindings.slice(0, 4).map((f, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <CheckCircle2 className="h-3 w-3 shrink-0 text-success" />
                  <span className="min-w-0 flex-1 truncate text-[10px]">{f.finding}</span>
                </div>
              ))}
            </div>
          )}

          {/* Overall Case Assessment + Protest Defense Readiness gauges,
              side by side — same pairing as the reference. */}
          <div className="grid grid-cols-2 items-end gap-2">
            {summary.overallConfidencePct != null && (
              <div className="flex flex-col items-center">
                <SpeedometerGauge value={summary.overallConfidencePct} size="sm" />
                <div className="-mt-1 text-center text-[8px] uppercase tracking-wide text-muted-foreground">
                  Case Assessment
                </div>
              </div>
            )}
            {defenseScore != null && (
              <div className="flex flex-col items-center">
                <SpeedometerGauge value={defenseScore} size="sm" />
                <div className="-mt-1 text-center text-[8px] uppercase tracking-wide text-muted-foreground">
                  Defense Readiness
                </div>
              </div>
            )}
          </div>
        </div>
      );
    }
    default:
      return null;
  }
}

// Compact "$4.8M"/"$120K" formatting for tight badge/axis labels where the
// full currency() output (e.g. "$4,800,000") would overflow.
function compactCurrency(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${Math.round(n / 1000)}K`;
  return currency(n);
}

// Real 2-D scatter — Value Per Acre (Y) vs Land Size (X), the honest
// per-unit substitute for a "$/SF vs. building size" plot: no building-SF
// field exists anywhere in this pipeline (see valuePerAcre() below), but
// legalAcreage and marketValue are both real CAD fields every comp already
// carries. The subject renders as a larger, labeled accent dot among the
// comps (muted) so where the subject sits in the market reads at a glance,
// same visual language as CompsMap's subject/comp marker distinction.
// Subject dot shape shared by both the 2-D and 1-D fallback charts below —
// a larger accent-colored, labeled marker so the subject reads as visually
// distinct from the comps regardless of which chart is showing.
// Teal, reused straight from the Market Value module's own assigned icon
// color (ICON_COLORS[2] in icon-colors.ts) — comps read as "this module's
// color," not an invented chart palette.
const COMPS_DOT_COLOR = "#0d9488";
// Sky blue, also an existing app tone (ICON_COLORS[6], already live on the
// Income Value module) reused here as a "this one is you" highlight —
// deliberately distinct from the comps' teal so the subject reads at a
// glance, without inventing a color the app doesn't already use elsewhere.
const SUBJECT_DOT_COLOR = "#0284c7";

function compDotShape(props: { cx?: number; cy?: number }) {
  return <circle cx={props.cx} cy={props.cy} r={7} fill={COMPS_DOT_COLOR} fillOpacity={0.7} />;
}

// Two-line "Subject / Property" label for the full 2-D plot, where there's
// room above the dot for it.
function subjectDotShape(props: { cx?: number; cy?: number }) {
  const cx = props.cx ?? 0;
  const cy = props.cy ?? 0;
  return (
    <g>
      <circle
        cx={cx}
        cy={cy}
        r={12}
        fill={SUBJECT_DOT_COLOR}
        stroke="var(--card)"
        strokeWidth={2.5}
      />
      <text
        x={cx}
        y={cy - 25}
        textAnchor="middle"
        fontSize={11}
        fontWeight={700}
        fill={SUBJECT_DOT_COLOR}
      >
        Subject
      </text>
      <text
        x={cx}
        y={cy - 13}
        textAnchor="middle"
        fontSize={11}
        fontWeight={700}
        fill={SUBJECT_DOT_COLOR}
      >
        Property
      </text>
    </g>
  );
}

// Compact single-line "Subject" label for the shorter 1-D fallback chart.
function subjectDotShapeCompact(props: { cx?: number; cy?: number }) {
  const cx = props.cx ?? 0;
  const cy = props.cy ?? 0;
  return (
    <g>
      <circle
        cx={cx}
        cy={cy}
        r={9}
        fill={SUBJECT_DOT_COLOR}
        stroke="var(--card)"
        strokeWidth={2.5}
      />
      <text
        x={cx}
        y={cy - 14}
        textAnchor="middle"
        fontSize={11}
        fontWeight={700}
        fill={SUBJECT_DOT_COLOR}
      >
        Subject
      </text>
    </g>
  );
}

// Right-aligned "Subject / Property" label for Tier 3's distance chart,
// where the subject sits at x=0 — the chart's own left edge — so a
// centered label above the dot (like subjectDotShape) would clip against
// the axis border. Text runs rightward from the dot instead.
function subjectDotShapeAtOrigin(props: { cx?: number; cy?: number }) {
  const cx = props.cx ?? 0;
  const cy = props.cy ?? 0;
  return (
    <g>
      <circle
        cx={cx}
        cy={cy}
        r={12}
        fill={SUBJECT_DOT_COLOR}
        stroke="var(--card)"
        strokeWidth={2.5}
      />
      <text
        x={cx + 15}
        y={cy - 4}
        textAnchor="start"
        fontSize={11}
        fontWeight={700}
        fill={SUBJECT_DOT_COLOR}
      >
        Subject
      </text>
      <text
        x={cx + 15}
        y={cy + 10}
        textAnchor="start"
        fontSize={11}
        fontWeight={700}
        fill={SUBJECT_DOT_COLOR}
      >
        Property
      </text>
    </g>
  );
}

// Best real value available for a comp — tries marketValue first, then
// appraisedValue, then landValue+improvementValue summed, all real CAD
// fields on the same row. TrueProdigy is known-inconsistent about which of
// these it actually populates for a given county/property (some rows carry
// an appraised or land+improvement figure but a null marketValue) — this
// widens which comps the CARD's own chart can plot without changing
// computeComparableStats()'s stricter marketValue-only definition, which
// still drives the actual $ figures (Market Value Range, Valuation Gap,
// "Limited Comparable Data") since those feed the real protest argument.
function bestAvailableValue(c: {
  marketValue: number | null;
  appraisedValue?: number | null;
  landValue?: number | null;
  improvementValue?: number | null;
}): number | null {
  if (c.marketValue != null) return c.marketValue;
  if (c.appraisedValue != null) return c.appraisedValue;
  if (c.landValue != null && c.improvementValue != null) return c.landValue + c.improvementValue;
  return null;
}

function CompsValueScatter({
  subject,
  subjectValue,
  comps,
}: {
  subject: CompProperty | null;
  // The subject's real assessed value — passed in from
  // computeComparableStats()'s own subjectValue (totalValue ?? the raw
  // TrueProdigy subject record's marketValue), NOT read off `subject`
  // directly: the comps-endpoint's own subject row doesn't always carry a
  // marketValue, while the account's actual confirmed total value (already
  // shown elsewhere as "CAD Value") almost always does. Using the weaker
  // field here was why the chart went blank on some real properties even
  // though a real value existed.
  subjectValue: number | null;
  comps: RankedComp[];
}) {
  const subjectBestValue = subjectValue ?? (subject ? bestAvailableValue(subject) : null);
  const subjectPoint2D =
    subject?.legalAcreage && valuePerAcre(subjectBestValue, subject.legalAcreage) != null
      ? {
          x: subject.legalAcreage,
          y: valuePerAcre(subjectBestValue, subject.legalAcreage) as number,
        }
      : null;
  const points2D = comps
    .slice(0, 10)
    .map((c) => ({
      x: c.legalAcreage ?? null,
      y: valuePerAcre(bestAvailableValue(c), c.legalAcreage),
    }))
    .filter((p): p is { x: number; y: number } => p.x != null && p.y != null);

  // legalAcreage isn't populated for every CAD row the way value fields
  // are — a real 2-D plot needs both dimensions on the subject AND at
  // least one comp, or it's just an empty box. When there isn't enough of
  // it, fall back to a 1-D value-only scatter (present far more
  // consistently) rather than rendering nothing.
  if (subjectPoint2D && points2D.length > 0) {
    const allX = points2D.map((p) => p.x).concat([subjectPoint2D.x]);
    const allY = points2D.map((p) => p.y).concat([subjectPoint2D.y]);
    const xMin = Math.min(...allX);
    const xMax = Math.max(...allX);
    const yMin = Math.min(...allY);
    const yMax = Math.max(...allY);
    const xPad = (xMax - xMin) * 0.2 || xMax * 0.2 || 1;
    const yPad = (yMax - yMin) * 0.2 || yMax * 0.2 || 1;

    return (
      <div>
        <div className="flex items-stretch gap-1">
          <div className="flex flex-col justify-between py-2 text-[8px] font-medium uppercase tracking-wide text-muted-foreground">
            <span>High</span>
            <span>Low</span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="border-b border-l border-border">
              <ResponsiveContainer width="100%" height={190}>
                <ScatterChart margin={{ top: 36, right: 20, bottom: 8, left: 8 }}>
                  <XAxis type="number" dataKey="x" domain={[xMin - xPad, xMax + xPad]} hide />
                  <YAxis type="number" dataKey="y" domain={[yMin - yPad, yMax + yPad]} hide />
                  <ReferenceLine
                    y={subjectPoint2D.y}
                    stroke="var(--border)"
                    strokeDasharray="3 3"
                  />
                  <Scatter data={points2D} shape={compDotShape} />
                  <Scatter data={[subjectPoint2D]} shape={subjectDotShape} />
                </ScatterChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-0.5 flex items-center justify-between text-[8px] font-medium uppercase tracking-wide text-muted-foreground">
              <span>Small</span>
              <span>Land Size</span>
              <span>Large</span>
            </div>
          </div>
        </div>
        <div className="mt-0.5 text-center text-[9px] text-muted-foreground">Value Per Acre</div>
      </div>
    );
  }

  // Fallback tier 2: 1-D, value-only scatter (no land-size axis) — still
  // real data (marketValue, or appraisedValue, or landValue+improvementValue
  // — see bestAvailableValue above), just less of it plotted.
  const valuePoints = comps
    .slice(0, 10)
    .map((c) => bestAvailableValue(c))
    .filter((v): v is number => v != null)
    .map((v) => ({ x: v, y: 0 }));
  // Requires BOTH the subject and at least one comp to have a real value —
  // a subject-only dot with nothing to compare it against isn't a
  // meaningful plot (same requirement Tier 1 already applies). When comps
  // have no usable value at all, fall through to Tier 3 instead, which
  // always has real multi-point data to show.
  if (valuePoints.length > 0 && subjectBestValue != null) {
    const allValues = valuePoints
      .map((p) => p.x)
      .concat(subjectBestValue != null ? [subjectBestValue] : []);
    const vMin = Math.min(...allValues);
    const vMax = Math.max(...allValues);
    const vPad = (vMax - vMin) * 0.2 || vMax * 0.1 || 1000;

    return (
      <div>
        <ResponsiveContainer width="100%" height={120}>
          <ScatterChart margin={{ top: 26, right: 16, bottom: 6, left: 16 }}>
            <XAxis type="number" dataKey="x" domain={[vMin - vPad, vMax + vPad]} hide />
            <YAxis type="number" dataKey="y" domain={[-1, 1]} hide />
            {valuePoints.length > 0 && <Scatter data={valuePoints} shape={compDotShape} />}
            {subjectBestValue != null && (
              <Scatter data={[{ x: subjectBestValue, y: 0 }]} shape={subjectDotShapeCompact} />
            )}
          </ScatterChart>
        </ResponsiveContainer>
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span>{compactCurrency(vMin)}</span>
          <span>Assessed Value</span>
          <span>{compactCurrency(vMax)}</span>
        </div>
      </div>
    );
  }

  // Fallback tier 3: no usable value field at all on the subject or any
  // comp (rare, but real — some TrueProdigy rows carry no value data
  // whatsoever). distanceMi and similarity are always real, always present
  // on every RankedComp regardless of value data (plain haversine distance
  // + similarityScore(), see comps-analysis.ts) — this tier can't go blank
  // as long as at least one comp was found, so it's the guaranteed floor
  // for "always show something meaningful."
  if (comps.length === 0) return null;
  const distancePoints = comps.slice(0, 10).map((c) => ({ x: c.distanceMi, y: c.similarity }));
  const maxDistance = Math.max(...distancePoints.map((p) => p.x), 0.1);

  return (
    <div>
      <div className="flex items-stretch gap-1">
        <div className="flex flex-col justify-between py-2 text-[8px] font-medium uppercase tracking-wide text-muted-foreground">
          <span>High</span>
          <span>Low</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="border-b border-l border-border">
            <ResponsiveContainer width="100%" height={190}>
              <ScatterChart margin={{ top: 20, right: 20, bottom: 8, left: 8 }}>
                <XAxis type="number" dataKey="x" domain={[0, maxDistance * 1.15]} hide />
                <YAxis type="number" dataKey="y" domain={[0, 100]} hide />
                <Scatter data={distancePoints} shape={compDotShape} />
                <Scatter data={[{ x: 0, y: 100 }]} shape={subjectDotShapeAtOrigin} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-0.5 flex items-center justify-between text-[8px] font-medium uppercase tracking-wide text-muted-foreground">
            <span>Near</span>
            <span>Distance</span>
            <span>Far</span>
          </div>
        </div>
      </div>
      <div className="mt-0.5 text-center text-[9px] text-muted-foreground">Similarity</div>
    </div>
  );
}

// Real-count selection funnel — "N Properties Reviewed → N Qualified → N
// Best Comps Selected," matching the spec's own recommended visual flow
// (comps.length → usable.length → min(5, usable.length), all straight from
// computeComparableStats in comps-analysis.ts — no AI estimate involved).
function ComparableSelectionFunnel({
  reviewed,
  qualified,
  selected,
}: {
  reviewed: number;
  qualified: number;
  selected: number;
}) {
  const stages = [
    { label: "Properties Reviewed", value: reviewed },
    { label: "Qualified", value: qualified },
    { label: "Best Comps Selected", value: selected },
  ];
  return (
    <div className="flex items-center justify-between gap-1.5 rounded-lg bg-secondary/40 p-3 text-center">
      {stages.map((s, i) => (
        <Fragment key={s.label}>
          <div className="min-w-0">
            <div className="text-lg font-bold">{s.value}</div>
            <div className="text-[9px] uppercase tracking-wide text-muted-foreground">
              {s.label}
            </div>
          </div>
          {i < stages.length - 1 && (
            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
        </Fragment>
      ))}
    </div>
  );
}

// Real per-signal deltas already computed inside similarityScore() — value
// % diff, distance, land-size % diff, property-type match — surfaced as
// "how each top comp differs from the subject" instead of staying buried
// inside one opaque similarity number. Deliberately NOT a dollar-per-SF
// adjustment: no building-size field exists anywhere in this pipeline (see
// comps-analysis.ts), so this only ever shows real percentage/distance
// deltas, never a fabricated adjustment value.
function ComparableAdjustments({ subject, comps }: { subject: CompProperty; comps: RankedComp[] }) {
  if (comps.length === 0) return null;
  return (
    <div className="grid gap-2">
      {comps.map((c) => {
        const valueDiffPct =
          subject.marketValue && c.marketValue
            ? Math.round(((c.marketValue - subject.marketValue) / subject.marketValue) * 100)
            : null;
        const landDiffPct =
          subject.legalAcreage && c.legalAcreage
            ? Math.round(((c.legalAcreage - subject.legalAcreage) / subject.legalAcreage) * 100)
            : null;
        const sameType = subject.propType && c.propType ? subject.propType === c.propType : null;
        return (
          <div key={c.pid} className="rounded-lg border border-border p-3 text-xs">
            <div className="truncate font-semibold">{c.address || `Property #${c.pid}`}</div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
              <span>
                Value:{" "}
                {valueDiffPct != null ? (
                  <span className={valueDiffPct >= 0 ? "text-success" : "text-destructive"}>
                    {valueDiffPct > 0 ? "+" : ""}
                    {valueDiffPct}%
                  </span>
                ) : (
                  "—"
                )}
              </span>
              <span>Distance: {c.distanceMi.toFixed(2)} mi</span>
              <span>
                Land size:{" "}
                {landDiffPct != null
                  ? `${landDiffPct > 0 ? "+" : ""}${landDiffPct}%`
                  : "not on file"}
              </span>
              <span>
                Property type: {sameType == null ? "not on file" : sameType ? "same" : "different"}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Subject's CAD value vs. each top comp's assessed value — the real
// "does the subject look high?" comparison at a glance. Relabeled from the
// spec's own "$/SF" framing to plain assessed value, since no building-SF
// field exists anywhere in this pipeline (real $/acre is already surfaced
// per-row in ComparableTable, where land size is on file).
function ComparableValueChart({
  subjectValue,
  comps,
  median,
}: {
  subjectValue: number | null;
  comps: RankedComp[];
  median: number | null;
}) {
  // Truncated to a fixed short length (not left to Recharts' own tick
  // wrapping) — a full street address at this axis width wrapped into 2-3
  // ugly lines per bar; a short, consistent label reads far better than a
  // literal-but-cramped one here, and the full address is already the row
  // label in ComparableTable right above this chart.
  const shortLabel = (s: string) => (s.length > 13 ? `${s.slice(0, 12)}…` : s);
  const data = [
    ...(subjectValue != null
      ? [{ name: "Subject (CAD)", value: subjectValue, isSubject: true }]
      : []),
    ...comps
      .filter((c): c is RankedComp & { marketValue: number } => c.marketValue != null)
      .map((c) => ({
        name: shortLabel(c.address ? c.address.split(",")[0] : `Property #${c.pid}`),
        value: c.marketValue,
        isSubject: false,
      })),
  ];
  if (data.length === 0) return null;
  return (
    <div>
      <ResponsiveContainer width="100%" height={Math.max(140, data.length * 32)}>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 4 }}>
          <XAxis type="number" tickFormatter={compactCurrency} tick={{ fontSize: 10 }} />
          <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 10 }} interval={0} />
          {median != null && (
            <ReferenceLine
              x={median}
              stroke="var(--muted-foreground)"
              strokeDasharray="4 3"
              label={{
                value: "Median",
                position: "top",
                fontSize: 9,
                fill: "var(--muted-foreground)",
              }}
            />
          )}
          <Bar dataKey="value" radius={[0, 4, 4, 0]}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.isSubject ? "var(--destructive)" : "var(--success)"} />
            ))}
            <LabelList dataKey="value" position="right" formatter={compactCurrency} fontSize={10} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// Real, deterministic explanation of the confidence score — the same two
// inputs computeComparableStats() itself blends (usable comp count, value
// spread), phrased in a sentence — never AI-written, matching the
// SupportingDataGrid/SourcesList convention already used for Module 1.
function comparableConfidenceReasoning(stats: ComparableStats): string | null {
  if (stats.confidencePct == null || stats.indicated == null) return null;
  const count = stats.ranked.filter((c) => c.marketValue != null).length;
  const spreadPct =
    stats.indicated.median > 0
      ? Math.round(((stats.indicated.max - stats.indicated.min) / stats.indicated.median) * 100)
      : null;
  const countPhrase = `${count} comparable ${count === 1 ? "property" : "properties"} with a real assessed value`;
  const spreadPhrase =
    spreadPct != null
      ? spreadPct <= 20
        ? "a tight value range"
        : spreadPct <= 50
          ? "a moderate value range"
          : "a wide value range"
      : null;
  return spreadPhrase
    ? `${countPhrase}, within ${spreadPhrase} (±${spreadPct}%), support this indicated value.`
    : `${countPhrase} support this indicated value.`;
}

// A real deed date (see CompProperty.lastTransferDt), never a sale price —
// formatted plainly so it can't be mistaken for one.
function formatTransferDate(v?: string | null): string | null {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function formatAcres(v?: number | null): string | null {
  if (v == null) return null;
  return `${v.toFixed(v < 1 ? 2 : 1)} ac`;
}

// $-per-acre, the real per-unit metric this data actually supports — not a
// $/SF substitute, since no building-size field exists (see comps-analysis.ts).
function valuePerAcre(marketValue?: number | null, acreage?: number | null): number | null {
  if (marketValue == null || !acreage || acreage < 0.05) return null;
  return marketValue / acreage;
}

// Real per-comp comparison table — Property / Last Transfer / Land Size /
// Assessed Value / $ per Acre / Distance / Similarity, all real fields (see
// comps-analysis.ts). Each row expands on click (not hover, so it works on
// touch too). When `onToggleExclude` is passed (the live modal, not the
// printable report) each row gets a Keep checkbox and the AI's per-comp
// verdict; excluded comps render struck through and are already out of the
// value math (computeComparableStats drops them).
type PerCompVerdict = { key: string; verdict: "use" | "exclude"; reason: string };
function ComparableTable({
  ranked,
  cad,
  perComp,
  recommendedKeys,
  onToggleExclude,
  onRemove,
}: {
  ranked: RankedComp[];
  cad?: string;
  perComp?: Map<string, PerCompVerdict>;
  recommendedKeys?: Set<string>;
  onToggleExclude?: (comp: RankedComp, exclude: boolean) => void;
  onRemove?: (comp: RankedComp) => void;
}) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  if (ranked.length === 0) return null;
  const interactive = !!onToggleExclude;
  const showAi = !!perComp && perComp.size > 0;
  const colCount = 7 + (interactive ? 1 : 0) + (showAi ? 1 : 0);
  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[640px] text-left text-xs">
        <thead className="bg-secondary/60 text-[10px] uppercase tracking-wide text-muted-foreground">
          <tr>
            {interactive && <th className="px-3 py-2 font-semibold">Keep</th>}
            <th className="px-3 py-2 font-semibold">Property</th>
            {showAi && <th className="px-3 py-2 font-semibold">AI</th>}
            <th className="px-3 py-2 font-semibold">Last Transfer</th>
            <th className="px-3 py-2 font-semibold">Land Size</th>
            <th className="px-3 py-2 font-semibold">Assessed Value</th>
            <th className="px-3 py-2 font-semibold">$ / Acre</th>
            <th className="px-3 py-2 font-semibold">Distance</th>
            <th className="px-3 py-2 font-semibold">Similarity</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((c) => {
            const expanded = expandedKey === c.key;
            const perAcre = valuePerAcre(c.marketValue, c.legalAcreage);
            const pc = perComp?.get(c.key);
            const recommended = recommendedKeys?.has(c.key);
            return (
              <Fragment key={c.key}>
                <tr
                  onClick={() => setExpandedKey(expanded ? null : c.key)}
                  className={`cursor-pointer border-t border-border/60 hover:bg-secondary/40 ${
                    c.excluded ? "text-muted-foreground line-through" : ""
                  }`}
                >
                  {interactive && (
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={!c.excluded}
                        onChange={(e) => onToggleExclude!(c, !e.target.checked)}
                        aria-label={c.excluded ? "Include this comp" : "Exclude this comp"}
                      />
                    </td>
                  )}
                  <td className="max-w-[10rem] truncate px-3 py-2">
                    {c.address || `Property #${c.pid}`}
                    {c.userAdded && (
                      <span className="ml-1 rounded bg-secondary px-1 py-0.5 text-[9px] font-semibold text-muted-foreground no-underline">
                        Added by you
                      </span>
                    )}
                  </td>
                  {showAi && (
                    <td className="px-3 py-2">
                      {recommended ? (
                        <span className="whitespace-nowrap rounded-full bg-success/15 px-1.5 py-0.5 text-[9px] font-semibold text-success no-underline">
                          Recommended
                        </span>
                      ) : pc?.verdict === "exclude" ? (
                        <span className="whitespace-nowrap rounded-full bg-warning/20 px-1.5 py-0.5 text-[9px] font-semibold text-warning-foreground no-underline">
                          Exclude
                        </span>
                      ) : (
                        <span className="text-[10px] text-muted-foreground">—</span>
                      )}
                    </td>
                  )}
                  <td className="px-3 py-2 text-muted-foreground">
                    {c.userAdded && c.saleDate
                      ? c.saleDate
                      : (formatTransferDate(c.lastTransferDt) ?? "—")}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {formatAcres(c.legalAcreage) ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    {c.userAdded
                      ? c.salePrice != null
                        ? compactCurrency(c.salePrice)
                        : "Not verified"
                      : c.marketValue != null
                        ? compactCurrency(c.marketValue)
                        : "—"}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {perAcre != null ? compactCurrency(perAcre) : "—"}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{c.distanceMi.toFixed(2)} mi</td>
                  <td
                    className="px-3 py-2 font-semibold"
                    style={{ color: scoreColor(c.similarity) }}
                  >
                    {c.similarity}
                  </td>
                </tr>
                {expanded && (
                  <tr className="border-t border-border/60 bg-secondary/30">
                    <td colSpan={colCount} className="px-3 py-3">
                      <div className="grid gap-1.5 text-xs text-muted-foreground sm:grid-cols-2">
                        {pc?.reason && (
                          <div className="sm:col-span-2">
                            <span className="font-semibold text-foreground">AI: </span>
                            {pc.verdict === "exclude" ? "Suggest excluding — " : "Suggest using — "}
                            {pc.reason}
                          </div>
                        )}
                        {c.userAdded ? (
                          <>
                            <div>
                              Sale price:{" "}
                              {c.salePrice != null
                                ? currency(c.salePrice)
                                : "Sale Price Not Verified"}
                            </div>
                            <div>Sale date: {c.saleDate ?? "—"}</div>
                            <div>
                              Building SF:{" "}
                              {c.buildingSqft != null ? c.buildingSqft.toLocaleString() : "—"}
                            </div>
                            <div>
                              $/SF: {c.pricePerSqft != null ? currency(c.pricePerSqft) : "—"}
                            </div>
                            <div>
                              Verified: {c.saleVerified ? "Yes — from uploaded document" : "No"}
                            </div>
                            {onRemove && (
                              <div className="sm:col-span-2">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onRemove(c);
                                  }}
                                  className="text-destructive underline underline-offset-2"
                                >
                                  Remove this comp
                                </button>
                              </div>
                            )}
                          </>
                        ) : (
                          <>
                            <div>Owner: {c.ownerName ?? "Not on file"}</div>
                            <div>
                              Land value: {c.landValue != null ? currency(c.landValue) : "—"}
                            </div>
                            <div>
                              Improvement value:{" "}
                              {c.improvementValue != null ? currency(c.improvementValue) : "—"}
                            </div>
                            <div>
                              Appraised value:{" "}
                              {c.appraisedValue != null ? currency(c.appraisedValue) : "—"}
                            </div>
                            <div>Sale price: Sale Price Not Verified (assessed-value comp)</div>
                            {c.zoning && <div>Zoning: {c.zoning}</div>}
                            <div>
                              Source:{" "}
                              {(() => {
                                const url = cad
                                  ? getCadRecordUrl({ cad, accountNumber: String(c.pid) })
                                  : null;
                                if (!url)
                                  return c.pid ? `CAD record #${c.pid}` : "CAD public record";
                                return (
                                  <a
                                    href={url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="text-accent underline underline-offset-2"
                                  >
                                    {isDirectCadRecordUrl(cad!)
                                      ? `View CAD record #${c.pid}`
                                      : `Search ${cad} for #${c.pid}`}
                                  </a>
                                );
                              })()}
                            </div>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// The 10-step workflow ribbon at the top of Module 3 — purely a progress
// cue for the sequence the user described (Find -> Verify -> Rank -> Select
// -> Compare -> Adjust -> Calculate -> vs CAD -> Confidence -> Recommendation).
function CompsWorkflowRibbon({
  hasComps,
  hasSelection,
  hasIndicated,
  hasRecommendation,
}: {
  hasComps: boolean;
  hasSelection: boolean;
  hasIndicated: boolean;
  hasRecommendation: boolean;
}) {
  const steps = [
    "Find data",
    "Verify",
    "Rank",
    "Select",
    "Compare",
    "Adjust",
    "Calculate value",
    "vs CAD",
    "Confidence",
    "Recommendation",
  ];
  // Furthest step reached — a coarse cue, not a strict state machine.
  const reached = !hasComps ? 0 : hasRecommendation ? 9 : hasIndicated ? 7 : hasSelection ? 3 : 2;
  return (
    <div className="flex gap-1 overflow-x-auto pb-1 text-[10px]">
      {steps.map((s, i) => (
        <div
          key={s}
          className={`shrink-0 rounded-full px-2 py-0.5 font-medium ${
            i <= reached ? "bg-accent/15 text-accent" : "bg-secondary/60 text-muted-foreground"
          }`}
        >
          {i + 1}. {s}
        </div>
      ))}
    </div>
  );
}

// "Add a comparable" — a comp the user knows about that the CAD feed didn't
// surface (or a real sale from a document). Address is geocoded on submit so
// it lands on the map relative to the subject; sale figures are optional and
// stay unverified until backed by an uploaded document (Phase C).
function AddCompForm({
  onAdd,
  onExtractSale,
}: {
  onAdd: (input: CompSelectionInput) => void;
  onExtractSale: (file: File) => Promise<CompSaleExtraction | null>;
}) {
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [salePrice, setSalePrice] = useState("");
  const [saleDate, setSaleDate] = useState("");
  const [buildingSqft, setBuildingSqft] = useState("");
  const [landSqft, setLandSqft] = useState("");
  const [source, setSource] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once a sale document has been read — the comp then saves as verified
  // and links back to that document.
  const [sourceDocumentId, setSourceDocumentId] = useState<string | null>(null);
  const [extractNote, setExtractNote] = useState<string | null>(null);

  const num = (s: string) => {
    const n = Number(s.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  function reset() {
    setAddress("");
    setSalePrice("");
    setSaleDate("");
    setBuildingSqft("");
    setLandSqft("");
    setSource("");
    setNotes("");
    setSourceDocumentId(null);
    setExtractNote(null);
    setError(null);
  }

  async function handleDoc(file: File) {
    setExtracting(true);
    setError(null);
    setExtractNote(null);
    try {
      const r = await onExtractSale(file);
      if (!r) {
        setError("Couldn't read that document. Enter the details by hand instead.");
        return;
      }
      if (r.address) setAddress((prev) => prev || r.address!);
      if (r.salePrice != null) setSalePrice(String(r.salePrice));
      if (r.saleDate) setSaleDate(r.saleDate);
      if (r.buildingSqft != null) setBuildingSqft(String(r.buildingSqft));
      if (r.landSqft != null) setLandSqft(String(r.landSqft));
      if (r.source) setSource((prev) => prev || r.source!);
      if (r.salePrice != null) {
        setSourceDocumentId(r.documentId);
        setExtractNote(
          `Read from your document${r.notes ? ` — ${r.notes}` : ""}. Review, then add.`,
        );
      } else {
        setSourceDocumentId(null);
        setExtractNote(
          `No sale price found in that document${r.notes ? ` — ${r.notes}` : ""}. Enter it by hand.`,
        );
      }
    } catch {
      setError("Couldn't read that document. Enter the details by hand instead.");
    } finally {
      setExtracting(false);
    }
  }

  async function submit() {
    if (!address.trim()) {
      setError("Enter the comparable's address.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const point = await geocodeAddress(address.trim());
      if (!point) {
        setError("Couldn't locate that address. Check the spelling or add city + ZIP.");
        return;
      }
      onAdd({
        compKey: `user:${crypto.randomUUID()}`,
        action: "include",
        address: address.trim(),
        latitude: point.lat,
        longitude: point.lng,
        salePrice: num(salePrice),
        saleDate: saleDate || null,
        buildingSqft: num(buildingSqft),
        landSqft: num(landSqft),
        source: source.trim() || null,
        notes: notes.trim() || null,
        saleVerified: !!sourceDocumentId && num(salePrice) != null,
        sourceDocumentId,
      });
      setOpen(false);
      reset();
    } catch {
      setError("Couldn't add that comp. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="inline-flex w-fit items-center gap-1.5 rounded-md border border-accent/40 px-2.5 py-1 text-xs font-semibold text-accent hover:bg-accent/10"
      >
        <Upload className="h-3.5 w-3.5" /> Add a comparable
      </button>
    );
  }

  const field = "rounded-md border border-input bg-background px-2.5 py-1.5 text-xs";
  return (
    <div className="grid gap-2 rounded-lg border border-border p-3">
      <div className="text-xs font-semibold">Add a comparable</div>
      <label className="inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-md border border-accent/40 px-2.5 py-1 text-xs font-semibold text-accent hover:bg-accent/10">
        <input
          type="file"
          accept="image/*,.pdf"
          disabled={extracting}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleDoc(f);
            e.target.value = "";
          }}
        />
        <Upload className="h-3.5 w-3.5" />
        {extracting ? "Reading document…" : "Upload a sale document (AI reads it)"}
      </label>
      {extractNote && <p className="text-[11px] text-accent">{extractNote}</p>}
      <input
        className={field}
        placeholder="Address (required) — street, city, ZIP"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
      />
      <div className="grid gap-2 sm:grid-cols-2">
        <input
          className={field}
          placeholder="Sale price (optional)"
          value={salePrice}
          onChange={(e) => setSalePrice(e.target.value)}
        />
        <input
          className={field}
          type="date"
          placeholder="Sale date"
          value={saleDate}
          onChange={(e) => setSaleDate(e.target.value)}
        />
        <input
          className={field}
          placeholder="Building SF (optional)"
          value={buildingSqft}
          onChange={(e) => setBuildingSqft(e.target.value)}
        />
        <input
          className={field}
          placeholder="Land SF (optional)"
          value={landSqft}
          onChange={(e) => setLandSqft(e.target.value)}
        />
      </div>
      <input
        className={field}
        placeholder="Source (broker, appraisal, listing…) — optional"
        value={source}
        onChange={(e) => setSource(e.target.value)}
      />
      <input
        className={field}
        placeholder="Notes (optional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <p className="text-[11px] text-muted-foreground">
        Sale price stays marked “Not Verified” until backed by an uploaded closing statement or
        appraisal.
      </p>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <button
          onClick={submit}
          disabled={busy}
          className="btn-primary btn-primary-hover text-xs disabled:opacity-60"
        >
          {busy ? "Locating…" : "Add comp"}
        </button>
        <button onClick={() => setOpen(false)} className="btn-outline text-xs">
          Cancel
        </button>
      </div>
    </div>
  );
}

function MiniMeter({ value, label }: { value: number; label: string }) {
  const color = scoreColor(value);
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-xs font-semibold" style={{ color }}>
          {value}
        </span>
      </div>
      <div className="mt-1 h-2 rounded-full bg-secondary/60">
        <div className="h-2 rounded-full" style={{ width: `${value}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}

function EvidenceQuadrant({ items }: { items: ModuleResultMap["evidence"]["items"] }) {
  if (items.length === 0) return <div className="text-xs text-muted-foreground">No gaps found</div>;
  const cell = (importance: "High" | "Low", availability: "High" | "Low") =>
    items.filter((i) => i.importance === importance && i.availability === availability);
  const focus = cell("High", "Low");
  const quadrants: { label: string; count: number; tone: string }[] = [
    {
      label: "High Importance · Missing",
      count: focus.length,
      tone: "bg-destructive/10 text-destructive",
    },
    {
      label: "High Importance · Available",
      count: cell("High", "High").length,
      tone: "bg-success/10 text-success",
    },
    {
      label: "Low Importance · Missing",
      count: cell("Low", "Low").length,
      tone: "bg-warning/15 text-warning-foreground",
    },
    {
      label: "Low Importance · Available",
      count: cell("Low", "High").length,
      tone: "bg-secondary/60 text-muted-foreground",
    },
  ];
  return (
    <div>
      <div className="flex gap-1">
        <div className="flex w-3 shrink-0 items-center justify-center">
          <span
            className="whitespace-nowrap text-[7px] uppercase tracking-wide text-muted-foreground"
            style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
          >
            Importance
          </span>
        </div>
        <div className="flex-1">
          <div className="grid grid-cols-2 gap-1.5">
            {quadrants.map((q) => (
              <div key={q.label} className={`rounded-md px-2 py-1.5 ${q.tone}`}>
                <div className="text-[8px] font-semibold uppercase tracking-wide">{q.label}</div>
                <div className="text-lg font-bold leading-tight">{q.count}</div>
              </div>
            ))}
          </div>
          <div className="mt-0.5 text-center text-[7px] uppercase tracking-wide text-muted-foreground">
            Availability
          </div>
        </div>
      </div>
      {focus.length > 0 && (
        <div className="mt-1.5 min-w-0 flex items-center justify-between gap-2 rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs font-semibold text-destructive">
          <span className="min-w-0 flex-1 truncate">
            Focus Here First: {focus.map((i) => i.item).join(", ")}
          </span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0" />
        </div>
      )}
    </div>
  );
}

function FormulaIcon({
  Icon,
  value,
  label,
  tone,
}: {
  Icon: LucideIcon;
  value: string;
  label: string;
  tone: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${tone}`}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="text-center leading-tight">
        <div className="text-sm font-bold">{value}</div>
        <div className="text-[9px] text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}

function FormulaChain({
  reduction,
  ratePct,
  savings,
}: {
  reduction: number;
  ratePct: number;
  savings: number;
}) {
  return (
    <div className="flex items-center justify-center gap-1.5">
      <FormulaIcon
        Icon={Home}
        value={compactCurrency(reduction)}
        label="value reduction"
        tone="bg-sky-500/15 text-sky-600"
      />
      <span className="text-sm text-muted-foreground">×</span>
      <FormulaIcon
        Icon={Percent}
        value={`${ratePct}%`}
        label="tax rate"
        tone="bg-warning/20 text-warning-foreground"
      />
      <span className="text-sm text-muted-foreground">=</span>
      <FormulaIcon
        Icon={DollarSign}
        value={compactCurrency(savings)}
        label="savings"
        tone="bg-success/15 text-success"
      />
    </div>
  );
}

// Module 10's Executive Summary tile — one real number/label per stat, see
// getExecutiveSummary() in src/lib/executive-summary.ts for the source of
// every value passed in here.
function ExecutiveStat({ label, value }: { label: string; value: string }) {
  // min-w-0 on the grid-item wrapper itself, not just truncate on the
  // children — a grid item's default auto min-width is based on its
  // content, so a long uppercase label like "EVIDENCE READINESS" can still
  // force this cell (and the whole row) wider than the modal without it.
  // Same bug class fixed across the shared row components earlier; this one
  // was added afterward for Module 10 and got missed.
  return (
    <div className="min-w-0 rounded-lg bg-secondary/40 px-2 py-2 text-center">
      <div className="truncate text-[8px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 truncate text-xs font-semibold">{value}</div>
    </div>
  );
}

// Module 10's "Major Supporting Findings" row — real AI findings grounded in
// the record, each optionally deep-linking back to the module that actually
// produced the underlying analysis (same modal, just switches which module
// is open — see onOpenModule in Report()).
function FindingCard({
  finding,
  onOpenModule,
}: {
  finding: { finding: string; whyItMatters: string; relatedModule: string | null };
  onOpenModule: (moduleId: string) => void;
}) {
  const target = finding.relatedModule
    ? MODULES.find((mm) => mm.id === finding.relatedModule)
    : null;
  return (
    <div className="flex items-start gap-2 rounded-lg bg-secondary/30 px-3 py-2">
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
      <div className="min-w-0 flex-1">
        <span className="text-sm font-semibold">{finding.finding}</span>
        {finding.whyItMatters && (
          <span className="text-xs text-muted-foreground"> — {finding.whyItMatters}</span>
        )}
      </div>
      {target && (
        <button
          onClick={() => onOpenModule(target.id)}
          className="shrink-0 whitespace-nowrap text-xs text-accent hover:underline"
        >
          View Analysis →
        </button>
      )}
    </div>
  );
}

const DEFENSE_QA_STATUS_TONE: Record<string, string> = {
  Supported: "bg-success/15 text-success",
  "Partially Supported": "bg-warning/15 text-warning-foreground",
  "Evidence Needed": "bg-destructive/10 text-destructive",
  "User Input Needed": "bg-secondary/60 text-muted-foreground",
};

// One row of the first-version Defense Readiness Q&A table — read-only
// (editing the answer / re-uploading evidence for just this question is a
// follow-up, see the plan this was built from). "View Evidence" only
// appears when the AI actually named a real module its answer draws from.
function DefenseQARow({
  qa,
  onOpenModule,
}: {
  qa: ModuleResultMap["executive"]["defenseQA"][number];
  onOpenModule: (moduleId: string) => void;
}) {
  const target = qa.relatedModule ? MODULES.find((mm) => mm.id === qa.relatedModule) : null;
  return (
    <div className="card-elev p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-semibold">{qa.question}</div>
        <span
          className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[9px] font-semibold ${DEFENSE_QA_STATUS_TONE[qa.status] ?? "bg-secondary/60 text-muted-foreground"}`}
        >
          {qa.status}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{qa.suggestedAnswer}</p>
      {target && (
        <button
          onClick={() => onOpenModule(target.id)}
          className="mt-1.5 text-xs text-accent hover:underline"
        >
          View Evidence →
        </button>
      )}
    </div>
  );
}

const SITE_FACTOR_STATUS_TONE: Record<SiteFactor["status"], string> = {
  Confirmed: "bg-success/15 text-success",
  "Partial Data": "bg-warning/15 text-warning-foreground",
  "Additional Data Needed": "bg-secondary/60 text-muted-foreground",
  "Not Applicable": "bg-secondary/60 text-muted-foreground",
};

// One row of Module 4's 14-factor table. status is server-enforced (see
// enforceSiteFactorRealData) — this component just renders whatever it's
// given, never re-decides Confirmed/Partial/Additional Data Needed itself.
function SiteFactorRow({
  factor,
  onOpenModule,
}: {
  factor: SiteFactor;
  onOpenModule: (moduleId: string) => void;
}) {
  return (
    <div className="card-elev p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold">{factor.factor}</span>
            <span
              className={`shrink-0 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${SITE_FACTOR_STATUS_TONE[factor.status]}`}
            >
              {factor.status}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{factor.finding}</p>
        </div>
        {factor.severity !== "Unknown" && (
          <span className="shrink-0 whitespace-nowrap text-[9px] font-semibold text-muted-foreground">
            {factor.severity}
          </span>
        )}
      </div>
      {factor.evidenceNeeded && (
        <div className="mt-1.5 flex min-w-0 items-center justify-between gap-2 text-xs">
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {factor.evidenceNeeded}
          </span>
          <button
            onClick={() => onOpenModule("evidence")}
            className="shrink-0 whitespace-nowrap text-accent hover:underline"
          >
            Upload →
          </button>
        </div>
      )}
    </div>
  );
}

// One tile of the compact "Needs More Data" grid — deliberately just an
// icon + the factor's name, no paragraph, no per-item AI text visible at
// a glance (evidenceNeeded is still there as a hover title for anyone who
// wants it). The same generic icon on every tile, same rationale as
// ChecklistIconRows: nothing here is a specific categorized finding, so no
// icon should look like one. Taps straight through to Module 8.
function SiteFactorGapTile({
  factor,
  onOpenModule,
  onMarkNotApplicable,
}: {
  factor: SiteFactor;
  onOpenModule: (moduleId: string) => void;
  // No document exists for most of these 14 factors at all (see
  // enforceSiteFactorRealData) — this is the escape hatch so the card
  // isn't a permanent dead end when there's genuinely nothing to upload.
  onMarkNotApplicable: () => void;
}) {
  return (
    <div
      title={factor.evidenceNeeded ?? undefined}
      className="flex flex-col items-center gap-1 rounded-lg border border-dashed border-border px-1.5 py-2 text-center transition-colors hover:border-accent hover:bg-secondary/40"
    >
      <button
        type="button"
        onClick={() => onOpenModule("evidence")}
        className="flex flex-col items-center gap-1"
      >
        <FileWarning className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="line-clamp-2 text-[10px] font-medium leading-tight">{factor.factor}</span>
      </button>
      <button
        type="button"
        onClick={onMarkNotApplicable}
        className="text-[9px] font-medium text-muted-foreground underline decoration-dotted hover:text-foreground"
      >
        Mark N/A
      </button>
    </div>
  );
}

// The "Marked Not Applicable" counterpart — same tile shape, neutral
// checkmark instead of the warning icon, with an Undo back to the gap
// tile above in case the user marked one by mistake or later finds the
// document after all.
function SiteFactorNotApplicableTile({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-lg border border-border bg-secondary/30 px-1.5 py-2 text-center">
      <CheckCircle2 className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="line-clamp-2 text-[10px] font-medium leading-tight text-muted-foreground">
        {label}
      </span>
      <button
        type="button"
        onClick={onClear}
        className="text-[9px] font-medium text-accent hover:underline"
      >
        Undo
      </button>
    </div>
  );
}

const BUILDING_CONDITION_TONE: Record<string, string> = {
  Good: "bg-success/15 text-success",
  Fair: "bg-warning/15 text-warning-foreground",
  Poor: "bg-destructive/10 text-destructive",
  Unknown: "bg-secondary/60 text-muted-foreground",
};

// One row of Module 5's Building Condition Overview. condition/hasPhoto/
// notApplicable are server-enforced (see enforceBuildingComponentRealData)
// — this component just renders whatever it's given, never re-decides "no
// photo" itself.
function BuildingComponentRow({
  c,
  onUploadClick,
  onMarkNotApplicable,
  onClearNotApplicable,
}: {
  c: ModuleResultMap["improvement"]["buildingComponents"][number];
  // Optional — the modal already has the "Add Evidence" upload section in
  // the same view, so its rows render without a redundant button; the
  // card's rows pass onOpen (opens this module's own modal, where that
  // section lives).
  onUploadClick?: () => void;
  // Optional for the same reason — only the modal's rows offer the N/A
  // escape hatch, matching onUploadClick's own pattern.
  onMarkNotApplicable?: () => void;
  onClearNotApplicable?: () => void;
}) {
  return (
    <div className="card-elev p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold">{c.component}</span>
            <span
              className={`shrink-0 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${c.notApplicable ? "bg-secondary/60 text-muted-foreground" : BUILDING_CONDITION_TONE[c.condition]}`}
            >
              {c.hasPhoto ? c.condition : c.notApplicable ? "Not Applicable" : "No Photo Provided"}
            </span>
          </div>
          {c.hasPhoto ? (
            <>
              {c.notes && <p className="mt-0.5 text-xs text-muted-foreground">{c.notes}</p>}
              {c.actionNeeded && (
                <p className="mt-0.5 text-xs font-medium text-foreground/80">{c.actionNeeded}</p>
              )}
            </>
          ) : c.notApplicable ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Marked not applicable — no photo available for this component.
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Upload a photo showing the {c.component.toLowerCase()} to assess condition.
            </p>
          )}
        </div>
      </div>
      {!c.hasPhoto && c.notApplicable && onClearNotApplicable && (
        <button
          onClick={onClearNotApplicable}
          className="mt-1.5 text-xs text-accent hover:underline"
        >
          Undo — I can upload a photo
        </button>
      )}
      {!c.hasPhoto && !c.notApplicable && (onUploadClick || onMarkNotApplicable) && (
        <div className="mt-1.5 flex items-center gap-3">
          {onUploadClick && (
            <button onClick={onUploadClick} className="text-xs text-accent hover:underline">
              Upload Photo →
            </button>
          )}
          {onMarkNotApplicable && (
            <button
              onClick={onMarkNotApplicable}
              className="text-xs text-muted-foreground underline decoration-dotted hover:text-foreground"
            >
              Mark Not Applicable
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// The reference's 5-step explainer strip — purely describes a pipeline that
// now genuinely exists (this module's own real photo-grounded assessment +
// deterministic depreciation math), not a claim about this property. Fixed,
// not data-driven — same spirit as a product diagram, not an AI output.
const PIPELINE_STEPS: { label: string; sub: string; icon: LucideIcon }[] = [
  { label: "User Input", sub: "Building Data, Photos", icon: FileText },
  { label: "AI Processing", sub: "Condition Analyzer", icon: Wrench },
  { label: "Logic/Decision", sub: "Depreciation Model", icon: BarChart3 },
  { label: "AI Output", sub: "Condition Assessment", icon: Activity },
  { label: "Next Step", sub: "Apply to Value Model", icon: ArrowRight },
];

function PipelineDiagram() {
  return (
    <div className="grid grid-cols-5 gap-1">
      {PIPELINE_STEPS.map((step, i) => (
        <div key={step.label} className="flex flex-col items-center gap-1 text-center">
          <div className="flex items-center gap-1">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-secondary/60 text-muted-foreground">
              <step.icon className="h-3.5 w-3.5" />
            </div>
            {i < PIPELINE_STEPS.length - 1 && (
              <ArrowRight className="hidden h-3 w-3 shrink-0 text-muted-foreground sm:block" />
            )}
          </div>
          <div className="text-[9px] font-semibold uppercase tracking-wide">{step.label}</div>
          <div className="line-clamp-2 text-[8px] leading-tight text-muted-foreground">
            {step.sub}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- Reference-infographic chrome shared by every module: a
// numbered badge (ModuleCard header + modal header) and a one-line colored
// insight banner on each card, derived from data already loaded elsewhere
// in this file — no new AI calls, just a deterministic read of state that's
// already here (score thresholds, sorted factors, etc.).
function NumberBadge({
  n,
  color,
  size = "sm",
}: {
  n: number;
  color: IconColor;
  size?: "sm" | "lg";
}) {
  const dim = size === "lg" ? "h-8 w-8 text-sm" : "h-5 w-5 text-[10px]";
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-full font-bold text-white ${dim}`}
      style={{ backgroundColor: color.solid }}
    >
      {n}
    </span>
  );
}

function moduleInsight(
  m: Module,
  moduleState: ModuleAsyncState | undefined,
  compsMap: { data: CompsResult | null; loading: boolean },
  estimated: { savings: number },
  totalValue: number | null | undefined,
  overrides: ModuleOverride[],
): string | null {
  if (m.id === "income") {
    return isModuleNotApplicable(overrides, "income")
      ? "Marked Not Applicable"
      : "Upload financials to unlock";
  }
  if (m.id === "savings") return estimated.savings > 0 ? "Strong Potential Savings" : null;
  if (!moduleState?.data) return null;
  switch (m.id) {
    case "health": {
      const d = moduleState.data as HealthScoreResult;
      return d.score >= 70
        ? "Strong Opportunity"
        : d.score >= 40
          ? "Moderate Opportunity"
          : "Limited Opportunity";
    }
    case "strategy": {
      const d = moduleState.data as ModuleResultMap["strategy"];
      if (d.strategies.length === 0) return null;
      if (d.topStrategySummary) return d.topStrategySummary;
      const top = d.strategies.slice(0, 2).map((s) => s.name);
      return `AI recommends focus on ${top.join(" & ")}`;
    }
    case "comps": {
      const stats = computeComparableStats(
        compsMap.data?.subject ?? null,
        compsMap.data?.comps ?? [],
        totalValue,
      );
      if (stats.limitedData || stats.valuationGapPct == null) return null;
      return stats.valuationGapPct > 0 ? "Potential Overvaluation" : "Fairly Valued";
    }
    case "site":
    case "improvement": {
      const d = moduleState.data as ModuleResultMap["site"] | ModuleResultMap["improvement"];
      return d.priorityScore >= 70
        ? "High Documentation Priority"
        : d.priorityScore >= 40
          ? "Moderate Documentation Priority"
          : "Low Documentation Priority";
    }
    case "zoning": {
      const d = moduleState.data as ModuleResultMap["zoning"];
      return ZONING_STATUS[d.matches].label;
    }
    case "evidence": {
      const d = moduleState.data as ModuleResultMap["evidence"];
      const gaps = d.items.filter((i) => i.importance === "High" && i.availability === "Low");
      return gaps.length > 0 ? "Focus Here First" : "Evidence Well Covered";
    }
    case "executive": {
      const d = moduleState.data as ModuleResultMap["executive"];
      return d.recommendedAction;
    }
    default:
      return null;
  }
}

// Full-bleed band flush with the card's own edges (the card is
// overflow-hidden so this never pokes past its rounded corners) — matches
// the reference infographic's solid colored footer bars, rather than an
// inset rounded pill floating inside the card's padding.
// Clickable — this band is the card's primary "open the full module"
// affordance now that the separate "View report" button is gone. The whole
// strip is the hit target; the arrow nudges right on hover to read as a link.
function InsightBanner({
  text,
  color,
  onClick,
}: {
  text: string;
  color: IconColor;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex w-full items-center justify-between gap-2 px-5 py-2.5 text-left text-sm font-semibold transition-[filter] hover:brightness-95 ${color.bg} ${color.text}`}
    >
      <span className="min-w-0 flex-1 truncate group-hover:underline">{text}</span>
      <ArrowRight className="h-4 w-4 shrink-0 transition-transform group-hover:translate-x-1" />
    </button>
  );
}

// Generic icon+text row for free-text AI checklist items (Improvement
// Condition — Site Condition moved to a real structured 14-factor table,
// see SiteFactorRow) — deliberately the SAME icon for every row rather than
// guessing a specific category from unstructured text the AI never actually
// categorized.
// Real satellite thumbnail for Site Condition, reusing the subject
// property's own coordinates — already loaded for every visitor via the
// comps fetch (see loadCompsMap() in Report()), not a second API call.
// Only renders when that data exists (TrueProdigy-backed counties only,
// same real-data gate CompsMap/CompsValueScatter already use); Site Condition
// falls back to just the checklist rows everywhere else. Esri World
// Imagery is a free, no-API-key satellite tile source, attributed per its
// terms the same way CompsMap already attributes OpenStreetMap.
function SiteMapThumb({ lat, lng, height = 140 }: { lat: number; lng: number; height?: number }) {
  const mods = useLeaflet();
  if (!mods) {
    return (
      <div
        className="animate-pulse rounded-lg border border-border bg-secondary/40"
        style={{ height }}
      />
    );
  }
  const { L, MapContainer, TileLayer, Marker } = mods;
  const icon = L.divIcon({
    className: "",
    html: `<div style="width:14px;height:14px;border-radius:9999px;background:var(--accent);border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.45);"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
  // Leaflet's default attribution control (including its "Leaflet" link and
  // built-in donation flag icon) is sized for a full map, not an 80px card
  // thumbnail — at that size it visually swallows most of the tile image.
  // Below that threshold we drop the control and show a minimal text credit
  // instead, which still satisfies Esri's attribution requirement; the
  // larger 220px modal map keeps Leaflet's normal control.
  const compact = height < 150;
  return (
    <div className="relative overflow-hidden rounded-lg border border-border" style={{ height }}>
      <MapContainer
        center={[lat, lng]}
        zoom={17}
        zoomControl={false}
        attributionControl={!compact}
        dragging={false}
        scrollWheelZoom={false}
        doubleClickZoom={false}
        touchZoom={false}
        style={{ height: "100%", width: "100%" }}
      >
        <TileLayer
          attribution="Tiles &copy; Esri"
          url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
        />
        <Marker position={[lat, lng]} icon={icon} />
      </MapContainer>
      {compact && (
        <span className="pointer-events-none absolute bottom-0 right-0 rounded-tl bg-black/45 px-1 text-[8px] leading-tight text-white">
          Tiles © Esri
        </span>
      )}
    </div>
  );
}

// A generic multi-story commercial building — deliberately not a photo or a
// rendering of THIS specific property (this app has no building imagery for
// any property, and Street View Static API isn't enabled on this project's
// Google Cloud key — confirmed live, not something to fake). A static
// illustration instead, made to actually read as a building: two lit faces
// (front + side, gradient-shaded for depth) with mullioned, reflective
// windows, a stepped rooftop with a mechanical unit and cornice line, an
// entrance canopy over real double doors, and a soft ground shadow.
// Colored entirely from the app's own theme tokens, gradients included, so
// it never needs its own light/dark variant.
function BuildingIllustration({ className }: { className?: string }) {
  const windowRows = [26, 38, 50, 62, 74];
  const windowCols = [25, 39, 53];
  return (
    <svg viewBox="0 0 120 105" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="bldgFront" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--card)" />
          <stop offset="100%" stopColor="var(--secondary)" />
        </linearGradient>
        <linearGradient id="bldgSide" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--muted-foreground)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="var(--muted-foreground)" stopOpacity="0.48" />
        </linearGradient>
        <linearGradient id="bldgGlass" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.4" />
          <stop offset="100%" stopColor="var(--muted-foreground)" stopOpacity="0.28" />
        </linearGradient>
        <radialGradient id="bldgShadow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--border)" stopOpacity="0.55" />
          <stop offset="100%" stopColor="var(--border)" stopOpacity="0" />
        </radialGradient>
      </defs>

      <ellipse cx="57" cy="97" rx="48" ry="6" fill="url(#bldgShadow)" />

      {/* Roof */}
      <polygon points="19,26 65,26 91,15 45,15" fill="var(--border)" />
      <polygon points="19,26 65,26 63,29 21,29" fill="var(--muted-foreground)" opacity="0.25" />
      <rect x="48" y="8" width="14" height="8" rx="1" fill="var(--border)" />
      <rect
        x="50"
        y="6"
        width="10"
        height="3"
        rx="0.5"
        fill="var(--muted-foreground)"
        opacity="0.4"
      />
      <line x1="77" y1="15" x2="77" y2="4" stroke="var(--muted-foreground)" strokeWidth="1.25" />
      <circle cx="77" cy="4" r="1.5" fill="var(--muted-foreground)" opacity="0.6" />

      {/* Side face */}
      <polygon points="65,26 91,15 91,85 65,96" fill="url(#bldgSide)" />
      <polygon points="65,26 91,15 91,20 65,31" fill="var(--muted-foreground)" opacity="0.15" />

      {/* Front face */}
      <rect x="19" y="26" width="46" height="70" fill="url(#bldgFront)" />
      <rect
        x="19"
        y="26"
        width="46"
        height="70"
        fill="none"
        stroke="var(--border)"
        strokeWidth="0.75"
      />
      {/* Cornice */}
      <rect x="19" y="26" width="46" height="3" fill="var(--border)" />

      {windowRows.map((y) =>
        windowCols.map((x) => (
          <g key={`${x}-${y}`}>
            <rect x={x} y={y} width="9" height="8" rx="0.5" fill="url(#bldgGlass)" />
            <line
              x1={x + 4.5}
              y1={y}
              x2={x + 4.5}
              y2={y + 8}
              stroke="var(--card)"
              strokeWidth="0.5"
              opacity="0.6"
            />
            <line
              x1={x}
              y1={y + 4}
              x2={x + 9}
              y2={y + 4}
              stroke="var(--card)"
              strokeWidth="0.5"
              opacity="0.6"
            />
            <line
              x1={x + 1}
              y1={y + 1}
              x2={x + 3.5}
              y2={y + 1}
              stroke="var(--card)"
              strokeWidth="0.8"
              opacity="0.7"
            />
          </g>
        )),
      )}

      {/* Entrance canopy + double doors */}
      <rect x="32" y="85" width="22" height="2" fill="var(--border)" />
      <rect
        x="35"
        y="87"
        width="8"
        height="9"
        rx="0.5"
        fill="var(--muted-foreground)"
        opacity="0.55"
      />
      <rect
        x="43"
        y="87"
        width="8"
        height="9"
        rx="0.5"
        fill="var(--muted-foreground)"
        opacity="0.55"
      />
      <line x1="43" y1="87" x2="43" y2="96" stroke="var(--border)" strokeWidth="0.75" />
    </svg>
  );
}

// Real FEMA flood zone, floated over the site map's corner — a point fact
// (this app has no parcel boundary to shade an actual overlay polygon with),
// never shown at all when siteGis hasn't resolved a real zone (see
// loadSiteGis() in Report()). Colored by inSFHA — the real Special Flood
// Hazard Area boolean FEMA returns, not a guess.
function FloodZoneBadge({ floodZone }: { floodZone: SiteGisResult["floodZone"] | undefined }) {
  if (!floodZone) return null;
  return (
    <div
      className={`absolute left-1.5 top-1.5 rounded-full px-1.5 py-0.5 text-[9px] font-semibold text-white shadow ${
        floodZone.inSFHA ? "bg-destructive" : "bg-success"
      }`}
      title={floodZone.label}
    >
      Zone {floodZone.zone}
    </div>
  );
}

// Card's condensed constraint -> impact chain (the card's own version of
// Module 4's full "AI Impact Analysis" flow in the modal) — only ever built
// from a factor that pickHeadlineFactor() already confirmed has real/partial
// data, so this never shows a fabricated finding.
// Card's own version of the reference's "AI Impact Analysis" vertical
// arrow chain — built entirely from the SAME real structured fields the
// modal's table shows for this one factor (finding -> potentialImpact ->
// a severity-derived relevance label -> evidenceNeeded as the recommended
// next step), not new AI output. Only ever called with a factor
// pickHeadlineFactor() already confirmed has real/partial data.
function SiteImpactChain({ factor }: { factor: SiteFactor }) {
  const tone =
    factor.severity === "High"
      ? "text-destructive"
      : factor.severity === "Moderate"
        ? "text-warning-foreground"
        : "text-success";
  const relevance =
    factor.severity === "High"
      ? "High Valuation Relevance"
      : factor.severity === "Moderate"
        ? "Moderate Valuation Relevance"
        : "Low Valuation Relevance";
  const steps: { text: string; tone?: string }[] = [
    { text: `${factor.factor}: ${factor.finding}`, tone },
    ...(factor.potentialImpact ? [{ text: factor.potentialImpact }] : []),
    { text: relevance, tone },
    ...(factor.evidenceNeeded ? [{ text: `Next: ${factor.evidenceNeeded}` }] : []),
  ];
  return (
    <div className="grid gap-0.5">
      {steps.map((step, i) => (
        <div key={i} className="grid justify-items-center gap-0.5">
          {i > 0 && <ArrowDown className="h-2.5 w-2.5 text-muted-foreground" />}
          <div
            className={`w-full truncate rounded-md bg-secondary/40 px-1.5 py-1 text-center text-[9px] font-medium ${step.tone ?? "text-foreground"}`}
            title={step.text}
          >
            {step.text}
          </div>
        </div>
      ))}
    </div>
  );
}

function ChecklistIconRows({ items, color }: { items: string[]; color: IconColor }) {
  return (
    <div className="grid gap-1">
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-2 rounded-md bg-secondary/40 px-2 py-1.5">
          <span
            className={`grid h-5 w-5 shrink-0 place-items-center rounded-full ${color.bg} ${color.text}`}
          >
            <AlertTriangle className="h-3 w-3" />
          </span>
          <span className="min-w-0 flex-1 line-clamp-2 text-xs">{item}</span>
        </div>
      ))}
    </div>
  );
}

// Icon for a ranked strategy — reuses the Module's own icon for the 5 fixed
// strategies (so "Comparable Sales" shows the same icon as the Market Value
// module card, etc.) via relatedModules; falls back to a generic icon for an
// AI-added "Other: ..." strategy, which doesn't map to any of Modules 3-7.
// Visual cue for Module 10's Recommended Action banner — a glance-able icon
// standing in for reading the category string closely.
function RecommendedActionIcon({
  action,
  className,
}: {
  action: ModuleResultMap["executive"]["recommendedAction"];
  className?: string;
}) {
  const Icon =
    action === "Proceed with Protest"
      ? ShieldCheck
      : action === "Proceed with Protest After Completing Recommended Evidence"
        ? FileWarning
        : action === "Limited Protest Opportunity Based on Available Information"
          ? AlertTriangle
          : HelpCircle;
  return <Icon className={className} />;
}

function strategyIcon(s: StrategyEntry): LucideIcon {
  const relatedId = s.relatedModules[0];
  const mod = relatedId ? MODULES.find((mm) => mm.id === relatedId) : undefined;
  return mod?.icon ?? Target;
}

// Stable per-strategy key for tagging uploaded evidence (documents.document_type,
// see handleUploadEvidence in Report()) and storing the free-text evidence-gate
// answer (IntakeState.strategyAnswers) — derived from the AI's own strategy name
// so no separate id/lookup table is needed.
function strategySlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Same stable-slug convention as strategySlug above, for Module 8's own
// evidence-checklist items — used to tag an upload with the exact checklist
// category it belongs to (documentType `Evidence Category: ${slug}`, see
// EvidenceCategoryRow below), so a document uploaded under one category
// keeps showing there even if the AI's own item wording shifts slightly on
// a later regenerate (the same real real-world category, matched by slug,
// not by exact string).
function evidenceItemSlug(item: string): string {
  return item
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Compact ranked row for the card preview — used by both ModuleVisual's
// "strategy" case and StrategyDetail's header below. Row order itself
// already conveys rank (top = strongest), so no separate number badge.
function StrategyBar({ s }: { s: StrategyEntry }) {
  const Icon = strategyIcon(s);
  return (
    <div className="flex items-center gap-2.5">
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-muted-foreground">{s.name}</div>
        <div className="h-1.5 rounded-full bg-secondary/60">
          <div
            className="h-1.5 rounded-full"
            style={{ width: `${s.strengthScore}%`, backgroundColor: scoreColor(s.strengthScore) }}
          />
        </div>
      </div>
      {s.dataSufficient ? (
        <span
          className="w-7 shrink-0 text-right text-xs font-semibold"
          style={{ color: scoreColor(s.strengthScore) }}
        >
          {s.strengthScore}
        </span>
      ) : (
        <span className="shrink-0 whitespace-nowrap rounded-full bg-warning/20 px-1.5 py-0.5 text-[9px] font-semibold text-warning-foreground">
          Data Needed
        </span>
      )}
    </div>
  );
}

function StrategyRankList({
  strategies,
  color,
  max,
}: {
  strategies: StrategyEntry[];
  color: IconColor;
  max?: number;
}) {
  const shown = max ? strategies.slice(0, max) : strategies;
  return (
    <div className="grid gap-2 [&>*]:min-w-0">
      {shown.map((s) => (
        <StrategyBar key={s.name} s={s} />
      ))}
    </div>
  );
}

// Full per-strategy breakdown for the modal — why AI selected it, supporting
// findings, valuation relevance, existing/missing evidence, confidence, and
// recommended investigation, all real fields from the "strategy" MODULE_SPEC
// (see supabase/functions/ai-report-modules/index.ts). When the AI flagged
// dataSufficient false, this also renders the evidence gate: an upload button
// (tagging the file with this strategy via handleUploadEvidence's strategyId
// param) and a free-text answer fallback — if the user supplies neither, the
// score still shows but is marked as an unguaranteed estimate, per the
// non-blocking evidence-gate design (Module 2 never renders an empty state).
function StrategyDetail({
  s,
  rank,
  color,
  evidenceDocs,
  uploadingEvidence,
  onUploadEvidence,
  answer,
  onAnswerStrategy,
  onRefresh,
  refreshing,
}: {
  s: StrategyEntry;
  rank: number;
  color: IconColor;
  evidenceDocs: DocumentRecord[];
  uploadingEvidence: boolean;
  onUploadEvidence: (files: File[], strategyId: string) => void;
  answer: string | undefined;
  onAnswerStrategy: (strategyId: string, answer: string) => void;
  // Re-runs the whole Strategy module (the AI returns every strategy in one
  // pass — there's no per-strategy call), which is what a user wants after
  // uploading evidence for this one. Same handler as the card's header spinner.
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const Icon = strategyIcon(s);
  const slug = strategySlug(s.name);
  const uploaded = evidenceDocs.filter((d) => d.documentType === `Strategy Evidence: ${slug}`);
  const [draft, setDraft] = useState(answer ?? "");
  const hasAnyEvidence = uploaded.length > 0 || !!answer?.trim();

  return (
    <div className="card-elev min-w-0 p-4">
      <div className="flex items-center gap-2.5">
        <NumberBadge n={rank} color={color} size="sm" />
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{s.name}</div>
          {s.primaryReason && (
            <div className="truncate text-xs text-muted-foreground">{s.primaryReason}</div>
          )}
        </div>
        {s.dataSufficient ? (
          <span
            className="shrink-0 font-serif text-lg font-bold"
            style={{ color: scoreColor(s.strengthScore) }}
          >
            {s.strengthScore}
          </span>
        ) : (
          <span className="shrink-0 whitespace-nowrap rounded-full bg-warning/20 px-2 py-1 text-[10px] font-semibold text-warning-foreground">
            Additional Data Needed
          </span>
        )}
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            title="Re-run strategy analysis"
            aria-label="Re-run strategy analysis"
            className="shrink-0 rounded-full p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:cursor-default disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          </button>
        )}
      </div>

      <div className="mt-3 grid gap-2.5 text-xs sm:grid-cols-2 [&>div]:min-w-0">
        {s.whySelected && (
          <div>
            <div className="font-semibold text-foreground">Why AI selected it</div>
            <p className="break-words text-muted-foreground">{s.whySelected}</p>
          </div>
        )}
        {s.supportingFindings && (
          <div>
            <div className="font-semibold text-foreground">Supporting findings</div>
            <p className="break-words text-muted-foreground">{s.supportingFindings}</p>
          </div>
        )}
        {s.valuationRelevance && (
          <div>
            <div className="font-semibold text-foreground">Potential valuation relevance</div>
            <p className="break-words text-muted-foreground">{s.valuationRelevance}</p>
          </div>
        )}
        {s.recommendedInvestigation && (
          <div>
            <div className="font-semibold text-foreground">Recommended investigation</div>
            <p className="break-words text-muted-foreground">{s.recommendedInvestigation}</p>
          </div>
        )}
      </div>

      {(s.existingEvidence.length > 0 || s.missingEvidence.length > 0) && (
        <div className="mt-3 grid gap-2.5 sm:grid-cols-2 [&>div]:min-w-0">
          {s.existingEvidence.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-success">
                Existing Evidence
              </div>
              <ul className="mt-1 grid gap-0.5 text-xs text-muted-foreground">
                {s.existingEvidence.map((e, i) => (
                  <li key={i}>• {e}</li>
                ))}
              </ul>
            </div>
          )}
          {s.missingEvidence.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-warning-foreground">
                Missing Evidence
              </div>
              <ul className="mt-1 grid gap-0.5 text-xs text-muted-foreground">
                {s.missingEvidence.map((e, i) => (
                  <li key={i}>• {e}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="mt-3">
        <MiniMeter value={s.confidencePct} label="Confidence" />
      </div>

      {s.relatedModules.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {s.relatedModules.map((id) => {
            const relatedModule = MODULES.find((mm) => mm.id === id);
            return relatedModule ? <Chip key={id}>Related: {relatedModule.shortName}</Chip> : null;
          })}
        </div>
      )}

      {!s.dataSufficient && (
        <div className="mt-3 border-t border-border/60 pt-3 print:hidden">
          <div className="text-xs font-semibold text-warning-foreground">
            Additional Data Needed
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Upload supporting documents or answer below so AI can complete this strategy with real
            evidence.
          </p>
          {uploaded.length > 0 && (
            <ul className="mt-2 grid gap-0.5 text-xs text-muted-foreground">
              {uploaded.map((d) => (
                <li key={d.id}>{d.fileName}</li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label
              className={`btn-outline text-xs cursor-pointer ${uploadingEvidence ? "pointer-events-none opacity-60" : ""}`}
            >
              {uploadingEvidence ? "Uploading…" : "Upload Evidence"}
              <input
                type="file"
                accept="image/*,.pdf"
                multiple
                className="hidden"
                disabled={uploadingEvidence}
                onChange={(e) => {
                  const selected = e.target.files ? Array.from(e.target.files) : [];
                  e.target.value = "";
                  if (selected.length > 0) onUploadEvidence(selected, slug);
                }}
              />
            </label>
          </div>
          <div className="mt-2 flex gap-2">
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Or type an answer instead…"
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs"
            />
            <button
              type="button"
              disabled={!draft.trim()}
              onClick={() => onAnswerStrategy(slug, draft.trim())}
              className="btn-outline text-xs disabled:opacity-50"
            >
              Save
            </button>
          </div>
          {!hasAnyEvidence && (
            <p className="mt-2 text-[11px] italic text-muted-foreground">
              Estimate — not guaranteed, missing evidence.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// A "how the analysis flows" ribbon — User Input → AI Processing →
// Logic/Decision → AI Output → Next Step. Purely a process cue; each step
// carries its own eyebrow (the stage), a short label, and an icon so a
// module can name its own pipeline. The AI-output step is accented.
function AnalysisPipeline({
  steps,
}: {
  steps: { eyebrow: string; label: string; Icon: LucideIcon; current?: boolean }[];
}) {
  return (
    <div className="flex items-stretch gap-1 overflow-x-auto pb-1">
      {steps.map((s, i) => (
        <Fragment key={s.label}>
          <div
            className={`flex w-[108px] shrink-0 flex-col items-center gap-1 rounded-lg px-2 py-2 text-center ${
              s.current ? "bg-accent/15 ring-1 ring-accent/30" : "bg-secondary/50"
            }`}
          >
            <s.Icon
              className={`h-4 w-4 ${s.current ? "text-accent" : "text-muted-foreground"}`}
            />
            <div
              className={`text-[8px] font-bold uppercase leading-none tracking-wide ${
                s.current ? "text-accent" : "text-muted-foreground"
              }`}
            >
              {s.eyebrow}
            </div>
            <div className="text-[10px] font-medium leading-tight text-foreground">{s.label}</div>
          </div>
          {i < steps.length - 1 && (
            <ArrowRight className="h-3.5 w-3.5 shrink-0 self-center text-muted-foreground" />
          )}
        </Fragment>
      ))}
    </div>
  );
}

const ZONING_ASPECT_STATUS: Record<
  ModuleResultMap["zoning"]["aspects"][number]["status"],
  { label: string; cls: string; Icon: LucideIcon; iconCls: string }
> = {
  Confirmed: {
    label: "Confirmed",
    cls: "bg-success/15 text-success",
    Icon: CheckCircle2,
    iconCls: "text-success",
  },
  "Partial Data": {
    label: "Partial",
    cls: "bg-warning/20 text-warning-foreground",
    Icon: AlertTriangle,
    iconCls: "text-warning-foreground",
  },
  "Additional Data Needed": {
    label: "Needs data",
    cls: "bg-secondary text-muted-foreground",
    Icon: HelpCircle,
    iconCls: "text-muted-foreground",
  },
};

const ZONING_ASPECT_ICON: Record<string, LucideIcon> = {
  "CAD Classification": FileText,
  "Actual Use": Building2,
  "Zoning District": MapPin,
  "Permitted Use": CheckCircle2,
};

// The 4-column classification line-up from the spec's screenshot: the four
// aspects are the columns, one value row, then a muted source / upload row.
// The Permitted Use column also carries the overall consistent/mismatch mark.
function ZoningClassificationTable({
  aspects,
  matches,
  onUpload,
  uploading,
}: {
  aspects: ModuleResultMap["zoning"]["aspects"];
  matches: keyof typeof ZONING_STATUS;
  onUpload?: (aspectLabel: string, files: File[]) => void;
  uploading?: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[560px] table-fixed text-left text-xs">
        <thead className="bg-secondary/60 text-[10px] uppercase tracking-wide text-muted-foreground">
          <tr>
            {aspects.map((a) => (
              <th key={a.label} className="px-3 py-2 font-semibold">
                {a.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="border-t border-border/60 align-top">
            {aspects.map((a) => {
              const st = ZONING_ASPECT_STATUS[a.status];
              const isPermitted = a.label === "Permitted Use";
              const showMismatch = isPermitted && matches === "inconsistent";
              const showMatch = isPermitted && matches === "consistent";
              return (
                <td key={a.label} className="px-3 py-2">
                  <div className="flex items-start gap-1.5">
                    {showMismatch ? (
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                    ) : showMatch ? (
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                    ) : (
                      <st.Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${st.iconCls}`} />
                    )}
                    <span
                      className={`font-medium ${showMismatch ? "text-destructive" : "text-foreground"}`}
                    >
                      {a.value || "—"}
                    </span>
                  </div>
                </td>
              );
            })}
          </tr>
          <tr className="border-t border-border/40 align-top text-[10px] text-muted-foreground">
            {aspects.map((a) => (
              <td key={a.label} className="px-3 py-2">
                <div>{a.source || "—"}</div>
                {onUpload && a.status === "Additional Data Needed" && (
                  <label className="mt-1 inline-flex cursor-pointer items-center gap-1 rounded-full border border-accent/40 px-2 py-0.5 font-semibold text-accent hover:bg-accent/10">
                    <input
                      type="file"
                      accept="image/*,.pdf"
                      multiple
                      disabled={uploading}
                      className="hidden"
                      onChange={(e) => {
                        const sel = Array.from(e.target.files ?? []);
                        if (sel.length > 0) onUpload(a.label, sel);
                        e.target.value = "";
                      }}
                    />
                    <Upload className="h-3 w-3" />
                    {uploading ? "Uploading…" : "Upload"}
                  </label>
                )}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// Compact card visual — the 4 classification aspects as small icon tiles,
// branching into a Matches / Mismatch outcome, then a "verify" call to
// action. Mirrors the spec's card screenshot in the app's own light styling.
function ZoningAspectTiles({
  aspects,
  matches,
}: {
  aspects: ModuleResultMap["zoning"]["aspects"];
  matches: keyof typeof ZONING_STATUS;
}) {
  const consistent = matches === "consistent";
  const uncertain = matches === "uncertain";
  return (
    <div>
      <div className="grid grid-cols-4 gap-1.5">
        {aspects.map((a) => {
          const st = ZONING_ASPECT_STATUS[a.status];
          const Icon = ZONING_ASPECT_ICON[a.label] ?? FileText;
          return (
            <div key={a.label} className="rounded-lg bg-secondary/50 p-2 text-center">
              <Icon className="mx-auto h-4 w-4 text-muted-foreground" />
              <div className="mt-1 text-[8px] uppercase leading-tight tracking-wide text-muted-foreground">
                {a.label}
              </div>
              <span
                className={`mt-1 inline-block rounded-full px-1.5 py-0.5 text-[8px] font-semibold ${st.cls}`}
              >
                {st.label}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mx-auto my-1.5 h-3 w-px bg-border" />
      <div className="grid grid-cols-2 gap-2 text-center">
        <div
          className={`rounded-lg border p-2 ${
            consistent ? "border-success/40 bg-success/10" : "border-border bg-secondary/30 opacity-50"
          }`}
        >
          <div className="flex items-center justify-center gap-1 text-xs font-bold text-success">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Matches
          </div>
          <div className="text-[10px] text-muted-foreground">No issue</div>
        </div>
        <div
          className={`rounded-lg border p-2 ${
            !consistent && !uncertain
              ? "border-destructive/40 bg-destructive/10"
              : "border-border bg-secondary/30 opacity-50"
          }`}
        >
          <div className="flex items-center justify-center gap-1 text-xs font-bold text-destructive">
            <AlertTriangle className="h-3.5 w-3.5" />
            Mismatch
          </div>
          <div className="text-[10px] text-muted-foreground">May impact value or exemptions</div>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-center gap-2 rounded-lg bg-accent/10 px-3 py-2 text-xs font-semibold text-accent">
        <Scale className="h-4 w-4 shrink-0" />
        Verify &amp; support any discrepancies
        <ArrowRight className="h-3.5 w-3.5 shrink-0" />
      </div>
    </div>
  );
}

function ZoningImpactCol({
  title,
  tone = "success",
  children,
}: {
  title: string;
  tone?: "success" | "accent";
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div
        className={`mb-1 text-[10px] font-semibold uppercase tracking-wide ${
          tone === "accent" ? "text-accent" : "text-success"
        }`}
      >
        {title}
      </div>
      <div className="text-xs text-muted-foreground">{children}</div>
    </div>
  );
}

// Second formula row for Tax Savings & ROI — Protest Cost / Net Benefit
// derived from the real 25% contingency fee already stated as CorvusPT's
// actual terms in ProtestAuthorizationFlow's AGREEMENT (src/components/
// ProtestAuthorizationFlow.tsx), not an invented number.
const CONTINGENCY_FEE_PCT = 0.25;

function CostBenefitRow({ savings }: { savings: number }) {
  const cost = Math.round(savings * CONTINGENCY_FEE_PCT);
  const netBenefit = savings - cost;
  return (
    <div className="flex items-center justify-center gap-1.5">
      <FormulaIcon
        Icon={DollarSign}
        value={compactCurrency(cost)}
        label="protest cost (25%)"
        tone="bg-violet-500/15 text-violet-600"
      />
      <span className="text-sm text-muted-foreground">−</span>
      <FormulaIcon
        Icon={BarChart3}
        value={compactCurrency(netBenefit)}
        label="net benefit"
        tone="bg-success/15 text-success"
      />
    </div>
  );
}

function SkeletonVisual() {
  return (
    <div className="grid gap-2">
      <div className="h-6 w-16 animate-pulse rounded bg-secondary/60" />
      <div className="h-3 w-28 animate-pulse rounded bg-secondary/40" />
    </div>
  );
}

// Icon per Module 1 score-breakdown label — the fixed label set the edge
// function validates against (BREAKDOWN_LABELS in ai-health-score/index.ts),
// so this mapping is safe/exhaustive rather than guessing at free AI text.
function breakdownIcon(label: string): LucideIcon {
  switch (label) {
    case "CAD Valuation":
      return FileText;
    case "Comparable Properties":
      return BarChart3;
    case "Market Data":
      return Percent;
    case "Property Condition":
      return Wrench;
    case "Historical Valuation":
      return Activity;
    default:
      return Target;
  }
}

// Half-circle "speedometer" gauge — a full red→amber→green gradient scale
// (the property's whole possible-score range, always shown) with a bold
// scoreColor()-toned progress arc on top marking the actual score, plus the
// number centered underneath. Combines the two reference looks: reference 1's
// bold filled progress against a duller full scale, reference 2's full-width
// half-circle gradient presentation. Used for Module 1 at both a compact
// (card) and large (modal) size — replaces the old MiniGauge/RadialGauge,
// which only this module used.
function SpeedometerGauge({ value, size = "md" }: { value: number; size?: "sm" | "md" | "lg" }) {
  const color = gradualScoreColor(value);
  const dims =
    size === "lg"
      ? { w: 240, h: 132, bar: 16, font: "text-4xl" }
      : size === "sm"
        ? { w: 140, h: 80, bar: 10, font: "text-xl" }
        : { w: 180, h: 100, bar: 12, font: "text-2xl" };
  // Single RadialBar with chart-level `data` + the `background` prop for the
  // auto-drawn full-arc track — the same proven pattern the old MiniGauge/
  // RadialGauge used, just at a half-circle angle. An earlier version tried
  // two <RadialBar>s each with their own per-bar `data` override (one for a
  // full gradient scale, one for the value) to combine both reference looks
  // more closely, but that silently rendered zero bars in this Recharts
  // version (confirmed via a live console error and an empty sectors group)
  // — reverted in favor of this reliable single-bar approach.
  return (
    <div className="relative mx-auto" style={{ width: dims.w, height: dims.h }}>
      <ResponsiveContainer width="100%" height="100%">
        <RadialBarChart
          cx="50%"
          cy="100%"
          startAngle={180}
          endAngle={0}
          innerRadius={dims.w / 2 - dims.bar - 4}
          outerRadius={dims.w / 2 - 4}
          barSize={dims.bar}
          data={[{ value, fill: color }]}
        >
          <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
          <RadialBar background dataKey="value" cornerRadius={999} />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center">
        <div className={`${dims.font} font-bold leading-none`} style={{ color }}>
          <AnimatedNumber value={value} />
        </div>
        <div className="text-[10px] text-muted-foreground">/100</div>
      </div>
    </div>
  );
}

function ScoreBreakdownList({ breakdown }: { breakdown: HealthScoreBreakdownEntry[] }) {
  if (breakdown.length === 0) return null;
  return (
    <div className="grid gap-2.5">
      {breakdown.map((b) => {
        const Icon = breakdownIcon(b.label);
        return (
          <div key={b.label} className="flex items-center gap-2.5">
            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-muted-foreground">{b.label}</span>
                <span className="text-xs font-semibold" style={{ color: scoreColor(b.score) }}>
                  {b.score}/100
                </span>
              </div>
              <div className="mt-0.5 h-1.5 rounded-full bg-secondary/60">
                <div
                  className="h-1.5 rounded-full"
                  style={{ width: `${b.score}%`, backgroundColor: scoreColor(b.score) }}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Deterministic, real, client-side-computed numbers — never AI-written —
// straight from the same state/compsMap already loaded for this property, so
// "the data behind the score" can never be an AI paraphrase or a
// hallucinated figure. Same real fields already used to ground the AI's own
// prompt (see loadModule()'s health/strategy branch above).
function SupportingDataGrid({
  state,
  compsMap,
}: {
  state: IntakeState;
  compsMap: { data: CompsResult | null; loading: boolean };
}) {
  const category = classifyPropertyCategory(state.propertyType);
  const ratio = getAssessmentRatioInfo(state.cad, category);
  const compsSummary = buildCompsSummary(compsMap.data);
  const sortedHistory = [...(state.valueHistory ?? [])].sort((a, b) => b.year - a.year);
  const latestPrior = sortedHistory.find(
    (h) => h.year < (state.taxYear ?? Infinity) && (h.appraisedValue ?? h.marketValue) != null,
  );
  const priorValue = latestPrior?.appraisedValue ?? latestPrior?.marketValue ?? null;
  const pctChange =
    priorValue && state.totalValue
      ? Math.round(((state.totalValue - priorValue) / priorValue) * 100)
      : null;

  const rows: { label: string; value: string }[] = [
    { label: "Current Assessed Value", value: currency(state.totalValue) },
  ];
  if (state.landValue != null || state.improvementValue != null) {
    rows.push({
      label: "Land / Improvement Split",
      value: `${currency(state.landValue)} / ${currency(state.improvementValue)}`,
    });
  }
  if (priorValue != null) {
    rows.push({
      label: `Prior Year Value (${latestPrior?.year})`,
      value: `${currency(priorValue)}${pctChange != null ? ` (${pctChange > 0 ? "+" : ""}${pctChange}%)` : ""}`,
    });
  }
  if (compsSummary) {
    rows.push({
      label: `Comparable Median (${compsSummary.count} comps)`,
      value: `${currency(compsSummary.median)} (range ${currency(compsSummary.min)}–${currency(compsSummary.max)})`,
    });
  }
  if (ratio) {
    rows.push({
      label: "County Assessment Ratio COD",
      value: `${ratio.cod.toFixed(1)} (median ${ratio.medianPct}%)`,
    });
  }
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {rows.map((r) => (
        <div key={r.label} className="rounded-md bg-secondary/40 px-2.5 py-1.5">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{r.label}</div>
          <div className="text-xs font-semibold">{r.value}</div>
        </div>
      ))}
    </div>
  );
}

// Same deterministic-not-AI principle as SupportingDataGrid — where each
// number actually came from, with a date where one is meaningful.
function SourcesList({
  state,
  compsMap,
  evidenceDocs,
}: {
  state: IntakeState;
  compsMap: { data: CompsResult | null; loading: boolean };
  evidenceDocs: DocumentRecord[];
}) {
  const category = classifyPropertyCategory(state.propertyType);
  const items: string[] = [];
  if (state.cad) {
    items.push(`${state.cad} public records${state.taxYear ? ` (tax year ${state.taxYear})` : ""}`);
  }
  if (compsMap.data?.comps.length) {
    items.push(
      `${compsMap.data.comps.length} real comparable properties, same CAD subdivision (as of today)`,
    );
  }
  if (getAssessmentRatioInfo(state.cad, category)) {
    items.push("Texas Comptroller property value study (assessment ratio/COD data)");
  }
  if (evidenceDocs.length > 0) {
    items.push(
      `User-uploaded evidence (${evidenceDocs.length} file${evidenceDocs.length === 1 ? "" : "s"})`,
    );
  }
  if (items.length === 0) return null;
  return (
    <ul className="grid gap-1 text-xs text-muted-foreground">
      {items.map((s, i) => (
        <li key={i}>• {s}</li>
      ))}
    </ul>
  );
}

// Static reference table for "AI Analysis — Data Required & Sources" — not
// per-property (SourcesList above is the per-property version); this is the
// general methodology reference: what the AI would ideally use for each
// analysis category, where it would come from, and — honestly — whether this
// app actually has that source integrated today. Several rows the user asked
// for (recent sale price/date, building SF, GIS/FEMA flood data, zoning
// records, MLS) are marked "Not integrated" rather than silently implied as
// live: Texas doesn't publicly disclose sale prices at all (see Module 3's
// comps-analysis.ts), and this app has no GIS/FEMA/MLS/zoning-record
// integration today. Status reflects only what's really wired up.
type DataRequirementRow = {
  category: string;
  required: string;
  source: string;
  usedFor: string;
  status: "Available" | "Partial" | "Not integrated";
  // Rows where a document the owner already has would genuinely move this
  // analysis forward — the AI can't fetch these anywhere, so surface an
  // upload control right on the row. `documentType` tags the file so
  // ai-report-modules picks it up for the right module.
  userUpload?: { hint: string; documentType: string };
};

const DATA_REQUIREMENTS: DataRequirementRow[] = [
  {
    category: "Current CAD Appraised Value",
    required: "Total appraised value, land value, improvement value, market value",
    source: "County Appraisal District (CAD)",
    usedFor: "Establishes the current tax valuation baseline",
    status: "Available",
  },
  {
    category: "Historical Assessment",
    required: "Prior years' land/improvement/total values; year-over-year change",
    source: "CAD historical records",
    usedFor: "Identifies unusual increases or valuation trends",
    status: "Available",
  },
  {
    category: "Comparable Valuation",
    required: "Comparable addresses, CAD value, distance, land size, similarity",
    source: "CAD (same-subdivision public records)",
    usedFor: "Compares this property's valuation against similar nearby ones",
    status: "Partial",
    userUpload: {
      hint: "Have an appraisal, broker price opinion, or your own comp list? Upload it.",
      documentType: "Data: Comparable Valuation",
    },
  },
  {
    category: "Market Information",
    required: "Recent sale price, sale date, listing price, cap rate",
    source: "County deed records + MLS",
    usedFor: "Would show whether CAD value looks disconnected from the market",
    status: "Not integrated",
    userUpload: {
      hint: "Upload a closing statement, purchase contract, listing sheet, or recent appraisal.",
      documentType: "Data: Market Information",
    },
  },
  {
    category: "Property Characteristics",
    required: "Building SF, year built, stories, construction type",
    source: "CAD improvement records + GIS",
    usedFor: "Would ensure comparisons use the right physical characteristics",
    status: "Not integrated",
    userUpload: {
      hint: "Upload a survey, building plans, floor plan, or an appraisal listing square footage.",
      documentType: "Data: Property Characteristics",
    },
  },
  {
    category: "Site Conditions",
    required: "Lot shape, access, flood zone, topography, easements",
    source: "FEMA NFHL (flood zone) + USGS (elevation) — real, point-level only",
    usedFor: "Flood zone and a single elevation point; every other factor still needs upload",
    status: "Partial",
    userUpload: {
      hint: "Upload a survey, plat, flood determination, or photos of drainage / access / easement issues.",
      documentType: "Data: Site Conditions",
    },
  },
  {
    category: "Improvement Condition",
    required: "Condition rating, deferred maintenance, renovation history",
    source: "User-uploaded photos/documents",
    usedFor: "Whether the building's condition supports a lower valuation",
    status: "Partial",
    userUpload: {
      hint: "Upload photos, an inspection report, or repair estimates for deferred maintenance.",
      documentType: "Data: Improvement Condition",
    },
  },
  {
    category: "Zoning / Classification",
    required: "Current zoning, CAD property class, legal description",
    source: "CAD record (zoning field, where populated) + stated property type",
    usedFor: "Checks whether the CAD classification looks consistent",
    status: "Partial",
    userUpload: {
      hint: "Upload a zoning verification letter, plat, or the legal description from your deed.",
      documentType: "Data: Zoning / Classification",
    },
  },
  {
    category: "Income Indicators",
    required: "Rent, occupancy, NOI, expenses, cap rate",
    source: "User-provided P&L / rent roll",
    usedFor: "Income-based valuation indicator for applicable properties",
    status: "Partial",
    userUpload: {
      hint: "Upload a rent roll, profit & loss statement, or the current leases.",
      documentType: "Data: Income Indicators",
    },
  },
  {
    category: "Existing Evidence",
    required: "Prior protest results, notices, photos, leases, surveys",
    source: "User uploads",
    usedFor: "Strengthens or weakens the identified opportunity",
    status: "Available",
    userUpload: {
      hint: "Upload prior protest results, the appraisal notice, photos, leases, or surveys.",
      documentType: "Data: Existing Evidence",
    },
  },
  {
    category: "Data Confidence",
    required: "Source reliability, completeness, comp count, missing fields",
    source: "Calculated by AI from all collected data",
    usedFor: "Determines how reliable this analysis and score are",
    status: "Available",
  },
  {
    category: "Potential Valuation Gaps",
    required: "CAD value vs. comparable/market/income indicators",
    source: "Calculated from the CAD + comparable data above",
    usedFor: "Identifies the size of a potential overvaluation",
    status: "Partial",
  },
];

const DATA_STATUS_STYLE: Record<DataRequirementRow["status"], string> = {
  Available: "bg-success/15 text-success",
  Partial: "bg-warning/20 text-warning-foreground",
  "Not integrated": "bg-secondary text-muted-foreground",
};

// A full-width vertical list, not a wide table — no horizontal scrolling at
// all. Each category is collapsed to just its name + Status badge (the two
// things worth scanning at a glance); tap a row to expand it in place and
// reveal the three detail fields stacked below, same click-to-expand
// convention as ComparableTable's rows above.
function DataRequirementsTable({
  onUpload,
  uploading,
}: {
  // When present, rows whose data the owner could supply get an Upload
  // control. Absent for a signed-out / no-access viewer — they still see
  // what's needed, just can't act on it here.
  onUpload?: (files: File[], documentType: string) => void;
  uploading?: boolean;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <div className="grid gap-1.5">
      {DATA_REQUIREMENTS.map((r) => {
        const isOpen = expanded === r.category;
        const canUpload = !!(onUpload && r.userUpload);
        return (
          <div key={r.category} className="rounded-lg border border-border">
            <div className="flex w-full items-center justify-between gap-2 px-3 py-2">
              <button
                type="button"
                onClick={() => setExpanded(isOpen ? null : r.category)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <span className="truncate text-xs font-medium">{r.category}</span>
              </button>
              <span className="flex shrink-0 items-center gap-2">
                {canUpload && (
                  <label
                    className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-accent/40 px-2 py-0.5 text-[10px] font-semibold text-accent hover:bg-accent/10"
                    title={r.userUpload!.hint}
                  >
                    <input
                      type="file"
                      accept="image/*,.pdf"
                      multiple
                      disabled={uploading}
                      className="hidden"
                      onChange={(e) => {
                        const selected = Array.from(e.target.files ?? []);
                        if (selected.length > 0) onUpload!(selected, r.userUpload!.documentType);
                        e.target.value = "";
                      }}
                    />
                    <Upload className="h-3 w-3" />
                    {uploading ? "Uploading…" : "Upload"}
                  </label>
                )}
                <span
                  className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold ${DATA_STATUS_STYLE[r.status]}`}
                >
                  {r.status}
                </span>
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : r.category)}
                  aria-label={isOpen ? "Collapse" : "Expand"}
                >
                  <ArrowRight
                    className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${isOpen ? "rotate-90" : ""}`}
                  />
                </button>
              </span>
            </div>
            {isOpen && (
              <div className="grid gap-2 border-t border-border/60 px-3 py-2 text-xs">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Exact Data Required
                  </div>
                  <p className="text-muted-foreground">{r.required}</p>
                </div>
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Primary Data Source
                  </div>
                  <p className="text-muted-foreground">{r.source}</p>
                </div>
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    What AI Uses It For
                  </div>
                  <p className="text-muted-foreground">{r.usedFor}</p>
                </div>
                {canUpload && (
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-accent">
                      Provide This Data
                    </div>
                    <p className="text-muted-foreground">{r.userUpload!.hint}</p>
                    <label className="mt-1.5 inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-accent/40 px-2.5 py-1 text-[11px] font-semibold text-accent hover:bg-accent/10">
                      <input
                        type="file"
                        accept="image/*,.pdf"
                        multiple
                        disabled={uploading}
                        className="hidden"
                        onChange={(e) => {
                          const selected = Array.from(e.target.files ?? []);
                          if (selected.length > 0) onUpload!(selected, r.userUpload!.documentType);
                          e.target.value = "";
                        }}
                      />
                      <Upload className="h-3.5 w-3.5" />
                      {uploading ? "Uploading…" : "Upload document"}
                    </label>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Renders the actual per-module body — split from ModulePreviewBody below so
// the "Ask AI" Q&A box (see ModuleQABox) can be appended once, after whichever
// early-return branch below fires, instead of being duplicated into each one.
function ModulePreviewContent({
  m,
  estimated,
  state,
  moduleState,
  moduleData,
  compsMap,
  siteGisMap,
  siteCoords,
  onRetry,
  allowEvidenceUpload,
  evidenceDocs,
  uploadingEvidence,
  onUploadEvidence,
  onForceReload,
  onAnswerStrategy,
  existingProtest,
  resolvedProperty,
  onOpenModule,
  onStartProtest,
  onViewCase,
  overrides,
  onMarkNotApplicable,
  onClearNotApplicable,
  compSelections,
  onSaveCompSelection,
  onRemoveCompSelection,
  onExtractCompSale,
}: {
  m: Module;
  estimated: {
    reduction: number;
    savings: number;
    rationale: string | null;
    effectiveTaxRatePct: number;
  };
  state: IntakeState;
  moduleState: ModuleAsyncState | undefined;
  moduleData: Record<string, ModuleAsyncState>;
  compsMap: { data: CompsResult | null; loading: boolean };
  siteGisMap: { data: SiteGisResult | null; loading: boolean };
  siteCoords: GeocodedPoint | null;
  onRetry: () => void;
  allowEvidenceUpload: boolean;
  evidenceDocs: DocumentRecord[];
  uploadingEvidence: boolean;
  onUploadEvidence: (files: File[], strategyId?: string, documentTypeOverride?: string) => void;
  onForceReload: () => void;
  onAnswerStrategy: (strategyId: string, answer: string) => void;
  onAskQuestion: (moduleId: string, question: string) => Promise<string>;
  // Module 10 only — real case state + navigation, so it can show real
  // filing readiness and a genuinely working "View Analysis"/CTA without a
  // page reload (just switches which module is open in this same modal).
  existingProtest: ProtestRecord | null;
  resolvedProperty: PropertyRecord | null;
  onOpenModule: (moduleId: string) => void;
  onStartProtest: () => void;
  onViewCase: () => void;
  // Real, user-confirmed "not applicable" marks — see module-overrides.ts.
  // onMarkNotApplicable/onClearNotApplicable default `itemKey` to the
  // whole-module key (see markNotApplicable/clearNotApplicable in Report()).
  overrides: ModuleOverride[];
  onMarkNotApplicable: (moduleId: string, itemKey?: string) => void;
  onClearNotApplicable: (moduleId: string, itemKey?: string) => void;
  // Module 3 (Market Value) — the user's comp include/exclude/add decisions
  // (see comp-selections.ts). The two callbacks are no-ops in the printable
  // report view (allowEvidenceUpload false); interactive only in the modal.
  compSelections: CompSelection[];
  onSaveCompSelection: (sel: CompSelectionInput) => void;
  onRemoveCompSelection: (compKey: string) => void;
  // Uploads one sale document and returns the AI-extracted figures, or null
  // (no-op in the printable report view).
  onExtractCompSale: (file: File) => Promise<CompSaleExtraction | null>;
}) {
  // Real AI analysis of the customer's own uploaded evidence — see Module
  // 8's "evidence" case below and analyzeEvidence() in protest-reason.ts.
  // Declared unconditionally at the top (not inside the "evidence" case)
  // so this never runs afoul of the Rules of Hooks against the early
  // returns below.
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<EvidenceAnalysis | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  // Evidence packet compile/download — see buildEvidencePacket() in
  // evidence-packet.ts and Module 8's "evidence" case below. Same
  // unconditional-top-of-component placement as the analysis state above.
  const [downloadingPacket, setDownloadingPacket] = useState(false);
  const [packetError, setPacketError] = useState<string | null>(null);
  // Which evidence-checklist category (Module 8) is currently expanded —
  // single-open accordion, same unconditional-top placement as the state
  // above. Also tracks the bulk "Upload Evidence" button's own real AI
  // categorization pass (see handleBulkUploadEvidence below), distinct from
  // uploadingEvidence (the actual upload itself).
  const [expandedEvidenceItem, setExpandedEvidenceItem] = useState<string | null>(null);
  const [categorizingEvidence, setCategorizingEvidence] = useState(false);

  if (m.requiresUserData) {
    const isNotApplicable = isModuleNotApplicable(overrides, "income");
    return (
      <div className="mt-4 card-elev p-4 bg-secondary/60">
        {isNotApplicable ? (
          <>
            <p className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-muted-foreground" />
              Marked not applicable — no P&L, rent roll, or operating statement is available for
              this property. The income approach is excluded from this protest.
            </p>
            <button
              type="button"
              onClick={() => onClearNotApplicable("income")}
              className="mt-2 text-xs font-medium text-accent hover:underline"
            >
              Undo — I can upload financials
            </button>
          </>
        ) : (
          <>
            <p className="text-sm">
              This module requires private financial data (P&L, rent roll, or operating statement)
              to complete. Upload once you subscribe — AI will run the income approach and compare
              to your assessed value.
            </p>
            <button
              type="button"
              onClick={() => onMarkNotApplicable("income")}
              className="mt-2 text-xs font-medium text-accent hover:underline"
            >
              I don't have this — mark Not Applicable
            </button>
          </>
        )}
      </div>
    );
  }

  const loading = !moduleState || moduleState.loading;
  const error = moduleState?.error;

  // Deterministic, not AI-generated — `estimated` (computed by the caller) is
  // the exact same estimateSavings() call the intake savings screen uses, so
  // this always matches that screen for the same property. No loading/error
  // state here since there's no AI call backing this module anymore.
  if (m.id === "savings") {
    const current = state.totalValue ?? 0;
    const reduced = Math.max(0, current - estimated.reduction);
    // Same >= 1 threshold and reasoning as the page's own top banner and
    // intake.tsx's Savings step — a real analysis landing on (near-)$0 isn't
    // a failure, and currency() rounding a sub-$1 amount down to "$0" would
    // otherwise still read as one.
    if (estimated.savings < 1) {
      return (
        <div className="mt-4 grid gap-3">
          <div className="text-center">
            <p className="font-serif text-xl font-bold text-success">Good news!</p>
            <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
              Your property appears to be fairly assessed. We found little or no opportunity for
              additional tax savings this year.
            </p>
          </div>
          <p className="text-center text-xs text-muted-foreground">
            {estimated.rationale ?? "Based on your county's real effective tax rate."}
          </p>
        </div>
      );
    }
    return (
      <div className="mt-4 grid gap-3">
        <div className="text-center">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Estimated Tax Savings
          </div>
          <div className="font-serif text-4xl font-bold text-success">
            <AnimatedNumber value={estimated.savings} format={currency} duration={900} />
          </div>
        </div>
        <ValueComparisonChart current={current} reduced={reduced} />
        <div className="flex justify-center">
          <CostBenefitRow savings={estimated.savings} />
        </div>
        <p className="text-center text-xs text-muted-foreground">
          {estimated.rationale ?? "Based on your county's real effective tax rate."}
        </p>
      </div>
    );
  }

  // The comps map is fetched independently of the AI guidance text (a different
  // Edge Function, its own loading/error state) — rendered here, before the
  // generic loading/error gate below, so a rate-limited or slow AI call never
  // hides a map that already loaded successfully.
  if (m.id === "comps") {
    const d = moduleState?.data as ModuleResultMap["comps"] | undefined;
    const map = compsMap.data;
    // Interactive comp picking only in the live modal — the printable report
    // (allowEvidenceUpload false) shows the same data read-only.
    const compsInteractive = allowEvidenceUpload;
    const stats = computeComparableStats(map?.subject ?? null, map?.comps ?? [], state.totalValue, {
      excludedKeys: excludedCompKeys(compSelections),
      extraComps: compSelectionsToExtraComps(compSelections),
    });
    // Same real top-5-by-similarity subset used for the indicated value
    // itself (see TOP_N_FOR_INDICATED_VALUE in comps-analysis.ts) — reused
    // for the adjustments panel and value chart too, so every "top comps"
    // view in this module means the same actual properties. Excluded comps
    // are already gone from computeComparableStats' `usable`.
    const usable = stats.ranked.filter((c) => c.marketValue != null && !c.excluded);
    const topRanked = usable.slice(0, 5);
    const confidenceReasoning = comparableConfidenceReasoning(stats);
    const perCompMap = new Map((d?.perComp ?? []).map((p) => [p.key, p]));
    const recommendedKeys = new Set(d?.recommendedKeys ?? []);
    const excludedCount = compSelections.filter((s) => s.action === "exclude").length;
    // The map renders for EVERY county, not just the 4 with a comps feed —
    // a synthetic subject from the property's own geocoded point when there
    // are no CAD comps, so the user can still see (and, in Phase B, place)
    // comps relative to it.
    const mapSubject =
      map?.subject ??
      (siteCoords
        ? {
            pid: -1,
            address: state.address ?? "This property",
            latitude: siteCoords.lat,
            longitude: siteCoords.lng,
            marketValue: state.totalValue ?? null,
            ownerName: null,
          }
        : null);
    const mapComps = stats.ranked
      .filter((c) => Number.isFinite(c.latitude) && Number.isFinite(c.longitude))
      .map((c) => ({
        pid: c.pid,
        address: c.address || `Property #${c.pid}`,
        latitude: c.latitude,
        longitude: c.longitude,
        marketValue: c.userAdded ? (c.salePrice ?? null) : c.marketValue,
        ownerName: c.ownerName ?? null,
        distanceMi: c.distanceMi,
        similarity: c.similarity,
        kind: c.userAdded
          ? c.saleVerified
            ? ("sale-verified" as const)
            : ("sale-unverified" as const)
          : ("assessed" as const),
        excluded: c.excluded,
      }));
    const hasAnyComp = stats.ranked.length > 0;

    function handleToggleExclude(comp: RankedComp, exclude: boolean) {
      if (comp.userAdded) {
        // A hand-added comp has no "kept but excluded" state — un-checking it
        // removes it entirely (its data would otherwise be orphaned).
        if (exclude) onRemoveCompSelection(comp.key);
        return;
      }
      if (exclude) onSaveCompSelection({ compKey: comp.key, action: "exclude" });
      else onRemoveCompSelection(comp.key);
    }
    return (
      <div className="mt-4 grid gap-4">
        <CompsWorkflowRibbon
          hasComps={hasAnyComp}
          hasSelection={compSelections.length > 0}
          hasIndicated={stats.indicated != null}
          hasRecommendation={!!d?.protestRecommendation}
        />

        {stats.limitedData && (
          <div className="rounded-lg bg-warning/15 p-3 text-sm text-warning-foreground">
            <span className="font-semibold">Limited Comparable Sales Data.</span> Fewer than 3
            reliable recent commercial sales were found. The system may use alternative market
            evidence, but will clearly distinguish it from actual sale data.
          </div>
        )}
        {compsMap.loading && (
          <div className="h-[280px] animate-pulse rounded-lg border border-border bg-secondary/40" />
        )}

        {/* Map — every county, not just the 4 with a comps feed. Shows the
            subject's own point even when no comps have been located yet. */}
        {mapSubject && (
          <div>
            <div className="mb-1.5 text-sm font-medium">
              {hasAnyComp
                ? `${mapComps.length} comparable${mapComps.length === 1 ? "" : "s"} located near this property`
                : "No comparable sales located yet"}
            </div>
            <CompsMap subject={mapSubject} comps={mapComps} />
          </div>
        )}

        {compsInteractive && (
          <AddCompForm onAdd={onSaveCompSelection} onExtractSale={onExtractCompSale} />
        )}

        {hasAnyComp && (
          <>
            {/* How the comp set was narrowed — real counts only. */}
            <ComparableSelectionFunnel
              reviewed={stats.ranked.length}
              qualified={usable.length}
              selected={topRanked.length}
            />

            {/* Comparable table — interactive Keep toggle + AI verdict in the
                live modal, read-only in the printable report. */}
            <ComparableTable
              ranked={stats.ranked}
              cad={state.cad}
              perComp={perCompMap}
              recommendedKeys={recommendedKeys}
              onToggleExclude={compsInteractive ? handleToggleExclude : undefined}
              onRemove={compsInteractive ? (c) => onRemoveCompSelection(c.key) : undefined}
            />
            {excludedCount > 0 && (
              <p className="-mt-2 text-[11px] text-muted-foreground">
                {excludedCount} comp{excludedCount === 1 ? "" : "s"} you excluded are left out of
                the indicated value, gap and confidence below.
              </p>
            )}

            {/* 4. Adjustments — real per-signal deltas for the top comps
                (CAD-record signals, so gated on a real CAD subject). */}
            {map?.subject && topRanked.length > 0 && (
              <div>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Adjustments — How the Top Comps Differ
                </div>
                <ComparableAdjustments subject={map.subject} comps={topRanked} />
              </div>
            )}

            {/* 5. Value comparison chart. */}
            {(stats.subjectValue != null || topRanked.length > 0) && (
              <div>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Assessed Value Comparison
                </div>
                <ComparableValueChart
                  subjectValue={stats.subjectValue}
                  comps={topRanked}
                  median={stats.indicated?.median ?? null}
                />
              </div>
            )}

            {/* 6. Indicated Value / CAD Value / Gap. */}
            {stats.indicated && (
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-lg bg-success/10 p-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-success">
                    Indicated Value Range
                  </div>
                  <div className="mt-0.5 text-lg font-bold text-success">
                    {compactCurrency(stats.indicated.min)}–{compactCurrency(stats.indicated.max)}
                  </div>
                </div>
                {stats.subjectValue != null && (
                  <div className="rounded-lg bg-destructive/10 p-3">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-destructive">
                      CAD Value
                    </div>
                    <div className="mt-0.5 text-lg font-bold text-destructive">
                      {compactCurrency(stats.subjectValue)}
                    </div>
                  </div>
                )}
                <div className="rounded-lg bg-secondary/60 p-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Valuation Gap
                  </div>
                  <div className="mt-0.5 text-lg font-bold">
                    {stats.valuationGapPct != null
                      ? `${stats.valuationGapPct > 0 ? "+" : ""}${stats.valuationGapPct}%`
                      : "—"}
                  </div>
                </div>
              </div>
            )}

            {/* 7. Confidence — real percentage + real, deterministic reasoning. */}
            {stats.confidencePct != null && (
              <div className="card-elev p-4">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Comparable Confidence
                </div>
                <MiniMeter value={stats.confidencePct} label="Comparable confidence" />
                {confidenceReasoning && (
                  <p className="mt-2 text-xs text-muted-foreground">{confidenceReasoning}</p>
                )}
              </div>
            )}

            {/* 8. Methodology + Sources — real, static facts (not AI prose),
                so this is short icon-led bullets rather than paragraphs. */}
            <div className="grid gap-3 rounded-lg bg-secondary/40 p-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <div className="text-xs font-semibold text-foreground">Methodology</div>
                <FactBullet icon={Building2}>Same CAD subdivision as this property</FactBullet>
                <FactBullet icon={Percent}>
                  0–100 similarity: value, distance, land size, type
                </FactBullet>
                <FactBullet icon={Target}>Indicated range uses the top 5 by similarity</FactBullet>
              </div>
              <div className="grid gap-1.5">
                <div className="text-xs font-semibold text-foreground">Sources</div>
                <FactBullet icon={FileText}>
                  {state.cad ?? "County appraisal district"} public records
                </FactBullet>
                <FactBullet icon={ShieldCheck}>
                  No sale prices — Texas law; deed dates only
                </FactBullet>
              </div>
            </div>
            {state.deeds && state.deeds.length > 0 && (
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  This Property's Deed History
                </div>
                <div className="mt-1.5 overflow-x-auto rounded-lg border border-border">
                  <table className="w-full min-w-[520px] text-left text-xs">
                    <thead className="bg-secondary/60 text-[10px] uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 font-semibold">Date</th>
                        <th className="px-3 py-2 font-semibold">Type</th>
                        <th className="px-3 py-2 font-semibold">Seller</th>
                        <th className="px-3 py-2 font-semibold">Buyer</th>
                        <th className="px-3 py-2 font-semibold">Instrument #</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.deeds.map((deed, i) => (
                        <tr key={i} className="border-t border-border/60">
                          <td className="px-3 py-2 text-muted-foreground">
                            {deed.date?.slice(0, 10) ?? "—"}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {deed.description ?? deed.type ?? "—"}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">{deed.seller ?? "—"}</td>
                          <td className="px-3 py-2 text-muted-foreground">{deed.buyer ?? "—"}</td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {deed.instrumentNum ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  No sale price is shown because none is publicly recorded under Texas law.
                </p>
              </div>
            )}
          </>
        )}

        {/* AI guidance + checklist + the strongest 3-5 comps + how to use
            them — the genuinely AI-generated part of this module, grounded
            in the real ranked comps sent from loadModule() above and
            clamped server-side to that set. */}
        {loading ? (
          <p className="text-sm text-muted-foreground">AI is generating this analysis…</p>
        ) : error ? (
          <ErrorWithRetry message={error} onRetry={onRetry} />
        ) : d ? (
          <div className="grid gap-3">
            <AiVerdictLine icon={m.icon} text={d.guidance} color={m.color} />
            <ChecklistSteps items={d.checklist} color={m.color} />

            {recommendedKeys.size > 0 && (
              <div>
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  AI-Recommended Comps ({recommendedKeys.size})
                </div>
                <ul className="grid gap-1 text-xs">
                  {stats.ranked
                    .filter((c) => recommendedKeys.has(c.key))
                    .map((c) => {
                      const reason = perCompMap.get(c.key)?.reason;
                      return (
                        <li key={c.key} className="flex items-start gap-1.5">
                          <span className="mt-0.5 text-success">✓</span>
                          <span>
                            <span className="font-medium">{c.address || `Property #${c.pid}`}</span>
                            {" — "}
                            {c.similarity}/100 similarity
                            {reason ? `. ${reason}` : ""}
                          </span>
                        </li>
                      );
                    })}
                </ul>
              </div>
            )}

            {(() => {
              const excludeSuggestions = (d.perComp ?? []).filter(
                (p) => p.verdict === "exclude" && !recommendedKeys.has(p.key),
              );
              if (excludeSuggestions.length === 0) return null;
              const addr = (key: string) => {
                const c = stats.ranked.find((r) => r.key === key);
                return c?.address || `Property #${c?.pid ?? "?"}`;
              };
              return (
                <div>
                  <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Suggested Exclusions
                  </div>
                  <ul className="grid gap-1 text-xs text-muted-foreground">
                    {excludeSuggestions.map((p) => (
                      <li key={p.key} className="flex items-start gap-1.5">
                        <span className="mt-0.5 text-warning-foreground">✕</span>
                        <span>
                          <span className="font-medium text-foreground">{addr(p.key)}</span>
                          {p.reason ? ` — ${p.reason}` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}

            {(d.protestRecommendation || d.recommendedUse) && (
              <div>
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Protest Recommendation
                </div>
                <AiVerdictLine
                  icon={ArrowRight}
                  text={d.protestRecommendation || d.recommendedUse}
                  color={m.color}
                />
              </div>
            )}
          </div>
        ) : null}
      </div>
    );
  }

  if (loading) {
    return (
      <p className="mt-4 text-sm text-muted-foreground">
        {m.id === "health" ? "AI is scoring this property…" : "AI is generating this analysis…"}
      </p>
    );
  }
  if (error) {
    return <ErrorWithRetry message={error} onRetry={onRetry} />;
  }
  if (!moduleState?.data) return null;

  if (m.id === "health") {
    const data = moduleState.data as HealthScoreResult;
    const label =
      data.score >= 70
        ? "Strong Opportunity"
        : data.score >= 40
          ? "Moderate Opportunity"
          : "Limited Opportunity";
    const answerKey = "health";
    return (
      <div className="mt-4 grid gap-4">
        {data.executiveConclusion && (
          <AiVerdictLine icon={m.icon} text={data.executiveConclusion} color={m.color} />
        )}

        <div className="min-w-0">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            AI Analysis — Data Required &amp; Sources
          </div>
          <DataRequirementsTable
            onUpload={
              allowEvidenceUpload
                ? (files, documentType) => onUploadEvidence(files, undefined, documentType)
                : undefined
            }
            uploading={uploadingEvidence}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-[13rem_1fr] items-center">
          <div className="text-center">
            <SpeedometerGauge value={data.score} size="lg" />
            <div className="mt-1 text-sm font-semibold" style={{ color: scoreColor(data.score) }}>
              {label}
            </div>
            {!data.dataSufficient && (
              <div className="mt-1 text-xs font-semibold text-warning-foreground">
                Additional Data Needed
              </div>
            )}
          </div>
          {estimated.savings > 0 && (
            <div className="rounded-lg bg-success/10 p-4 text-center">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-success">
                Potential Tax Savings
              </div>
              <div className="mt-1 font-serif text-3xl font-bold text-success">
                {currency(estimated.savings)}
              </div>
              {state.totalValue ? (
                <div className="mt-0.5 text-xs text-success/80">
                  {Math.round((estimated.reduction / state.totalValue) * 100)}% of assessed value
                </div>
              ) : null}
            </div>
          )}
        </div>

        {data.scoreBreakdown.length > 0 && (
          <div className="card-elev p-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Score Breakdown
            </div>
            <ScoreBreakdownList breakdown={data.scoreBreakdown} />
          </div>
        )}

        {(data.factorsIncreasing.length > 0 || data.factorsReducing.length > 0) && (
          <div className="grid gap-3 sm:grid-cols-2">
            {data.factorsIncreasing.length > 0 && (
              <div className="rounded-lg bg-success/10 p-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-success">
                  <TrendingUp className="h-3.5 w-3.5" />
                  Factors Increasing Protest Opportunity
                </div>
                <ul className="grid gap-1 text-xs text-foreground/90">
                  {data.factorsIncreasing.map((f, i) => (
                    <li key={i}>• {f}</li>
                  ))}
                </ul>
              </div>
            )}
            {data.factorsReducing.length > 0 && (
              <div className="rounded-lg bg-destructive/10 p-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-destructive">
                  <TrendingDown className="h-3.5 w-3.5" />
                  Factors Reducing Protest Opportunity
                </div>
                <ul className="grid gap-1 text-xs text-foreground/90">
                  {data.factorsReducing.map((f, i) => (
                    <li key={i}>• {f}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Supporting Data
          </div>
          <SupportingDataGrid state={state} compsMap={compsMap} />
        </div>

        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Sources
          </div>
          <SourcesList state={state} compsMap={compsMap} evidenceDocs={evidenceDocs} />
        </div>

        <div className="card-elev p-4">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5" />
            Confidence
          </div>
          <MiniMeter value={data.confidencePct} label="Analysis confidence" />
          {data.confidenceReasoning && (
            <p className="mt-2 text-xs text-muted-foreground">{data.confidenceReasoning}</p>
          )}
        </div>

        {data.methodology && (
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              AI Methodology
            </div>
            <p className="text-xs text-muted-foreground">{data.methodology}</p>
          </div>
        )}

        {data.nextStep && (
          <div className={`rounded-lg p-4 ${m.color.bg}`}>
            <div className={`text-[10px] font-semibold uppercase tracking-wide ${m.color.text}`}>
              Recommended Next Step
            </div>
            <div className="mt-1 text-sm font-semibold">{data.nextStep}</div>
          </div>
        )}

        {!data.dataSufficient && (
          <div className="border-t border-border/60 pt-4 print:hidden">
            <div className="text-xs font-semibold text-warning-foreground">
              Additional Data Needed
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Upload supporting documents or answer below so AI can complete this analysis with real
              evidence.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label
                className={`btn-outline text-xs cursor-pointer ${uploadingEvidence ? "pointer-events-none opacity-60" : ""}`}
              >
                {uploadingEvidence ? "Uploading…" : "Upload Evidence"}
                <input
                  type="file"
                  accept="image/*,.pdf"
                  multiple
                  className="hidden"
                  disabled={uploadingEvidence}
                  onChange={(e) => {
                    const selected = e.target.files ? Array.from(e.target.files) : [];
                    e.target.value = "";
                    if (selected.length > 0) onUploadEvidence(selected, answerKey);
                  }}
                />
              </label>
            </div>
            <div className="mt-2 flex gap-2">
              <input
                type="text"
                defaultValue={state.strategyAnswers?.[answerKey] ?? ""}
                onBlur={(e) => {
                  if (e.target.value.trim()) onAnswerStrategy(answerKey, e.target.value.trim());
                }}
                placeholder="Or type an answer instead…"
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs"
              />
            </div>
            {!state.strategyAnswers?.[answerKey] && evidenceDocs.length === 0 && (
              <p className="mt-2 text-[11px] italic text-muted-foreground">
                Estimate — not guaranteed, missing evidence.
              </p>
            )}
          </div>
        )}
      </div>
    );
  }

  switch (m.id) {
    case "strategy": {
      const d = moduleState.data as ModuleResultMap["strategy"];
      if (d.strategies.length === 0) {
        return (
          <p className="mt-4 text-sm text-muted-foreground">
            AI cannot proceed without enough property data to evaluate any strategy yet.
          </p>
        );
      }
      return (
        <div className="mt-4 grid gap-4 [&>*]:min-w-0">
          {d.topStrategySummary && (
            <AiVerdictLine icon={m.icon} text={d.topStrategySummary} color={m.color} />
          )}
          <div className="card-elev min-w-0 p-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Ranked Strategies
            </div>
            <StrategyRankList strategies={d.strategies} color={m.color} />
          </div>
          <div className="grid gap-3 [&>*]:min-w-0">
            {d.strategies.map((s, i) => (
              <StrategyDetail
                key={s.name}
                s={s}
                rank={i + 1}
                color={m.color}
                evidenceDocs={evidenceDocs}
                uploadingEvidence={uploadingEvidence}
                onUploadEvidence={onUploadEvidence}
                answer={state.strategyAnswers?.[strategySlug(s.name)]}
                onAnswerStrategy={onAnswerStrategy}
                onRefresh={onForceReload}
                refreshing={moduleState?.loading}
              />
            ))}
          </div>
        </div>
      );
    }
    case "site": {
      const d = moduleState.data as ModuleResultMap["site"];
      const siteGis = siteGisMap.data;
      const gaps = countDataGaps(d.factors);
      const nextModule = MODULES.find((mm) => mm.id === "improvement");
      return (
        <div className="mt-4 grid gap-4">
          <div>
            <div className="relative">
              {siteCoords ? (
                <SiteMapThumb lat={siteCoords.lat} lng={siteCoords.lng} height={220} />
              ) : (
                <div className="grid h-[220px] place-items-center rounded-lg bg-secondary/40">
                  <MapPin className="h-8 w-8 text-muted-foreground" />
                </div>
              )}
              <FloodZoneBadge floodZone={siteGis?.floodZone} />
            </div>
            {/* Real "Site Facts" strip — only ever the two point facts this
                app can actually fetch (FEMA/USGS); nothing else is claimed. */}
            {(siteGis?.floodZone || siteGis?.elevationFt != null) && (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {siteGis?.floodZone && (
                  <span>
                    Flood zone:{" "}
                    <strong className="text-foreground">{siteGis.floodZone.label}</strong>
                  </span>
                )}
                {siteGis?.elevationFt != null && (
                  <span>
                    Elevation:{" "}
                    <strong className="text-foreground">
                      {Math.round(siteGis.elevationFt)} ft
                    </strong>{" "}
                    (single point, not a full survey)
                  </span>
                )}
              </div>
            )}
          </div>

          <MiniMeter value={d.priorityScore} label="Documentation priority" />

          {d.guidance && <AiVerdictLine icon={m.icon} text={d.guidance} color={m.color} />}

          {/* Split, not one flat 14-row list — see MODULE_SPECS.site and
              enforceSiteFactorRealData in the edge function. The 1-2 factors
              with a real/partial finding (almost always just Floodplain/
              Grade) get full detail cards, since there's genuine substance
              to read; the remaining "Additional Data Needed" majority — a
              near-duplicate explanation each — collapses into one compact,
              tappable icon grid instead of 12 more full-text cards nobody
              would actually read through. */}
          {(() => {
            // Combines the server's own status with the override state
            // directly (not just d.factors.status) so a factor moves to
            // "Marked Not Applicable" the instant the user clicks, without
            // waiting on the forced reload this also triggers (see
            // markNotApplicable() in Report()) to come back.
            const isNA = (factor: string) => isItemNotApplicable(overrides, "site", factor);
            const withData = d.factors.filter(
              (f) =>
                f.status !== "Additional Data Needed" &&
                f.status !== "Not Applicable" &&
                !isNA(f.factor),
            );
            const missing = d.factors.filter(
              (f) => f.status === "Additional Data Needed" && !isNA(f.factor),
            );
            const notApplicableFactors = d.factors.filter(
              (f) => f.status === "Not Applicable" || isNA(f.factor),
            );
            return (
              <>
                {withData.length > 0 && (
                  <div>
                    <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      What We Found
                    </div>
                    <div className="grid gap-1.5">
                      {withData.map((f) => (
                        <SiteFactorRow key={f.factor} factor={f} onOpenModule={onOpenModule} />
                      ))}
                    </div>
                  </div>
                )}
                {missing.length > 0 && (
                  <div>
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Needs More Data
                      </div>
                      <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                        {gaps} of {d.factors.length}
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
                      {missing.map((f) => (
                        <SiteFactorGapTile
                          key={f.factor}
                          factor={f}
                          onOpenModule={onOpenModule}
                          onMarkNotApplicable={() => onMarkNotApplicable("site", f.factor)}
                        />
                      ))}
                    </div>
                  </div>
                )}
                {notApplicableFactors.length > 0 && (
                  <div>
                    <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Marked Not Applicable
                    </div>
                    <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
                      {notApplicableFactors.map((f) => (
                        <SiteFactorNotApplicableTile
                          key={f.factor}
                          label={f.factor}
                          onClear={() => onClearNotApplicable("site", f.factor)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </>
            );
          })()}

          {d.keyFinding && (
            <div className={`rounded-lg p-4 ${m.color.bg}`}>
              <div className={`text-[10px] font-semibold uppercase tracking-wide ${m.color.text}`}>
                Key Finding
              </div>
              <p className="mt-1 text-sm text-foreground/90">{d.keyFinding}</p>
            </div>
          )}

          {nextModule && (
            <button
              type="button"
              onClick={() => onOpenModule(nextModule.id)}
              className="flex items-center justify-between gap-2 rounded-lg bg-secondary/40 px-4 py-2.5 text-sm font-semibold transition-colors hover:bg-secondary/60"
            >
              <span>Next Step: Evaluate {nextModule.shortName}</span>
              <ArrowRight className="h-4 w-4" />
            </button>
          )}
        </div>
      );
    }
    case "improvement": {
      const d = moduleState.data as ModuleResultMap["improvement"];
      const improvementDocs = evidenceDocs.filter(
        (doc) => doc.documentType === EVIDENCE_DOCUMENT_TYPE,
      );
      const economicLife = getTypicalEconomicLife(state.propertyType);
      const depreciation = computeDepreciation(
        d.effectiveAgeYears,
        economicLife,
        d.functionalObsolescencePct,
        d.externalObsolescencePct,
        state.improvementValue ?? null,
      );
      return (
        <div className="mt-4 grid gap-4">
          <PipelineDiagram />

          <div className="flex flex-col items-center">
            <SpeedometerGauge value={d.priorityScore} size="md" />
            <div className="-mt-1 text-xs text-muted-foreground">Condition Priority</div>
          </div>

          {d.guidance && <AiVerdictLine icon={m.icon} text={d.guidance} color={m.color} />}

          {/* Building Condition Overview — 4 fixed components, real photo-
              grounded findings (see MODULE_SPECS.improvement and
              enforceBuildingComponentRealData). "No Photo Provided" is
              honest, never a guessed condition. */}
          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Building Condition Overview
            </div>
            <div className="grid gap-1.5">
              {d.buildingComponents.map((c) => (
                <BuildingComponentRow
                  key={c.component}
                  c={
                    // Same instant-feedback reasoning as the site factors
                    // above — reflect the override immediately rather than
                    // waiting on the forced reload it also triggers.
                    !c.hasPhoto && isItemNotApplicable(overrides, "improvement", c.component)
                      ? { ...c, notApplicable: true }
                      : c
                  }
                  onMarkNotApplicable={() => onMarkNotApplicable("improvement", c.component)}
                  onClearNotApplicable={() => onClearNotApplicable("improvement", c.component)}
                />
              ))}
            </div>
          </div>

          {/* Condition Metrics — Physical Depreciation and Total
              Depreciation are real deterministic math (see
              computeDepreciation in improvement-condition.ts), never
              AI-computed; Effective Age/Functional/External Obsolescence
              are the AI's own photo-grounded estimates, honestly null when
              there's no real basis. */}
          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Condition Metrics
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <ExecutiveStat
                label="Effective Age"
                value={
                  d.effectiveAgeYears != null
                    ? `${d.effectiveAgeYears} yrs`
                    : "Additional Data Needed"
                }
              />
              <ExecutiveStat
                label="Economic Life"
                value={`${economicLife.typical} yrs (${economicLife.min}-${economicLife.max} typical)`}
              />
              <ExecutiveStat
                label="Physical Depreciation"
                value={
                  depreciation.physicalDepreciationPct != null
                    ? `${depreciation.physicalDepreciationPct}%`
                    : "Additional Data Needed"
                }
              />
              <ExecutiveStat
                label="Functional Obsolescence"
                value={
                  d.functionalObsolescencePct != null
                    ? `${d.functionalObsolescencePct}%`
                    : "Additional Data Needed"
                }
              />
              <ExecutiveStat
                label="External Obsolescence"
                value={
                  d.externalObsolescencePct != null
                    ? `${d.externalObsolescencePct}%`
                    : "Additional Data Needed"
                }
              />
              <ExecutiveStat
                label="Total Depreciation"
                value={
                  depreciation.totalDepreciationPct != null
                    ? `${depreciation.totalDepreciationPct}%`
                    : "Additional Data Needed"
                }
              />
            </div>
          </div>

          {/* Value Impact — only ever rendered once computeDepreciation()
              actually returned real numbers; never a placeholder row. */}
          {depreciation.conditionAdjustedValue != null && state.improvementValue != null && (
            <div>
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Value Impact
              </div>
              <div className="grid grid-cols-3 gap-2">
                <FactBox label="CAD Improvement Value" value={currency(state.improvementValue)} />
                <FactBox
                  label="Condition-Adjusted Value"
                  value={currency(depreciation.conditionAdjustedValue)}
                />
                <FactBox
                  label="Impact"
                  value={`${currency(depreciation.impactDollar ?? 0)} (${depreciation.impactPct}%)`}
                />
              </div>
            </div>
          )}

          {d.keyFinding && (
            <div className={`rounded-lg p-4 ${m.color.bg}`}>
              <div className={`text-[10px] font-semibold uppercase tracking-wide ${m.color.text}`}>
                Key Finding
              </div>
              <p className="mt-1 text-sm text-foreground/90">{d.keyFinding}</p>
            </div>
          )}

          {allowEvidenceUpload && (
            <div className="mt-4 border-t border-border/60 pt-4 print:hidden">
              <div className="text-sm font-medium">Add Evidence</div>
              <p className="text-xs text-muted-foreground">
                Property photos, repair estimates, or appraisals — AI will cite specific details
                from what you upload instead of only general guidance.
              </p>
              {improvementDocs.length > 0 && (
                <ul className="mt-2 grid gap-1 text-xs text-muted-foreground">
                  {improvementDocs.map((doc) => (
                    <li key={doc.id}>{doc.fileName}</li>
                  ))}
                </ul>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <label
                  className={`btn-outline text-sm cursor-pointer ${uploadingEvidence ? "pointer-events-none opacity-60" : ""}`}
                >
                  {uploadingEvidence ? "Uploading…" : "Upload Evidence"}
                  <input
                    type="file"
                    accept="image/*,.pdf"
                    multiple
                    className="hidden"
                    disabled={uploadingEvidence}
                    onChange={(e) => {
                      const selected = e.target.files ? Array.from(e.target.files) : [];
                      e.target.value = "";
                      if (selected.length > 0) onUploadEvidence(selected);
                    }}
                  />
                </label>
                {improvementDocs.length > 0 && (
                  <button
                    disabled={loading}
                    onClick={onForceReload}
                    className="btn-outline text-sm disabled:opacity-60"
                  >
                    Regenerate with Evidence
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      );
    }
    case "zoning": {
      const d = moduleState.data as ModuleResultMap["zoning"];
      return (
        <div className="mt-4 grid gap-4">
          <p className="-mb-1 text-xs text-muted-foreground">
            AI checks alignment across classification, use, and zoning, then identifies issues.
          </p>
          <AnalysisPipeline
            steps={[
              { eyebrow: "User input", label: "Property & zoning data", Icon: User },
              { eyebrow: "AI processing", label: "Zoning & use analyzer", Icon: Cpu },
              { eyebrow: "Logic / decision", label: "Alignment & impact model", Icon: Scale },
              {
                eyebrow: "AI output",
                label: "Zoning analysis report",
                Icon: Gauge,
                current: true,
              },
              { eyebrow: "Next step", label: "Apply to value relevance", Icon: ArrowRight },
            ]}
          />

          <ZoningBadge matches={d.matches} />
          <AiVerdictLine icon={m.icon} text={d.assessment} color={m.color} />

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">Category:</span>
            <span className="badge-soft">{d.category}</span>
            <span className="text-muted-foreground">· Typical CAD class:</span>
            <span className="font-medium">{d.typicalClassification || "—"}</span>
          </div>

          <ZoningClassificationTable
            aspects={d.aspects}
            matches={d.matches}
            onUpload={
              allowEvidenceUpload
                ? (label, files) => onUploadEvidence(files, undefined, `Zoning: ${label}`)
                : undefined
            }
            uploading={uploadingEvidence}
          />

          {d.discrepancies.length > 0 && (
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
              <div className="text-xs font-semibold text-warning-foreground">
                Detected discrepancies
              </div>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                A classification or zoning mismatch is a fact to explain — not, by itself, proof the
                property is overvalued.
              </p>
              <ul className="mt-2 grid gap-1.5 text-xs">
                {d.discrepancies.map((dc, i) => (
                  <li key={i}>
                    <span className="font-medium">{dc.between}</span>
                    <span className="ml-1.5 rounded-full bg-secondary px-1.5 py-0.5 text-[9px] font-semibold text-muted-foreground">
                      {dc.confidence} confidence
                    </span>
                    <div className="text-muted-foreground">{dc.detail}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              AI Analysis &amp; Impact
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <ZoningImpactCol title="Valuation relevance" tone="success">
                <p>{d.valuationRelevance}</p>
              </ZoningImpactCol>
              <ZoningImpactCol title="Possible exemptions" tone="accent">
                {d.possibleExemptions.length > 0 ? (
                  <ul className="grid gap-1 pl-4 list-disc">
                    {d.possibleExemptions.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                ) : (
                  <p>None identified from the data on file.</p>
                )}
              </ZoningImpactCol>
              <ZoningImpactCol title="Evidence required" tone="success">
                {d.evidenceRequired.length > 0 ? (
                  <ul className="grid gap-1 pl-4 list-disc">
                    {d.evidenceRequired.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                ) : (
                  <p>—</p>
                )}
              </ZoningImpactCol>
            </div>
          </div>

          <div className="grid gap-2 rounded-lg bg-secondary/40 p-3 text-xs sm:grid-cols-2">
            <div>
              <div className="font-semibold text-foreground">Restrictions</div>
              <p className="text-muted-foreground">{d.restrictions || "—"}</p>
            </div>
            <div>
              <div className="font-semibold text-foreground">Comparable classifications</div>
              <p className="text-muted-foreground">{d.comparableClassifications || "—"}</p>
            </div>
          </div>
        </div>
      );
    }
    case "evidence": {
      const d = moduleState.data as ModuleResultMap["evidence"];
      const focus = d.items.filter((i) => i.importance === "High" && i.availability === "Low");
      // Real protest-case evidence — the generic PROTEST_EVIDENCE_DOCUMENT_TYPE
      // tag CaseDetailModal's own evidence-checklist upload uses (so a file
      // uploaded from either path shows up here together), PLUS anything
      // uploaded straight into one of this module's own checklist categories
      // below (`Evidence Category: <slug>`) — both are real protest evidence
      // for this case, just tagged by how the user chose to upload them.
      // "Analyze My Evidence"/the evidence packet should see all of it.
      const protestEvidenceDocs = evidenceDocs.filter(
        (doc) =>
          doc.useAsEvidence === true ||
          (doc.useAsEvidence !== false &&
            (doc.documentType === PROTEST_EVIDENCE_DOCUMENT_TYPE ||
              doc.documentType?.startsWith("Evidence Category: "))),
      );

      // Runs before the actual upload — reads each picked file's real
      // content and matches it against this property's OWN current
      // checklist (never a fixed taxonomy), so the generic bulk upload
      // button below can tag files with the right category automatically
      // instead of leaving them uncategorized. Never blocks the upload
      // itself: if categorization fails, every file just uploads
      // uncategorized, same as before this feature existed.
      async function handleBulkUploadEvidence(files: File[]) {
        setCategorizingEvidence(true);
        try {
          const categorized = await categorizeEvidenceUploads(
            d.items.map((it) => it.item),
            files,
          );
          const groups = new Map<string, File[]>();
          for (const file of files) {
            const matched = categorized.find((c) => c.fileName === file.name)?.matchedItem ?? null;
            const key = matched ?? "";
            const group = groups.get(key);
            if (group) group.push(file);
            else groups.set(key, [file]);
          }
          for (const [matchedItem, groupFiles] of groups) {
            const documentType = matchedItem
              ? `Evidence Category: ${evidenceItemSlug(matchedItem)}`
              : PROTEST_EVIDENCE_DOCUMENT_TYPE;
            await onUploadEvidence(groupFiles, undefined, documentType);
          }
        } finally {
          setCategorizingEvidence(false);
        }
      }

      // Real AI read of the customer's own uploaded evidence — never
      // automatic, only from the explicit "Analyze My Evidence" click
      // below. Same real strategy-name lookup Module 10 (executive) below
      // already does from this same moduleData prop.
      const strategyForAnalysis =
        (moduleData.strategy?.data as ModuleResultMap["strategy"] | undefined)?.strategies[0]
          ?.name ?? null;

      async function handleAnalyzeEvidence() {
        if (!resolvedProperty) return;
        setAnalyzing(true);
        setAnalysisError(null);
        try {
          const result = await analyzeEvidence(
            resolvedProperty,
            strategyForAnalysis,
            protestEvidenceDocs,
          );
          setAnalysis(result);
        } catch (err) {
          setAnalysisError(err instanceof Error ? err.message : "Could not analyze this evidence.");
        } finally {
          setAnalyzing(false);
        }
      }

      // Only "Accepted"/"Needs Review"/"Additional Information Needed" ever
      // make it into the packet — see INCLUDED_STATUSES in
      // evidence-packet.ts for why "Incorrect Document"/"Duplicate" don't.
      const packetEligibleCount =
        analysis?.documentFindings.filter((f) =>
          (
            ["Accepted", "Needs Review", "Additional Information Needed"] as DocumentStatus[]
          ).includes(f.status),
        ).length ?? 0;

      async function handleDownloadPacket() {
        if (!resolvedProperty || !analysis) return;
        setDownloadingPacket(true);
        setPacketError(null);
        try {
          const bytes = await buildEvidencePacket(
            resolvedProperty,
            protestEvidenceDocs,
            analysis.documentFindings,
          );
          const filenameBase = resolvedProperty.accountNumber ?? resolvedProperty.id;
          downloadPdf(bytes, `Evidence-Packet-${filenameBase}.pdf`);
          toast.success("Evidence packet downloaded.");
        } catch (err) {
          setPacketError(
            getErrorMessage(err, "Could not compile the evidence packet. Please try again."),
          );
        } finally {
          setDownloadingPacket(false);
        }
      }

      return (
        <div className="mt-4 grid gap-3">
          {focus.length > 0 && (
            <div className="min-w-0 flex items-center justify-between gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-semibold text-destructive">
              <span className="min-w-0 flex-1 truncate">
                Focus Here First: {focus.map((i) => i.item).join(", ")}
              </span>
              <ArrowRight className="h-4 w-4 shrink-0" />
            </div>
          )}
          <div className="grid gap-2">
            {d.items.map((it) => {
              const slug = evidenceItemSlug(it.item);
              const uploadedForItem = protestEvidenceDocs.filter(
                (doc) => doc.documentType === `Evidence Category: ${slug}`,
              );
              return (
                <EvidenceCategoryRow
                  key={it.item}
                  it={it}
                  uploadedDocs={uploadedForItem}
                  expanded={expandedEvidenceItem === it.item}
                  onToggleExpand={() =>
                    setExpandedEvidenceItem((prev) => (prev === it.item ? null : it.item))
                  }
                  uploadingEvidence={uploadingEvidence}
                  onUploadEvidence={(files) =>
                    onUploadEvidence(files, undefined, `Evidence Category: ${slug}`)
                  }
                />
              );
            })}
          </div>
          {allowEvidenceUpload && (
            <div className="border-t border-border/60 pt-4 print:hidden">
              <div className="text-sm font-medium">Upload Evidence</div>
              <p className="text-xs text-muted-foreground">
                Add documents in bulk — AI reads each one and sorts it into the matching category
                above automatically. Anything that doesn't clearly match stays here, uncategorized.
              </p>
              {protestEvidenceDocs.length > 0 && (
                <ul className="mt-2 grid gap-1 text-xs text-muted-foreground">
                  {protestEvidenceDocs.map((doc) => {
                    const categorySlug = doc.documentType?.startsWith("Evidence Category: ")
                      ? doc.documentType.slice("Evidence Category: ".length)
                      : null;
                    const category = categorySlug
                      ? (d.items.find((it) => evidenceItemSlug(it.item) === categorySlug)?.item ??
                        null)
                      : null;
                    return (
                      <li key={doc.id}>
                        {doc.fileName}
                        {category && <span className="text-foreground/70"> — {category}</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
              <label
                className={`mt-3 inline-flex btn-outline text-sm cursor-pointer ${uploadingEvidence || categorizingEvidence ? "pointer-events-none opacity-60" : ""}`}
              >
                {categorizingEvidence
                  ? "Sorting your documents…"
                  : uploadingEvidence
                    ? "Uploading…"
                    : "Upload Evidence"}
                <input
                  type="file"
                  accept="image/*,.pdf"
                  multiple
                  className="hidden"
                  disabled={uploadingEvidence || categorizingEvidence}
                  onChange={(e) => {
                    const selected = e.target.files ? Array.from(e.target.files) : [];
                    e.target.value = "";
                    if (selected.length > 0) handleBulkUploadEvidence(selected);
                  }}
                />
              </label>
            </div>
          )}

          {allowEvidenceUpload && protestEvidenceDocs.length > 0 && (
            <div className="border-t border-border/60 pt-4 print:hidden">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-medium">AI Evidence Analysis</div>
                <button
                  type="button"
                  onClick={handleAnalyzeEvidence}
                  disabled={analyzing}
                  className="btn-outline text-xs py-1 disabled:opacity-60"
                >
                  {analyzing
                    ? "Reading your evidence…"
                    : analysis
                      ? "Re-Analyze"
                      : "Analyze My Evidence"}
                </button>
              </div>
              {!analysis && !analyzing && !analysisError && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Corvus AI reads your {protestEvidenceDocs.length} uploaded document
                  {protestEvidenceDocs.length === 1 ? "" : "s"} and tells you what it actually found
                  — including flagging anything that doesn't look like real supporting evidence.
                </p>
              )}
              {analysisError && <p className="mt-1 text-xs text-destructive">{analysisError}</p>}
              {analysis && (
                <div className="mt-3 grid gap-3">
                  <div className="grid gap-1.5">
                    {analysis.documentFindings.map((f, i) => (
                      <div key={i} className="rounded-md border border-border p-2 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="min-w-0 flex-1 truncate font-medium">{f.fileName}</span>
                          <DocumentStatusBadge status={f.status} />
                        </div>
                        <p className="mt-0.5 text-muted-foreground">{f.assessment}</p>
                      </div>
                    ))}
                  </div>
                  {analysis.summary && (
                    <div className="rounded-md bg-secondary/40 p-2.5 text-xs">
                      <span className="font-medium">Summary: </span>
                      {analysis.summary}
                    </div>
                  )}
                  {analysis.suggestedReason && (
                    <div className="rounded-md border border-accent/30 bg-accent/5 p-2.5 text-xs">
                      <span className="font-medium text-foreground">
                        Suggested reason for protest:
                      </span>
                      <p className="mt-1 text-muted-foreground">{analysis.suggestedReason}</p>
                      <p className="mt-1.5 text-[11px] text-muted-foreground">
                        This is a draft — it'll also be offered as a suggestion when you complete
                        your Notice of Protest under File Protest, where you can review and edit it
                        before signing.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {allowEvidenceUpload && analysis && (
            <div className="border-t border-border/60 pt-4 print:hidden">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium">Download Evidence Packet</div>
                  <p className="text-xs text-muted-foreground">
                    {packetEligibleCount > 0
                      ? `Compiles your ${packetEligibleCount} accepted document${packetEligibleCount === 1 ? "" : "s"} into one organized PDF, with a cover page and your county's real filing instructions. Incorrect/duplicate uploads are left out.`
                      : "No documents currently qualify — resolve any Incorrect Document/Duplicate flags above, or upload new evidence and re-analyze."}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleDownloadPacket}
                  disabled={downloadingPacket || packetEligibleCount === 0}
                  className="btn-outline shrink-0 whitespace-nowrap text-xs py-1 disabled:opacity-60"
                >
                  {downloadingPacket ? "Compiling…" : "Download Evidence Packet"}
                </button>
              </div>
              {packetError && <p className="mt-1 text-xs text-destructive">{packetError}</p>}
            </div>
          )}
        </div>
      );
    }
    case "executive": {
      const d = moduleState.data as ModuleResultMap["executive"];
      const strategyData = moduleData.strategy?.data as ModuleResultMap["strategy"] | undefined;
      const evidenceData = moduleData.evidence?.data as ModuleResultMap["evidence"] | undefined;
      const evidenceItems = evidenceData?.items ?? [];
      const execStats = computeComparableStats(
        compsMap.data?.subject ?? null,
        compsMap.data?.comps ?? [],
        state.totalValue,
      );
      const preFilingItems =
        existingProtest && resolvedProperty
          ? getPreFilingCheck(resolvedProperty, existingProtest)
          : null;
      const summary = getExecutiveSummary(
        execStats,
        estimated.savings,
        evidenceItems,
        preFilingItems,
      );
      const defenseScore = getDefenseReadinessScore(d.defenseQA);
      const criticalMissing = evidenceItems.filter(
        (i) => i.importance === "High" && i.availability === "Low",
      );

      // Single primary CTA, deterministic — never more than one rendered.
      let cta: { label: string; onClick: () => void } | null = null;
      if (preFilingItems && isPreFilingBlocked(preFilingItems)) {
        cta = null; // "Complete Missing Information" — see the Properties link below instead
      } else if (criticalMissing.length > 0) {
        cta = { label: "Complete Missing Evidence", onClick: () => onOpenModule("evidence") };
      } else if (!existingProtest) {
        cta = { label: "Prepare My Protest", onClick: onStartProtest };
      } else {
        cta = { label: "Review Case", onClick: onViewCase };
      }

      return (
        <div className="mt-4 grid gap-4">
          {/* 2. Executive Protest Summary — real numbers only, see
              src/lib/executive-summary.ts for the exact formulas. */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <ExecutiveStat label="Protest Opportunity" value={summary.protestOpportunity} />
            {summary.currentCadValue != null && (
              <ExecutiveStat label="Current CAD Value" value={currency(summary.currentCadValue)} />
            )}
            {summary.indicatedValueRange && (
              <ExecutiveStat
                label="Market Value Range"
                value={`${compactCurrency(summary.indicatedValueRange.min)}–${compactCurrency(summary.indicatedValueRange.max)}`}
              />
            )}
            {summary.potentialValueReduction != null && (
              <ExecutiveStat
                label="Potential Reduction"
                value={compactCurrency(summary.potentialValueReduction)}
              />
            )}
            {summary.estimatedAnnualSavings != null && summary.estimatedAnnualSavings > 0 && (
              <ExecutiveStat
                label="Est. Annual Savings"
                value={compactCurrency(summary.estimatedAnnualSavings)}
              />
            )}
            <ExecutiveStat label="Evidence Readiness" value={summary.evidenceReadiness} />
            <ExecutiveStat label="Protest Readiness" value={summary.protestReadiness} />
          </div>
          {summary.overallConfidencePct != null && (
            <div className="flex flex-col items-center">
              <SpeedometerGauge value={summary.overallConfidencePct} size="sm" />
              <div className="-mt-1 text-xs text-muted-foreground">Overall Case Assessment</div>
            </div>
          )}

          {/* 3. Final Protest Recommendation — icon + the action itself carry
              the message; explanation is now capped to one short phrase
              server-side, not a paragraph (see MODULE_SPECS.executive). */}
          <div className={`flex items-start gap-3 rounded-lg p-4 ${m.color.bg}`}>
            <RecommendedActionIcon
              action={d.recommendedAction}
              className={`mt-0.5 h-6 w-6 shrink-0 ${m.color.text}`}
            />
            <div className="min-w-0 flex-1">
              <div className={`text-[10px] font-semibold uppercase tracking-wide ${m.color.text}`}>
                Recommended Action
              </div>
              <div className="mt-0.5 font-serif text-lg font-bold">{d.recommendedAction}</div>
              {d.recommendationExplanation && (
                <p className="mt-1 text-sm text-foreground/90">{d.recommendationExplanation}</p>
              )}
            </div>
          </div>
          {d.conflictNote && (
            <div className="flex items-start gap-2 rounded-lg bg-warning/15 p-3 text-sm text-warning-foreground">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p className="min-w-0 flex-1">{d.conflictNote}</p>
            </div>
          )}

          {/* 4. Recommended Protest Strategy — the same StrategyBar visual
              (icon + score bar + number) Module 6's own ranked list already
              uses, so strength reads at a glance instead of via prose; the
              AI's phrase (now capped to ~10 words server-side) is a caption
              under the bar, not a paragraph. */}
          {(strategyData?.strategies[0] || strategyData?.strategies[1]) && (
            <div className="card-elev grid gap-3 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Recommended Protest Strategy
              </div>
              {strategyData.strategies[0] && (
                <div>
                  <StrategyBar s={strategyData.strategies[0]} />
                  {d.primaryStrategyExplanation && (
                    <p className="mt-1 pl-6 text-xs text-muted-foreground">
                      {d.primaryStrategyExplanation}
                    </p>
                  )}
                </div>
              )}
              {strategyData.strategies[1] && d.secondaryStrategyExplanation && (
                <div>
                  <StrategyBar s={strategyData.strategies[1]} />
                  <p className="mt-1 pl-6 text-xs text-muted-foreground">
                    {d.secondaryStrategyExplanation}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* 5. Major Supporting Findings — icon-led, one short line each
              (whyItMatters capped to ~8 words server-side), not paragraphs. */}
          {d.majorFindings.length > 0 && (
            <div>
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Major Supporting Findings
              </div>
              <div className="grid gap-1.5">
                {d.majorFindings.map((f, i) => (
                  <FindingCard key={i} finding={f} onOpenModule={onOpenModule} />
                ))}
              </div>
            </div>
          )}

          {/* 6. Value Recommendation + 7. Financial Opportunity */}
          <div className="grid gap-2 sm:grid-cols-2">
            <FactBox
              label="Recommended Protest Value"
              value={
                d.recommendedProtestValue != null
                  ? currency(d.recommendedProtestValue)
                  : "Additional Analysis Required"
              }
            />
            <FactBox
              label="Value Basis"
              value={d.recommendedProtestValueBasis || "Not enough data yet."}
            />
          </div>
          {estimated.savings > 0 && <CostBenefitRow savings={estimated.savings} />}

          {/* 8. Evidence Readiness */}
          <div className="card-elev p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Evidence Readiness
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {evidenceItems.length === 0
                ? "Evidence checklist not generated yet."
                : criticalMissing.length === 0
                  ? "No top-priority evidence gaps remain."
                  : `${criticalMissing.length} top-priority item${criticalMissing.length === 1 ? "" : "s"} still outstanding.`}
            </p>
            {criticalMissing.length > 0 && (
              <ul className="mt-2 grid gap-1">
                {criticalMissing.map((i, idx) => (
                  <li key={idx} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">{i.item}</span>
                    <button
                      onClick={() => onOpenModule("evidence")}
                      className="shrink-0 text-xs text-accent hover:underline"
                    >
                      Upload →
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* 9. Missing Information */}
          {d.missingInformation.length > 0 && (
            <div className="card-elev p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Missing Information
              </div>
              <ul className="mt-1.5 grid gap-1">
                {d.missingInformation.map((mi, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 flex-1">{mi.item}</span>
                    <span
                      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${
                        mi.severity === "Critical"
                          ? "bg-destructive/10 text-destructive"
                          : mi.severity === "Important"
                            ? "bg-warning/15 text-warning-foreground"
                            : "bg-secondary/60 text-muted-foreground"
                      }`}
                    >
                      {mi.severity}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 10. County-Specific Protest Readiness */}
          {preFilingItems ? (
            <div className="card-elev p-3">
              <div className="flex items-center justify-between">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  County-Specific Protest Readiness
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    isPreFilingBlocked(preFilingItems)
                      ? "bg-warning/15 text-warning-foreground"
                      : "bg-success/15 text-success"
                  }`}
                >
                  {isPreFilingBlocked(preFilingItems)
                    ? "Additional Filing Information Required"
                    : "Ready to File"}
                </span>
              </div>
              <div className="mt-2 grid gap-1 sm:grid-cols-2">
                {preFilingItems.map((item) => (
                  <div key={item.label} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-muted-foreground">{item.label}</span>
                    <span
                      className={item.status === "confirmed" ? "text-success" : "text-destructive"}
                    >
                      {item.status === "confirmed" ? (item.value ?? "Confirmed") : "Missing"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="card-elev p-3 text-sm text-muted-foreground">
              Start a protest to see filing readiness for your county.
            </div>
          )}

          {/* 19-23. Protest Defense Readiness — first version: AI-generated
              property-specific Q&A + a real, deterministically-scored
              readiness gauge (see getDefenseReadinessScore). Read-only in
              this version — editing an answer or reassessing after new
              evidence is a follow-up. */}
          {d.defenseQA.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Protest Defense Readiness
                </div>
                {defenseScore != null && (
                  <span className="text-sm font-bold" style={{ color: scoreColor(defenseScore) }}>
                    {defenseScore}/100
                  </span>
                )}
              </div>
              <div className="grid gap-2">
                {d.defenseQA.map((qa, i) => (
                  <DefenseQARow key={i} qa={qa} onOpenModule={onOpenModule} />
                ))}
              </div>
            </div>
          )}

          {/* 11 & 32. Next Action + single primary CTA */}
          {d.nextAction && <AiVerdictLine icon={ArrowRight} text={d.nextAction} color={m.color} />}
          <div className="flex justify-center">
            {cta ? (
              <button onClick={cta.onClick} className="btn-accent">
                {cta.label}
              </button>
            ) : (
              <Link to="/dashboard/properties" className="btn-accent">
                Complete Missing Information
              </Link>
            )}
          </div>
        </div>
      );
    }
  }

  return <p className="mt-4 text-sm">{m.teaser}</p>;
}

// Thin wrapper around ModulePreviewContent that appends the "Ask AI" Q&A box
// once, regardless of which of ModulePreviewContent's several early-return
// branches rendered — see the comment on ModulePreviewContent above. Skipped
// for "income" (no analysis exists yet to ground an answer in) and "savings"
// (a deterministic formula, not an AI call) — every other module gets one.
function ModulePreviewBody(props: Parameters<typeof ModulePreviewContent>[0]) {
  const showQA = !props.m.requiresUserData && props.m.id !== "savings" && !!props.moduleState?.data;
  return (
    <>
      <ModulePreviewContent {...props} />
      {showQA && <ModuleQABox moduleId={props.m.id} onAskQuestion={props.onAskQuestion} />}
    </>
  );
}

// Per-module "Ask AI" follow-up box — ephemeral by design (plain component
// state, not persisted anywhere), so it resets whenever the modal closes and
// reopens. Answers are grounded server-side in this module's own already-
// generated data — see askModuleQuestion() in ai-report-modules.ts.
function ModuleQABox({
  moduleId,
  onAskQuestion,
}: {
  moduleId: string;
  onAskQuestion: (moduleId: string, question: string) => Promise<string>;
}) {
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [thread, setThread] = useState<{ question: string; answer: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const q = question.trim();
    if (!q || asking) return;
    setAsking(true);
    setError(null);
    try {
      const answer = await onAskQuestion(moduleId, q);
      setThread((prev) => [...prev, { question: q, answer }]);
      setQuestion("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not get an answer. Please retry.");
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="mt-4 border-t border-border/60 pt-4 print:hidden">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Ask AI About This Module
      </div>
      {thread.length > 0 && (
        <div className="mt-2 grid gap-2.5">
          {thread.map((t, i) => (
            <div key={i} className="text-sm">
              <div className="font-medium">{t.question}</div>
              <div className="mt-0.5 text-muted-foreground">{t.answer}</div>
            </div>
          ))}
        </div>
      )}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      <div className="mt-2 flex gap-2">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="Ask a follow-up question…"
          disabled={asking}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm disabled:opacity-60"
        />
        <button
          type="button"
          onClick={submit}
          disabled={asking || !question.trim()}
          className="btn-outline text-sm disabled:opacity-50"
        >
          {asking ? "Asking…" : "Ask"}
        </button>
      </div>
    </div>
  );
}

function scoreColor(score: number): string {
  if (score >= 70) return "var(--success)";
  if (score >= 40) return "var(--warning)";
  return "var(--destructive)";
}

// A continuous version of scoreColor — smoothly interpolated (red at 0,
// amber at 50, green at 100, everything in between blended) rather than
// jumping abruptly at fixed 40/70 cutoffs, for the one place that read as
// "graph-like" enough to want a real gradient: SpeedometerGauge. Uses CSS
// color-mix() (same technique already used for the hub doors' glow tint)
// so it blends the app's real theme tokens directly — correct in both light
// and dark mode — rather than a hardcoded hex gradient.
function gradualScoreColor(score: number): string {
  const s = Math.max(0, Math.min(100, score));
  // Eased, not linear: a plain 0-50 linear blend put 25 at a 50/50 red/amber
  // mix, which reads as orange, not red — the same problem a direct 2-stop
  // red-green mix had at the other extreme (a muddy midpoint, no real
  // yellow). Easing each half toward its own anchor (ease-in low, ease-out
  // high) keeps 25 mostly red and 90 mostly green, while 50 still lands on
  // pure amber — still one continuous curve, just not a straight line.
  if (s <= 50) {
    const t = s / 50;
    const pct = t * t * t * 100;
    return `color-mix(in oklch, var(--warning) ${pct}%, var(--destructive) ${100 - pct}%)`;
  }
  const t = (s - 50) / 50;
  const pct = (1 - (1 - t) * (1 - t) * (1 - t)) * 100;
  return `color-mix(in oklch, var(--success) ${pct}%, var(--warning) ${100 - pct}%)`;
}

function ValueComparisonChart({ current, reduced }: { current: number; reduced: number }) {
  const data = [
    { name: "Current", value: current, fill: "var(--muted-foreground)" },
    { name: "Estimated", value: reduced, fill: "var(--success)" },
  ];
  return (
    <ResponsiveContainer width="100%" height={110}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 56, bottom: 4, left: 4 }}>
        <XAxis type="number" hide domain={[0, (max: number) => max * 1.15]} />
        <YAxis
          type="category"
          dataKey="name"
          width={70}
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 12 }}
        />
        <Bar dataKey="value" radius={[0, 6, 6, 0]} barSize={28}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.fill} />
          ))}
          <LabelList
            dataKey="value"
            position="right"
            formatter={(v: number) => currency(v)}
            style={{ fontSize: 12, fontWeight: 600, fill: "var(--foreground)" }}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// Every module's AI-generated takeaway line goes through this — a tinted,
// icon-led card instead of a bare <p>, so it reads as one distinct visual
// element (like the gauges/chips/tables around it) rather than a paragraph
// to read through. Paired with the tightened word-count prompts server-side
// (see ai-health-score/ai-report-modules' SCHEMA comments — one short
// sentence, not "2-3 sentences" anymore), so the text itself is short
// enough to actually fit this treatment instead of overflowing it.
function AiVerdictLine({
  icon: Icon,
  text,
  color,
}: {
  icon: LucideIcon;
  text: string;
  color: IconColor;
}) {
  return (
    <div className={`min-w-0 flex items-start gap-2.5 rounded-lg p-3 ${color.bg}`}>
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${color.text}`} />
      <p className="min-w-0 flex-1 break-words text-sm font-medium leading-snug">{text}</p>
    </div>
  );
}

function Chip({ children, icon }: { children: React.ReactNode; icon?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary/60 px-3 py-1.5 text-xs font-medium">
      {icon && <CheckCircle2 className="h-3.5 w-3.5 text-success" />}
      {children}
    </span>
  );
}

// Short icon-led fact row — for real, static/deterministic facts (a
// methodology or sources note), not AI prose. Turns what would otherwise be
// a paragraph into one scannable line.
function FactBullet({ icon: Icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return (
    <div className="min-w-0 flex items-start gap-2 text-xs text-muted-foreground">
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

// Connected vertical checklist — replaces stuffing full-sentence AI
// checklist items into rounded-full Chip "pills" (a tag-shaped component
// asked to hold a paragraph, which just wraps into a bulky block). Each
// item still gets its real full text — the checklist can't be shortened
// without losing what it's telling the user to do — but reads as an actual
// step list instead of a wall of stacked pills.
function ChecklistSteps({ items, color }: { items: string[]; color: IconColor }) {
  if (items.length === 0) return null;
  return (
    <div className="grid">
      {items.map((c, i) => (
        <div key={i} className="min-w-0 flex gap-3">
          <div className="flex shrink-0 flex-col items-center">
            <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full ${color.bg}`}>
              <CheckCircle2 className={`h-4 w-4 ${color.text}`} />
            </span>
            {i < items.length - 1 && <div className="my-0.5 w-px flex-1 bg-border" />}
          </div>
          <p className="min-w-0 flex-1 pb-3 text-xs text-muted-foreground">{c}</p>
        </div>
      ))}
    </div>
  );
}

// One row of Module 8's evidence checklist — expandable to show real,
// AI-suggested document types that would satisfy this specific category
// (see MODULE_SPECS.evidence's documentSuggestions), each with its own
// scoped Upload button (tags the file with THIS category directly via
// evidenceItemSlug, no separate categorization pass needed — that's only
// for the generic bulk upload button, which doesn't know the category up
// front). Already-uploaded documents tagged to this category are listed
// too, so the user can see at a glance what's covered vs. still needed.
function EvidenceCategoryRow({
  it,
  uploadedDocs,
  expanded,
  onToggleExpand,
  uploadingEvidence,
  onUploadEvidence,
}: {
  it: ModuleResultMap["evidence"]["items"][number];
  uploadedDocs: DocumentRecord[];
  expanded: boolean;
  onToggleExpand: () => void;
  uploadingEvidence: boolean;
  onUploadEvidence: (files: File[]) => void;
}) {
  const tone =
    it.importance === "High" && it.availability === "Low"
      ? { bg: "bg-destructive/10", text: "text-destructive", label: "Top Priority" }
      : it.importance === "High"
        ? { bg: "bg-warning/15", text: "text-warning-foreground", label: "High Priority" }
        : { bg: "bg-secondary/60", text: "text-muted-foreground", label: null };

  return (
    <div className={`min-w-0 rounded-lg ${tone.bg}`}>
      <button
        type="button"
        onClick={onToggleExpand}
        className="flex w-full min-w-0 items-center gap-2 p-3 text-left"
      >
        {tone.label && (
          <span className={`shrink-0 text-[10px] font-bold uppercase ${tone.text}`}>
            {tone.label}
          </span>
        )}
        <span className="min-w-0 flex-1 text-sm">{it.item}</span>
        {uploadedDocs.length > 0 && (
          <span className="shrink-0 whitespace-nowrap rounded-full bg-success/15 px-1.5 py-0.5 text-[9px] font-semibold text-success">
            {uploadedDocs.length} uploaded
          </span>
        )}
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>

      {expanded && (
        <div className="grid gap-2 border-t border-black/5 px-3 pb-3 pt-2.5">
          {uploadedDocs.length > 0 && (
            <ul className="grid gap-1 text-xs text-muted-foreground">
              {uploadedDocs.map((doc) => (
                <li key={doc.id} className="flex items-center gap-1.5">
                  <CheckCircle2 className="h-3 w-3 shrink-0 text-success" />
                  <span className="min-w-0 truncate">{doc.fileName}</span>
                </li>
              ))}
            </ul>
          )}
          {it.documentSuggestions.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No specific document suggestions for this item — use the Upload Evidence section
              below.
            </p>
          ) : (
            it.documentSuggestions.map((s, i) => (
              <div
                key={i}
                className="rounded-md border border-border bg-background/70 p-2.5 text-xs"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 font-semibold">{s.documentName}</span>
                  <label
                    className={`shrink-0 whitespace-nowrap text-accent hover:underline ${uploadingEvidence ? "pointer-events-none opacity-60" : "cursor-pointer"}`}
                  >
                    {uploadingEvidence ? "Uploading…" : "Upload →"}
                    <input
                      type="file"
                      accept="image/*,.pdf"
                      multiple
                      className="hidden"
                      disabled={uploadingEvidence}
                      onChange={(e) => {
                        const selected = e.target.files ? Array.from(e.target.files) : [];
                        e.target.value = "";
                        if (selected.length > 0) onUploadEvidence(selected);
                      }}
                    />
                  </label>
                </div>
                {s.whatToInclude && <p className="mt-1 text-muted-foreground">{s.whatToInclude}</p>}
                {s.whereToObtain && (
                  <p className="mt-1 text-[10px] font-medium text-muted-foreground">
                    Where to get it: {s.whereToObtain}
                  </p>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// Module 8's per-document AI status — see analyzeEvidence() in
// protest-reason.ts. "Duplicate" is the one value never AI-decided (a real
// SHA-256 match, computed before the AI ever sees the documents), but reads
// the same way here since the badge is just reflecting whatever status the
// document ended up with.
const DOCUMENT_STATUS_TONE: Record<DocumentStatus, string> = {
  Accepted: "bg-success/15 text-success",
  "Needs Review": "bg-warning/15 text-warning-foreground",
  "Incorrect Document": "bg-destructive/10 text-destructive",
  Duplicate: "bg-secondary/60 text-muted-foreground",
  "Additional Information Needed": "bg-accent/15 text-accent",
};

function DocumentStatusBadge({ status }: { status: DocumentStatus }) {
  return (
    <span
      className={`shrink-0 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${DOCUMENT_STATUS_TONE[status]}`}
    >
      {status}
    </span>
  );
}

const ZONING_STATUS = {
  consistent: {
    Icon: CheckCircle2,
    color: "text-success",
    bg: "bg-success/10",
    label: "Classification Consistent",
  },
  inconsistent: {
    Icon: AlertTriangle,
    color: "text-destructive",
    bg: "bg-destructive/10",
    label: "Possible Mismatch",
  },
  uncertain: {
    Icon: HelpCircle,
    color: "text-warning-foreground",
    bg: "bg-warning/15",
    label: "Uncertain — Needs Review",
  },
} as const;

function ZoningBadge({ matches }: { matches: keyof typeof ZONING_STATUS }) {
  const { Icon, color, bg, label } = ZONING_STATUS[matches];
  return (
    <div className={`min-w-0 flex items-center gap-3 rounded-lg p-4 ${bg}`}>
      <Icon className={`h-8 w-8 shrink-0 ${color}`} />
      <div className={`min-w-0 flex-1 font-serif text-lg font-semibold ${color}`}>{label}</div>
    </div>
  );
}

function FactBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-secondary/60 p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 text-sm">{value}</div>
    </div>
  );
}

function ErrorWithRetry({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mt-4 grid gap-2">
      <p className="text-sm text-destructive">{message}</p>
      <button onClick={onRetry} className="btn-outline w-fit text-sm py-1.5">
        Retry
      </button>
    </div>
  );
}

function Field({ label, value, bold }: { label: string; value?: string; bold?: boolean }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={`mt-1 ${bold ? "text-lg font-semibold" : ""}`}>{value ?? "—"}</dd>
    </div>
  );
}
