import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { currency, resetIntake, updateIntake } from "@/lib/intake-store";
import { useAuth } from "@/lib/auth";
import {
  listProperties,
  deleteProperty,
  buildAiReportIntakePatch,
  type PropertyRecord,
} from "@/lib/properties";
import {
  getMyBilling,
  startPropertyCheckout,
  cancelPropertySubscription,
  resumePropertySubscription,
  syncMySubscriptions,
  bracketForValue,
  formatMoney,
  TIER_BRACKET_PRICES,
  type BillingInfo,
  type BulkSubResult,
  type Tier,
} from "@/lib/billing";
import { stripeConfigured } from "@/lib/stripe";
import { BulkSubscribeModal } from "@/components/BulkSubscribeModal";
import { PaymentsModeChip } from "@/components/PaymentsModeChip";
import { useSavingsBackfill } from "@/hooks/use-savings-backfill";
import { listProtests, type ProtestRecord } from "@/lib/protests";
import { listHealthScores, type PropertyAiScore } from "@/lib/property-scores";
import { getPropertyProtestStatus, type ActionStatus } from "@/lib/portfolio-status";
import { Skeleton } from "@/components/ui/skeleton";
import { ProtestAuthorizationFlow } from "@/components/ProtestAuthorizationFlow";
import { Modal } from "@/components/Modal";
import { generateCasePrep } from "@/lib/protest-case";
import { CopyButton } from "@/components/CopyButton";
import { ImportPropertiesModal } from "@/components/ImportPropertiesModal";
import { AddOwnershipsModal } from "@/components/AddOwnershipsModal";
import { BulkProtestAuthorizationFlow } from "@/components/BulkProtestAuthorizationFlow";
import { getCadRecordUrl, isDirectCadRecordUrl } from "@/lib/cad-record-url";
import {
  listDocuments,
  getDocumentUrl,
  previewKind,
  verdictMeta,
  isEvidenceDoc,
  type DocumentRecord,
} from "@/lib/documents";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  ExternalLink,
  X,
  Search,
  LayoutGrid,
  LayoutList,
  ChevronDown,
  FileText,
  Gavel,
  FilePlus,
  Trash2,
  Ban,
  RotateCcw,
  SlidersHorizontal,
} from "lucide-react";

export const Route = createFileRoute("/dashboard/_layout/properties")({
  // Set by startPropertyCheckout's successPath (see billing.ts) — lets this
  // page know it just landed back from a real Stripe checkout, so it can
  // poll for the subscription actually going active (see the effect below)
  // instead of only showing whatever it fetched at the exact instant the
  // page loaded.
  validateSearch: (search: Record<string, unknown>): { checkout?: "success" } => ({
    checkout: search.checkout === "success" ? "success" : undefined,
  }),
  component: Properties,
});

const CURRENT_YEAR = new Date().getFullYear();
const TIER_LABEL: Record<Tier, string> = {
  owner_managed: "Owner-Managed",
  corvusrf_managed: "CorvusPT-Managed",
};

// --- List view / sort / filter toolbar -----------------------------------
// All client-side over the already-loaded `properties` array — no refetch.
// The view + sort + status choices are remembered per browser (a plain UI
// preference); the search box is always cleared on a fresh visit.
type PropertyView = "cards" | "list";
type SortKey = "recent" | "value_desc" | "savings_desc" | "score_desc" | "county" | "status";
type StatusFilter = "all" | "protested" | "not_protested" | "needs_action" | "paid" | "unpaid";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "recent", label: "Recently added" },
  { key: "value_desc", label: "Assessed value (high → low)" },
  { key: "savings_desc", label: "Potential savings (high → low)" },
  { key: "score_desc", label: "AI score (high → low)" },
  { key: "county", label: "County (A → Z)" },
  { key: "status", label: "Status (needs action first)" },
];

const STATUS_FILTER_OPTIONS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All properties" },
  { key: "protested", label: "Protested" },
  { key: "not_protested", label: "Not protested" },
  { key: "needs_action", label: "Needs action" },
  { key: "paid", label: "Paid" },
  { key: "unpaid", label: "Not paid" },
];

const LS_VIEW = "corvus.properties.view";
const LS_SORT = "corvus.properties.sort";
const LS_FILTER = "corvus.properties.filter";
const LS_COLUMNS = "corvus.properties.columns";

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}
function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage blocked (private window etc.) — the choice just won't persist
  }
}

// List view's real table columns, beyond the always-shown Address + Actions.
// User-configurable (a "Columns" picker) and remembered per browser, same as
// the view/sort/filter prefs above — everyone wants a different subset of
// this detail visible at once.
type PropertyColumnKey =
  | "county"
  | "account"
  | "taxYear"
  | "status"
  | "payment"
  | "aiScore"
  | "value"
  | "savings"
  | "deadline"
  | "evidence";

const COLUMN_OPTIONS: { key: PropertyColumnKey; label: string }[] = [
  { key: "county", label: "County" },
  { key: "account", label: "Account #" },
  { key: "taxYear", label: "Tax year" },
  { key: "status", label: "Protest status" },
  { key: "payment", label: "Payment status" },
  { key: "aiScore", label: "AI score" },
  { key: "value", label: "Assessed value" },
  { key: "savings", label: "Est. savings" },
  { key: "deadline", label: "Protest deadline" },
  { key: "evidence", label: "Evidence on file" },
];

// Mirrors exactly what the old (non-configurable) compact row used to show,
// so switching to the table for the first time changes nothing by default —
// deadline and evidence are the two genuinely new, opt-in columns.
const DEFAULT_COLUMNS: PropertyColumnKey[] = [
  "county",
  "account",
  "taxYear",
  "status",
  "payment",
  "aiScore",
  "value",
  "savings",
];

function readColumnsPref(): PropertyColumnKey[] {
  const allowed = new Set(COLUMN_OPTIONS.map((c) => c.key));
  try {
    const raw = localStorage.getItem(LS_COLUMNS);
    if (!raw) return DEFAULT_COLUMNS;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_COLUMNS;
    const cleaned = parsed.filter(
      (v): v is PropertyColumnKey => typeof v === "string" && allowed.has(v as PropertyColumnKey),
    );
    // An empty result (everything unchecked) is a real, deliberate choice —
    // just Address + Actions — not treated as "no preference saved."
    return cleaned;
  } catch {
    return DEFAULT_COLUMNS;
  }
}
function writeColumnsPref(cols: PropertyColumnKey[]) {
  try {
    localStorage.setItem(LS_COLUMNS, JSON.stringify(cols));
  } catch {
    // storage blocked — the choice just won't persist
  }
}

function Properties() {
  const navigate = useNavigate();
  const { checkout } = Route.useSearch();
  const { user } = useAuth();
  const [properties, setProperties] = useState<PropertyRecord[]>([]);
  const [propertiesLoading, setPropertiesLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [protests, setProtests] = useState<ProtestRecord[]>([]);
  const [healthScores, setHealthScores] = useState<Record<string, PropertyAiScore>>({});
  const [authorizingProperty, setAuthorizingProperty] = useState<PropertyRecord | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [ownershipsOpen, setOwnershipsOpen] = useState(false);
  const [authorizingBatch, setAuthorizingBatch] = useState<PropertyRecord[] | null>(null);
  const [billing, setBilling] = useState<BillingInfo | null>(null);
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [subscribing, setSubscribing] = useState<{ propertyId: string; tier: Tier } | null>(null);
  // The property the "Protest Property" button opened the plan chooser for.
  const [protestingProperty, setProtestingProperty] = useState<PropertyRecord | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  // The property whose "Documents" quick-view popup is open.
  const [docsProperty, setDocsProperty] = useState<PropertyRecord | null>(null);
  // Toolbar: how the list is shown, ordered, and filtered. View/sort/status
  // are restored from the last visit; search always starts empty.
  const [view, setView] = useState<PropertyView>(() =>
    readPref(LS_VIEW, ["cards", "list"] as const, "cards"),
  );
  const [sortKey, setSortKey] = useState<SortKey>(() =>
    readPref(
      LS_SORT,
      ["recent", "value_desc", "savings_desc", "score_desc", "county", "status"] as const,
      "recent",
    ),
  );
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() =>
    readPref(
      LS_FILTER,
      ["all", "protested", "not_protested", "needs_action", "paid", "unpaid"] as const,
      "all",
    ),
  );
  const [search, setSearch] = useState("");
  const [columns, setColumns] = useState<PropertyColumnKey[]>(() => readColumnsPref());
  // Only for the List view's "Evidence on file" column — one fetch of every
  // document up front (same call the Documents page makes), not one call per
  // property, then filtered client-side per row with the same isEvidenceDoc
  // rule Module 8 and the Pre-Filing Check already use.
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);

  function toggleColumn(key: PropertyColumnKey) {
    setColumns((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      writeColumnsPref(next);
      return next;
    });
  }

  useEffect(() => {
    if (!user) return;
    const uid = user.id;
    listProperties(uid)
      .then(setProperties)
      .catch((err) =>
        setListError(err instanceof Error ? err.message : "Could not load your properties."),
      )
      .finally(() => setPropertiesLoading(false));
    listProtests(uid)
      .then(setProtests)
      .catch((err) => console.error(err));
    listHealthScores(uid)
      .then(setHealthScores)
      .catch((err) => console.error(err));
    listDocuments(uid)
      .then(setDocuments)
      .catch((err) => console.error("Could not load documents for the Evidence column:", err));
    getMyBilling(uid)
      .then(setBilling)
      .catch((err) => console.error("Could not load billing info:", err));
    // Self-heal a missed/delayed Stripe webhook — reconcile each property's
    // subscription_status (and cancel flags / tier) from Stripe, then re-pull
    // the list if anything moved. Non-blocking: the DB-backed list above still
    // renders immediately; this only corrects it a beat later when needed
    // (e.g. a paid property still showing "Not Paid").
    syncMySubscriptions()
      .then(({ updated }) => {
        if (updated > 0) {
          listProperties(uid).then(setProperties).catch(console.error);
          getMyBilling(uid).then(setBilling).catch(console.error);
        }
      })
      .catch((err) => console.error("Subscription reconcile failed:", err));
  }, [user]);

  // Real race, not a bug: Stripe redirects the browser to successPath the
  // instant checkout completes, but the webhook that actually flips a
  // property's subscriptionStatus to "active" (stripe-webhook/index.ts) is a
  // separate, slightly-delayed server-to-server call — so the very first
  // fetch above can land just before it, showing "Not Paid" for a property
  // that really was just paid for. Landing here with ?checkout=success (set
  // by startPropertyCheckout's successPath) re-fetches a few times over the
  // next several seconds to catch up, rather than requiring a manual
  // refresh. Clears the query param once done so a later plain page
  // reload/revisit never re-triggers this.
  useEffect(() => {
    if (!user || checkout !== "success") return;
    let cancelled = false;
    const delaysMs = [1500, 3000, 5000, 8000];
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const delay of delaysMs) {
      timers.push(
        setTimeout(() => {
          if (cancelled) return;
          listProperties(user.id)
            .then(setProperties)
            .catch((err) => console.error("Could not refresh properties:", err));
        }, delay),
      );
    }
    navigate({ to: ".", search: (prev) => ({ ...prev, checkout: undefined }), replace: true });
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, checkout]);

  // Beta is a free, unlimited grant (see handle_new_user() in schema.sql) —
  // never gated by a per-property subscription. Every other plan reads each
  // property's OWN real subscriptionStatus directly (see isPaid in the
  // property map below) — there's no account-level entitlement math anymore
  // now that every property has its own independent Stripe subscription.
  const isBeta = billing?.plan === "beta";

  useEffect(() => writePref(LS_VIEW, view), [view]);
  useEffect(() => writePref(LS_SORT, sortKey), [sortKey]);
  useEffect(() => writePref(LS_FILTER, statusFilter), [statusFilter]);

  useSavingsBackfill(properties, setProperties);

  // Starts a real, one-click checkout for exactly this property — see
  // startPropertyCheckout in billing.ts. Opens in a new tab (newTab: true)
  // so the property list stays put underneath; unlike a same-tab redirect,
  // that means this tab never navigates away, so the loading state is
  // always released here, not just on the failure path.
  async function handleSubscribe(p: PropertyRecord, tier: Tier) {
    setSubscribing({ propertyId: p.id, tier });
    try {
      await startPropertyCheckout(p.id, tier, { newTab: true });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not start checkout. Please try again.",
      );
    } finally {
      setSubscribing(null);
    }
  }

  // Cancels exactly this property's own subscription — unambiguous now that
  // each property has its own (see cancel-property-subscription/index.ts).
  async function handleCancelSubscription(p: PropertyRecord) {
    const confirmed = window.confirm(
      `Cancel the subscription for ${p.address}? You'll lose paid AI Report access and the ability to request a new protest filing for this property.`,
    );
    if (!confirmed) return;
    setCancelingId(p.id);
    try {
      await cancelPropertySubscription(p.id);
      toast.success("Subscription canceled.");
      // Reflects immediately rather than waiting on the customer.
      // subscription.deleted webhook round trip; the webhook confirms the
      // same value a moment later (idempotent, not a conflict).
      setProperties((prev) =>
        prev.map((x) => (x.id === p.id ? { ...x, subscriptionStatus: "canceled" } : x)),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not cancel this subscription.");
    } finally {
      setCancelingId(null);
    }
  }

  // Undoes a subscription already scheduled to cancel at period end — the
  // Stripe Customer Portal's own "Cancel subscription" defaults to
  // cancel-at-period-end (unlike this page's own Cancel Subscription button,
  // which cancels immediately), so a property can land in that state without
  // ever touching this page. Before this, cancelAtPeriodEnd/"Canceling at
  // period end" was only ever displayed, never something the user could
  // undo from inside the app — resumePropertySubscription existed and was
  // tested but had no caller anywhere.
  async function handleResumeSubscription(p: PropertyRecord) {
    setResumingId(p.id);
    try {
      await resumePropertySubscription(p.id);
      toast.success("Subscription resumed — it will keep renewing as normal.");
      setProperties((prev) =>
        prev.map((x) => (x.id === p.id ? { ...x, cancelAtPeriodEnd: false, cancelAt: null } : x)),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not resume this subscription.");
    } finally {
      setResumingId(null);
    }
  }

  // Deleting a property with an active subscription would leave that
  // subscription still running (and still billing) with nothing left in the
  // app to see or cancel it from — the property row is its only link back
  // to cancelPropertySubscription/the Stripe subscription id. Checked here
  // too (not just via the button's own disabled state below) so this can
  // never fire for a paid property regardless of how it's triggered.
  async function handleDelete(p: PropertyRecord, isPaid: boolean) {
    if (isPaid) {
      toast.error("Cancel this property's subscription before deleting it.");
      return;
    }
    if (!window.confirm(`Remove ${p.address} from your dashboard?`)) return;
    setDeletingId(p.id);
    try {
      await deleteProperty(p.id);
      setProperties((prev) => prev.filter((x) => x.id !== p.id));
      resetIntake();
      toast.success("Property removed.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove this property.");
    } finally {
      setDeletingId(null);
    }
  }

  // Bulk delete for the current selection. Same guard as the single delete —
  // a property with a live Stripe subscription can't go (it'd keep billing
  // with no way left to cancel it); those are skipped and reported. Beta
  // accounts have no real subscription so nothing blocks there.
  async function handleDeleteSelected() {
    const chosen = properties.filter((p) => selectedIds.has(p.id));
    const blocked = chosen.filter((p) => !isBeta && p.subscriptionStatus === "active");
    const deletable = chosen.filter((p) => isBeta || p.subscriptionStatus !== "active");
    if (deletable.length === 0) {
      toast.error("Every selected property has an active subscription — cancel those first.");
      return;
    }
    const n = deletable.length;
    if (
      !window.confirm(
        `Remove ${n} propert${n === 1 ? "y" : "ies"} from your dashboard?` +
          (blocked.length
            ? `\n\n${blocked.length} with an active subscription will be skipped.`
            : ""),
      )
    ) {
      return;
    }
    setBulkDeleting(true);
    const results = await Promise.allSettled(deletable.map((p) => deleteProperty(p.id)));
    const okIds = new Set(
      deletable.filter((_, i) => results[i].status === "fulfilled").map((p) => p.id),
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    setProperties((prev) => prev.filter((x) => !okIds.has(x.id)));
    setSelectedIds((prev) => new Set([...prev].filter((id) => !okIds.has(id))));
    if (okIds.size > 0) {
      resetIntake();
      toast.success(`${okIds.size} propert${okIds.size === 1 ? "y" : "ies"} removed.`);
    }
    if (failed > 0) toast.error(`${failed} could not be removed. Please try again.`);
    if (blocked.length > 0) {
      toast.warning(
        `${blocked.length} skipped — cancel the subscription before deleting${blocked.length === 1 ? "" : " those"}.`,
      );
    }
    setBulkDeleting(false);
  }

  // Most recently added first, per explicit request — the property you just
  // added/imported should be the first thing you see, not wherever its own
  // protest deadline happens to rank it. This stays the base order for the
  // bulk-action derivations below; the toolbar's own sort applies only to
  // what's rendered (displayProperties).
  const sortedProperties = [...properties].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  // What the list actually renders: the toolbar's search + status filter +
  // sort applied over the loaded properties. Everything here is derived from
  // data already on the page (protests, healthScores) — no refetch.
  const displayProperties = useMemo(() => {
    const q = search.trim().toLowerCase();
    const scoreOf = (id: string) => healthScores[id]?.score ?? -1;
    const isProtested = (p: PropertyRecord) => protests.some((pr) => pr.propertyId === p.id);
    const isPaidP = (p: PropertyRecord) => isBeta || p.subscriptionStatus === "active";

    let out = sortedProperties.filter((p) => {
      if (q) {
        const hay = [p.address, p.accountNumber, p.cad, p.propertyType]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      switch (statusFilter) {
        case "protested":
          return isProtested(p);
        case "not_protested":
          return !isProtested(p);
        case "needs_action":
          return getPropertyProtestStatus(p, protests).status === "needs_action";
        case "paid":
          return isPaidP(p);
        case "unpaid":
          return !isPaidP(p);
        default:
          return true;
      }
    });

    const STATUS_RANK: Record<ActionStatus, number> = {
      needs_action: 0,
      in_progress: 1,
      on_track: 2,
      resolved: 3,
    };
    out = [...out];
    switch (sortKey) {
      case "value_desc":
        out.sort((a, b) => (b.totalValue ?? 0) - (a.totalValue ?? 0));
        break;
      case "savings_desc":
        out.sort((a, b) => (b.estimatedSavings ?? 0) - (a.estimatedSavings ?? 0));
        break;
      case "score_desc":
        out.sort((a, b) => scoreOf(b.id) - scoreOf(a.id));
        break;
      case "county":
        out.sort((a, b) => (a.cad ?? "").localeCompare(b.cad ?? ""));
        break;
      case "status":
        out.sort(
          (a, b) =>
            STATUS_RANK[getPropertyProtestStatus(a, protests).status] -
            STATUS_RANK[getPropertyProtestStatus(b, protests).status],
        );
        break;
      // "recent" — already in sortedProperties order
    }
    return out;
  }, [sortedProperties, search, statusFilter, sortKey, protests, healthScores, isBeta]);

  function openAiReport(p: PropertyRecord) {
    updateIntake(buildAiReportIntakePatch(p));
    navigate({ to: "/ai-report" });
  }

  // Per-property values both the card and the compact row need. Kept in one
  // place so the two renderers can't drift.
  function rowInfo(p: PropertyRecord) {
    const existingProtest = protests.find((pr) => pr.propertyId === p.id);
    const canReFile =
      existingProtest?.status === "resolved" &&
      existingProtest.taxYear != null &&
      existingProtest.taxYear < CURRENT_YEAR;
    const cad = p.cad;
    const recordUrl = cad ? getCadRecordUrl({ cad, accountNumber: p.accountNumber }) : null;
    const isPaid = isBeta || p.subscriptionStatus === "active";
    return { existingProtest, canReFile, cad, recordUrl, isPaid };
  }

  // One cell's content for the List table's configurable columns — every
  // column reads from data already loaded on this page (protests,
  // healthScores, documents), never a new fetch per row.
  function columnCell(key: PropertyColumnKey, p: PropertyRecord): ReactNode {
    const muted = (text: string) => <span className="text-muted-foreground">{text}</span>;
    switch (key) {
      case "county":
        return muted(p.cad ?? "—");
      case "account":
        return p.accountNumber ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            {p.accountNumber}
            <CopyButton value={p.accountNumber} label="Account number copied" />
          </span>
        ) : (
          muted("—")
        );
      case "taxYear":
        return muted(p.taxYear != null ? String(p.taxYear) : "—");
      case "status":
        return <ActionStatusBadge property={p} protests={protests} />;
      case "payment":
        return isBeta ? muted("—") : <PaymentStatusBadge property={p} />;
      case "aiScore": {
        const s = healthScores[p.id];
        return s ? <span className="font-medium text-accent">{s.score}/100</span> : muted("—");
      }
      case "value":
        return (
          <span className="font-medium tabular-nums">{currency(p.totalValue ?? undefined)}</span>
        );
      case "savings":
        return p.estimatedSavings && p.estimatedSavings > 0 ? (
          <span className="tabular-nums text-accent">{currency(p.estimatedSavings)}</span>
        ) : (
          muted("—")
        );
      case "deadline":
        return p.protestDeadline
          ? muted(new Date(`${p.protestDeadline}T00:00:00`).toLocaleDateString())
          : muted("—");
      case "evidence": {
        const docs = documents.filter((d) => d.propertyId === p.id && isEvidenceDoc(d));
        if (docs.length === 0) return muted("None yet");
        const flagged = docs.filter(
          (d) => d.aiVerdict === "issues" || d.aiVerdict === "invalid",
        ).length;
        return (
          <span className={flagged > 0 ? "text-warning-foreground" : "text-muted-foreground"}>
            {docs.length} doc{docs.length === 1 ? "" : "s"}
            {flagged > 0 ? ` · ${flagged} flagged` : ""}
          </span>
        );
      }
    }
  }

  // Live-ish = a Stripe subscription that already exists / is pending, so
  // bulk-subscribe would refuse it (mirrors bulk-subscribe's server guard).
  const LIVEISH_SUB = new Set(["active", "trialing", "incomplete", "past_due", "unpaid"]);
  // A property gets a selection checkbox unless it's fully subscribed — an
  // "active" property can be neither bulk-subscribed (already is) nor
  // bulk-deleted (would strand a billing subscription).
  const bulkEligible = (p: PropertyRecord) => p.subscriptionStatus !== "active";
  // The user's chosen List-view columns, minus Payment for a beta account
  // (nothing to report — no per-property subscription exists to show).
  const visibleColumnOptions = COLUMN_OPTIONS.filter(
    (c) => columns.includes(c.key) && !(c.key === "payment" && isBeta),
  );
  const selectedProperties = sortedProperties.filter((p) => selectedIds.has(p.id));
  // Of the selection, the ones bulk-subscribe can actually take.
  const subscribableSelected = selectedProperties.filter(
    (p) => !isBeta && !LIVEISH_SUB.has(p.subscriptionStatus ?? ""),
  );

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleBulkDone(results: BulkSubResult[]) {
    const active = results.filter((r) => r.status === "active").length;
    const needs = results.filter((r) => r.status === "needs_action");
    const errors = results.filter((r) => r.status === "error");
    if (active > 0) toast.success(`${active} propert${active === 1 ? "y" : "ies"} subscribed.`);
    if (needs.length > 0) {
      toast.warning(
        `${needs.length} subscription${needs.length === 1 ? "" : "s"} need payment confirmation — check your email or the billing portal.`,
      );
    }
    errors.forEach((r) => toast.error(r.message ?? "A subscription could not be created."));
    setSelectedIds(new Set());
    if (user) {
      listProperties(user.id).then(setProperties).catch(console.error);
      getMyBilling(user.id).then(setBilling).catch(console.error);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-baseline gap-2">
          <h1 className="font-serif text-2xl font-semibold">My Properties</h1>
          {!propertiesLoading && (
            <span className="badge-soft">
              {properties.length} propert{properties.length === 1 ? "y" : "ies"}
            </span>
          )}
          <PaymentsModeChip />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Bulk actions for a multi-selection — once one or more property
              checkboxes are ticked, this floats and stays pinned near the top
              of the viewport (position: sticky) as the page scrolls, rather
              than scrolling away with the rest of this heading row — a long
              property list means selections are often made well below the
              fold. */}
          {selectedIds.size > 0 && (
            <div className="sticky top-4 z-20 mr-1 flex items-center gap-2 rounded-lg border border-accent/40 bg-card py-1 pl-3 pr-1 shadow-md">
              <span className="text-sm font-medium">{selectedIds.size} selected</span>
              <button
                type="button"
                disabled={bulkDeleting}
                onClick={handleDeleteSelected}
                className="btn-outline text-destructive text-sm disabled:opacity-60"
              >
                {bulkDeleting ? "Deleting…" : "Delete"}
              </button>
              {stripeConfigured && subscribableSelected.length > 0 && (
                <button
                  type="button"
                  onClick={() => setBulkOpen(true)}
                  className="btn-primary btn-primary-hover text-sm"
                >
                  Protest
                  {subscribableSelected.length !== selectedIds.size &&
                    ` (${subscribableSelected.length})`}
                </button>
              )}
              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                aria-label="Clear selection"
                className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
          <button type="button" onClick={() => setImportOpen(true)} className="btn-outline">
            Bulk Upload
          </button>
          <button type="button" onClick={() => setOwnershipsOpen(true)} className="btn-outline">
            Add Ownerships
          </button>
          <Link
            to="/intake"
            onClick={() => resetIntake()}
            className="btn-primary btn-primary-hover"
          >
            Add another property
          </Link>
        </div>
      </div>

      {importOpen && user && (
        <ImportPropertiesModal
          userId={user.id}
          onImported={(imported) => setProperties((prev) => [...imported, ...prev])}
          onClose={() => setImportOpen(false)}
        />
      )}

      {ownershipsOpen && user && (
        <AddOwnershipsModal
          userId={user.id}
          onImported={(imported) => {
            setProperties((prev) => [...imported, ...prev]);
            // Proceed straight into protest authorization for exactly the
            // properties just added, one at a time — see
            // BulkProtestAuthorizationFlow for why this is still N real
            // per-property authorizations, not one merged signature.
            if (imported.length > 0) setAuthorizingBatch(imported);
          }}
          onClose={() => setOwnershipsOpen(false)}
        />
      )}

      <BulkSubscribeModal
        properties={subscribableSelected}
        open={bulkOpen && subscribableSelected.length > 0}
        onOpenChange={setBulkOpen}
        onDone={handleBulkDone}
      />

      {!propertiesLoading && properties.length > 0 && (
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[14rem] flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search address, account, county…"
              aria-label="Search properties"
              className="w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm"
            />
          </div>

          <label className="sr-only" htmlFor="prop-status-filter">
            Filter by status
          </label>
          <select
            id="prop-status-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="rounded-md border border-input bg-background px-2.5 py-2 text-sm"
          >
            {STATUS_FILTER_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>

          <label className="sr-only" htmlFor="prop-sort">
            Sort properties
          </label>
          <select
            id="prop-sort"
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="rounded-md border border-input bg-background px-2.5 py-2 text-sm"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                Sort: {o.label}
              </option>
            ))}
          </select>

          <div className="ml-auto inline-flex overflow-hidden rounded-md border border-input">
            <button
              type="button"
              onClick={() => setView("cards")}
              aria-pressed={view === "cards"}
              title="Card view"
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm ${
                view === "cards" ? "bg-secondary font-medium" : "text-muted-foreground"
              }`}
            >
              <LayoutGrid className="h-4 w-4" />
              Cards
            </button>
            <button
              type="button"
              onClick={() => setView("list")}
              aria-pressed={view === "list"}
              title="List view"
              className={`inline-flex items-center gap-1.5 border-l border-input px-3 py-2 text-sm ${
                view === "list" ? "bg-secondary font-medium" : "text-muted-foreground"
              }`}
            >
              <LayoutList className="h-4 w-4" />
              List
            </button>
          </div>

          {view === "list" && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="btn-outline inline-flex items-center gap-1.5 text-sm"
                >
                  <SlidersHorizontal className="h-4 w-4" />
                  Columns
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>Show columns</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {COLUMN_OPTIONS.filter((c) => !(c.key === "payment" && isBeta)).map((c) => (
                  <DropdownMenuCheckboxItem
                    key={c.key}
                    checked={columns.includes(c.key)}
                    onSelect={(e) => e.preventDefault()}
                    onCheckedChange={() => toggleColumn(c.key)}
                  >
                    {c.label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {(search.trim() || statusFilter !== "all") && (
            <span className="w-full text-xs text-muted-foreground sm:w-auto">
              {displayProperties.length} of {properties.length} shown
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  setStatusFilter("all");
                }}
                className="ml-2 underline underline-offset-2 hover:text-foreground"
              >
                Clear
              </button>
            </span>
          )}
        </div>
      )}

      <div className="mt-5">
        {listError && <p className="mb-4 text-sm text-destructive">{listError}</p>}
        {propertiesLoading ? (
          <div className="grid gap-4">
            <PropertyCardSkeleton />
            <PropertyCardSkeleton />
          </div>
        ) : properties.length === 0 ? (
          <div className="card-elev p-8 text-center">
            <h3 className="font-serif text-xl font-semibold">No properties yet.</h3>
            <p className="text-muted-foreground mt-1">
              Start with an address or upload an appraisal notice.
            </p>
            <Link
              to="/intake"
              onClick={() => resetIntake()}
              className="btn-primary btn-primary-hover mt-4 inline-flex"
            >
              Start Free AI Property Review
            </Link>
          </div>
        ) : displayProperties.length === 0 ? (
          <div className="card-elev p-8 text-center">
            <h3 className="font-serif text-xl font-semibold">No matches.</h3>
            <p className="text-muted-foreground mt-1">No property matches your search or filter.</p>
            <button
              type="button"
              onClick={() => {
                setSearch("");
                setStatusFilter("all");
              }}
              className="btn-outline mt-4"
            >
              Clear filters
            </button>
          </div>
        ) : view === "list" ? (
          <div className="card-elev overflow-x-auto p-0">
            <table className="w-full min-w-[56rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="w-9 px-3 py-2.5" />
                  <th className="min-w-[14rem] px-3 py-2.5">Address</th>
                  {visibleColumnOptions.map((c) => (
                    <th key={c.key} className="whitespace-nowrap px-3 py-2.5">
                      {c.label}
                    </th>
                  ))}
                  <th className="px-3 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {displayProperties.map((p) => {
                  const { existingProtest, canReFile, cad, recordUrl, isPaid } = rowInfo(p);
                  return (
                    <tr
                      key={p.id}
                      className="border-b border-border/60 align-top last:border-0 hover:bg-secondary/30"
                    >
                      <td className="px-3 py-2.5">
                        {bulkEligible(p) && (
                          <input
                            type="checkbox"
                            aria-label={`Select ${p.address} for bulk subscribe`}
                            checked={selectedIds.has(p.id)}
                            onChange={() => toggleSelected(p.id)}
                            className="h-4 w-4"
                          />
                        )}
                      </td>
                      <td className="px-3 py-2.5 font-medium">{p.address}</td>
                      {visibleColumnOptions.map((c) => (
                        <td key={c.key} className="whitespace-nowrap px-3 py-2.5">
                          {columnCell(c.key, p)}
                        </td>
                      ))}
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          <button
                            onClick={() => openAiReport(p)}
                            className="btn-outline whitespace-nowrap px-2.5 py-1 text-xs"
                          >
                            Open AI Report
                          </button>
                          {existingProtest && isPaid && (
                            <Link
                              to="/dashboard/case"
                              search={{ propertyId: p.id }}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="btn-outline whitespace-nowrap px-2.5 py-1 text-xs"
                            >
                              View Case
                            </Link>
                          )}
                          <PropertyActionsMenu
                            p={p}
                            info={{ existingProtest, canReFile, cad, recordUrl, isPaid }}
                            isBeta={isBeta}
                            deletingId={deletingId}
                            cancelingId={cancelingId}
                            resumingId={resumingId}
                            subscribing={subscribing}
                            compact
                            onDocuments={() => setDocsProperty(p)}
                            onAuthorize={() => setAuthorizingProperty(p)}
                            onProtest={() => setProtestingProperty(p)}
                            onResume={() => handleResumeSubscription(p)}
                            onCancel={() => handleCancelSubscription(p)}
                            onDelete={() => handleDelete(p, isPaid)}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="grid gap-4">
            {displayProperties.map((p, i) => {
              const { existingProtest, canReFile, cad, recordUrl, isPaid } = rowInfo(p);
              return (
                <div
                  key={p.id}
                  className="card-elev p-6"
                  style={{ animationDelay: `${Math.min(i, 8) * 60}ms` }}
                >
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        {bulkEligible(p) && (
                          <input
                            type="checkbox"
                            aria-label={`Select ${p.address} for bulk subscribe`}
                            checked={selectedIds.has(p.id)}
                            onChange={() => toggleSelected(p.id)}
                            className="h-4 w-4 shrink-0"
                          />
                        )}
                        <span className="min-w-0 truncate text-xs text-muted-foreground">
                          {p.cad}
                        </span>
                        <ActionStatusBadge property={p} protests={protests} />
                        {!isBeta && <PaymentStatusBadge property={p} />}
                      </div>
                      <h3 className="font-serif text-xl font-semibold">{p.address}</h3>
                      <p className="text-sm text-muted-foreground inline-flex items-center flex-wrap gap-1">
                        {p.propertyType} • Acct {p.accountNumber}
                        {p.accountNumber && (
                          <CopyButton value={p.accountNumber} label="Account number copied" />
                        )}
                        • Tax year {p.taxYear}
                      </p>
                      <AiScoreBadge score={healthScores[p.id]} />
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-xs text-muted-foreground">Assessed value</div>
                      <div className="text-2xl font-semibold">
                        {currency(p.totalValue ?? undefined)}
                      </div>
                      <SavingsLine
                        estimatedSavings={p.estimatedSavings}
                        savingsBasis={p.savingsBasis}
                      />
                    </div>
                  </div>
                  <div className="mt-4 flex gap-2 flex-wrap items-center">
                    <button onClick={() => openAiReport(p)} className="btn-outline">
                      Open AI Report
                    </button>
                    {existingProtest && !isPaid && (
                      <button
                        type="button"
                        disabled
                        title="Subscribe to this property to view its case."
                        className="btn-outline cursor-not-allowed opacity-60"
                      >
                        View Case
                      </button>
                    )}
                    <PropertyActionsMenu
                      p={p}
                      info={{ existingProtest, canReFile, cad, recordUrl, isPaid }}
                      isBeta={isBeta}
                      deletingId={deletingId}
                      cancelingId={cancelingId}
                      resumingId={resumingId}
                      subscribing={subscribing}
                      onDocuments={() => setDocsProperty(p)}
                      onAuthorize={() => setAuthorizingProperty(p)}
                      onProtest={() => setProtestingProperty(p)}
                      onResume={() => handleResumeSubscription(p)}
                      onCancel={() => handleCancelSubscription(p)}
                      onDelete={() => handleDelete(p, isPaid)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {docsProperty && user && (
        <PropertyDocsModal
          userId={user.id}
          property={docsProperty}
          onClose={() => setDocsProperty(null)}
        />
      )}

      {protestingProperty && (
        <Modal onClose={() => setProtestingProperty(null)}>
          <div className="p-6">
            <h2 className="font-serif text-xl font-bold">Protest this property</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {protestingProperty.address} — choose how you want to run the protest.
            </p>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {(
                [
                  {
                    tier: "owner_managed" as const,
                    tagline:
                      "You file and attend; Corvus does the AI analysis, the pre-filled forms, the evidence packet, and step-by-step guidance the whole way.",
                  },
                  {
                    tier: "corvusrf_managed" as const,
                    tagline:
                      "Corvus handles the filing, the informal negotiation, scheduling, and hearing representation on your behalf.",
                  },
                ] as const
              ).map(({ tier, tagline }) => {
                const bracket = bracketForValue(protestingProperty.totalValue);
                const isSubscribingThis =
                  subscribing?.propertyId === protestingProperty.id && subscribing.tier === tier;
                return (
                  <div key={tier} className="flex flex-col rounded-lg border border-border p-4">
                    <div className="text-sm font-semibold text-foreground">{TIER_LABEL[tier]}</div>
                    <div className="mt-1 font-serif text-2xl font-bold">
                      ${formatMoney(TIER_BRACKET_PRICES[tier][bracket])}
                      <span className="text-sm font-normal text-muted-foreground">/mo</span>
                    </div>
                    <p className="mt-2 flex-1 text-xs text-muted-foreground">{tagline}</p>
                    <button
                      disabled={!!subscribing}
                      onClick={async () => {
                        await handleSubscribe(protestingProperty, tier);
                        setProtestingProperty(null);
                      }}
                      className="btn-primary btn-primary-hover mt-3 disabled:opacity-60"
                    >
                      {isSubscribingThis ? "Redirecting…" : `Choose ${TIER_LABEL[tier]}`}
                    </button>
                  </div>
                );
              })}
            </div>
            <p className="mt-4 text-[11px] text-muted-foreground">
              You'll be taken to Stripe to start the subscription for this property. You can cancel
              anytime from this page.
            </p>
          </div>
        </Modal>
      )}

      {authorizingProperty && user && (
        <ProtestAuthorizationFlow
          userId={user.id}
          property={authorizingProperty}
          userEmail={user.email}
          isPaid={isBeta || authorizingProperty.subscriptionStatus === "active"}
          open={!!authorizingProperty}
          onOpenChange={(open) => {
            if (!open) setAuthorizingProperty(null);
          }}
          onDone={(created) => {
            setProtests((prev) => [created, ...prev]);
            // Best-effort — the protest request itself is already saved regardless
            // of whether case-prep generation succeeds (see protest-case.ts).
            generateCasePrep(created.id, user.id, authorizingProperty).catch((err) =>
              console.error("Case prep generation failed:", err),
            );
          }}
        />
      )}

      {authorizingBatch && user && (
        <BulkProtestAuthorizationFlow
          userId={user.id}
          properties={authorizingBatch}
          userEmail={user.email}
          isBeta={isBeta}
          open={!!authorizingBatch}
          onOpenChange={(open) => {
            if (!open) setAuthorizingBatch(null);
          }}
          onAllDone={(completedProtests) => {
            setProtests((prev) => [...completedProtests, ...prev]);
            for (const created of completedProtests) {
              const property = authorizingBatch.find((p) => p.id === created.propertyId);
              if (!property) continue;
              generateCasePrep(created.id, user.id, property).catch((err) =>
                console.error("Case prep generation failed:", err),
              );
            }
            setAuthorizingBatch(null);
          }}
        />
      )}
    </div>
  );
}

// Every per-property action except "Open AI Report" (kept as its own button)
// collapsed into one menu, so a card isn't a wall of eight buttons. Same
// contextual rules as the old inline buttons — nothing new is enabled here,
// it's only regrouped. Used by both the card and the compact list row.
function PropertyActionsMenu({
  p,
  info,
  isBeta,
  deletingId,
  cancelingId,
  resumingId,
  subscribing,
  compact,
  onDocuments,
  onAuthorize,
  onProtest,
  onResume,
  onCancel,
  onDelete,
}: {
  p: PropertyRecord;
  info: {
    existingProtest: ProtestRecord | undefined;
    canReFile: boolean;
    cad: string | null;
    recordUrl: string | null;
    isPaid: boolean;
  };
  isBeta: boolean;
  deletingId: string | null;
  cancelingId: string | null;
  resumingId: string | null;
  subscribing: { propertyId: string; tier: Tier } | null;
  compact?: boolean;
  onDocuments: () => void;
  onAuthorize: () => void;
  onProtest: () => void;
  onResume: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const { existingProtest, canReFile, cad, recordUrl, isPaid } = info;
  const showRequestFiling = isPaid && !existingProtest;
  const showRefile = isPaid && !!existingProtest && canReFile;
  const showProtest = !isPaid;
  const showSubMgmt = isPaid && !isBeta;
  const hasMiddle = showRequestFiling || showRefile || showProtest || showSubMgmt;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Actions for ${p.address}`}
        className={
          compact
            ? "btn-outline group inline-flex items-center gap-1.5 px-2.5 py-1 text-xs"
            : "btn-outline group inline-flex items-center gap-1.5"
        }
      >
        Actions
        <ChevronDown className="h-3.5 w-3.5 opacity-50 transition-transform group-data-[state=open]:rotate-180" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {existingProtest && isPaid && (
          <DropdownMenuItem asChild>
            <Link
              to="/dashboard/case"
              search={{ propertyId: p.id }}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Gavel className="mr-2 h-4 w-4" /> View Case
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={onDocuments}>
          <FileText className="mr-2 h-4 w-4" /> Documents
        </DropdownMenuItem>
        {recordUrl && cad && (
          <DropdownMenuItem asChild>
            <a href={recordUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="mr-2 h-4 w-4" />
              {isDirectCadRecordUrl(cad) ? "View Official CAD Record" : `Search on ${cad}`}
            </a>
          </DropdownMenuItem>
        )}

        {hasMiddle && <DropdownMenuSeparator />}
        {showRequestFiling && (
          <DropdownMenuItem onClick={onAuthorize}>
            <FilePlus className="mr-2 h-4 w-4" /> Request Protest Filing
          </DropdownMenuItem>
        )}
        {showRefile && (
          <DropdownMenuItem onClick={onAuthorize}>
            <FilePlus className="mr-2 h-4 w-4" /> Re-file for {CURRENT_YEAR}
          </DropdownMenuItem>
        )}
        {showProtest && (
          <DropdownMenuItem onClick={onProtest} disabled={!!subscribing}>
            <Gavel className="mr-2 h-4 w-4" />
            {subscribing?.propertyId === p.id ? "Redirecting…" : "Protest Property"}
          </DropdownMenuItem>
        )}
        {showSubMgmt && p.cancelAtPeriodEnd && (
          <DropdownMenuItem onClick={onResume} disabled={resumingId === p.id}>
            <RotateCcw className="mr-2 h-4 w-4" />
            {resumingId === p.id ? "Resuming…" : "Resume Subscription"}
          </DropdownMenuItem>
        )}
        {showSubMgmt && !p.cancelAtPeriodEnd && (
          <DropdownMenuItem
            onClick={onCancel}
            disabled={cancelingId === p.id}
            className="text-warning-foreground"
          >
            <Ban className="mr-2 h-4 w-4" />
            {cancelingId === p.id ? "Canceling…" : "Cancel Subscription"}
          </DropdownMenuItem>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={onDelete}
          disabled={deletingId === p.id || isPaid}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="mr-2 h-4 w-4" />
          {deletingId === p.id
            ? "Removing…"
            : isPaid
              ? "Delete (cancel subscription first)"
              : "Delete"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Quick, read-only look at a property's documents without leaving this page —
// the file list plus an inline preview (PDF/image). Anything that changes a
// document (edit, rename, AI review) still lives in the Documents tab, linked
// from the header here.
function PropertyDocsModal({
  userId,
  property,
  onClose,
}: {
  userId: string;
  property: PropertyRecord;
  onClose: () => void;
}) {
  const [docs, setDocs] = useState<DocumentRecord[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState<DocumentRecord | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [urlError, setUrlError] = useState(false);

  useEffect(() => {
    let live = true;
    listDocuments(userId)
      .then((all) => {
        if (!live) return;
        const mine = all
          .filter((d) => d.propertyId === property.id)
          .sort((a, b) => +new Date(b.uploadedAt) - +new Date(a.uploadedAt));
        setDocs(mine);
        setSelected(mine[0] ?? null);
      })
      .catch(() => {
        if (live) setLoadError(true);
      });
    return () => {
      live = false;
    };
  }, [userId, property.id]);

  useEffect(() => {
    if (!selected) {
      setUrl(null);
      setUrlError(false);
      return;
    }
    let live = true;
    setUrl(null);
    setUrlError(false);
    getDocumentUrl(selected.storagePath)
      .then((u) => live && setUrl(u))
      .catch(() => live && setUrlError(true));
    return () => {
      live = false;
    };
  }, [selected]);

  const kind = selected ? previewKind(selected.fileName) : "none";

  return (
    <Modal onClose={onClose} xl>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-serif text-xl font-bold">Documents</h2>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">{property.address}</p>
        </div>
        <Link to="/dashboard/documents" className="btn-outline shrink-0 text-xs">
          Open Documents tab
        </Link>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Quick view only — edit, rename, or run an AI review from the Documents tab.
      </p>

      {loadError ? (
        <p className="mt-6 text-sm text-destructive">Couldn't load documents.</p>
      ) : docs === null ? (
        <p className="mt-6 text-sm text-muted-foreground">Loading…</p>
      ) : docs.length === 0 ? (
        <div className="mt-6 rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">
          No documents for this property yet.
        </div>
      ) : (
        // minmax(0,1fr) on the preview track is what lets it shrink below the
        // iframe's intrinsic width instead of pushing the whole modal wider.
        <div className="mt-4 grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
          <ul className="grid max-h-48 gap-1 overflow-y-auto pr-1 lg:max-h-[72vh]">
            {docs.map((d) => {
              const v = verdictMeta(d.aiVerdict);
              const active = selected?.id === d.id;
              return (
                <li key={d.id} className="min-w-0">
                  <button
                    type="button"
                    onClick={() => setSelected(d)}
                    className={`w-full min-w-0 rounded-md border px-2.5 py-2 text-left text-xs ${
                      active ? "border-accent bg-accent/5" : "border-border hover:bg-secondary"
                    }`}
                  >
                    <div className="truncate font-medium">{d.fileName}</div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-muted-foreground">
                      <span className="min-w-0 truncate">
                        {d.documentType ?? d.category ?? "Document"}
                      </span>
                      <span className="shrink-0">·</span>
                      <span className="shrink-0">
                        {new Date(d.uploadedAt).toLocaleDateString()}
                      </span>
                    </div>
                    {d.aiCheckedAt && (
                      <div
                        className={`mt-0.5 text-[10px] font-semibold ${
                          v.tone === "success"
                            ? "text-success"
                            : v.tone === "warning"
                              ? "text-warning-foreground"
                              : "text-destructive"
                        }`}
                      >
                        AI: {v.label}
                      </div>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="grid min-h-[55vh] min-w-0 place-items-center overflow-hidden rounded-lg bg-secondary/40 lg:min-h-[72vh]">
            {!selected ? (
              <p className="p-6 text-sm text-muted-foreground">Select a document.</p>
            ) : urlError ? (
              <p className="p-6 text-sm text-destructive">Couldn't load this document.</p>
            ) : !url ? (
              <p className="p-6 text-sm text-muted-foreground">Loading…</p>
            ) : kind === "pdf" ? (
              <iframe title={selected.fileName} src={url} className="h-[55vh] w-full lg:h-[72vh]" />
            ) : kind === "image" ? (
              <img
                src={url}
                alt={selected.fileName}
                className="max-h-[55vh] w-auto object-contain lg:max-h-[72vh]"
              />
            ) : (
              <div className="p-6 text-center text-sm text-muted-foreground">
                <p>No inline preview for this file type.</p>
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-outline mt-3 inline-flex text-xs"
                >
                  Open in new tab
                </a>
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

// Surfaces the same needs_action/in_progress/resolved/on_track status the
// dashboard home nudge banner is driven by (src/lib/portfolio-status.ts) — a
// property never looks different here than it does in that banner, since both
// read from the one shared helper.
const STATUS_TONE: Record<ActionStatus, string> = {
  needs_action: "text-destructive",
  in_progress: "text-accent",
  resolved: "text-success",
  on_track: "text-muted-foreground",
};

function ActionStatusBadge({
  property,
  protests,
}: {
  property: PropertyRecord;
  protests: ProtestRecord[];
}) {
  const { status, label } = getPropertyProtestStatus(property, protests);
  return <span className={`badge-soft ${STATUS_TONE[status]}`}>{label}</span>;
}

// Reflects this property's OWN Stripe subscription state. Never shown for beta
// accounts, which have no per-property subscription to report on. "Canceled"
// (a subscription the user deliberately ended) is called out separately from
// "Not Paid" (never subscribed) — both mean no active coverage and both still
// show the Subscribe buttons, but the wording shouldn't read as "you forgot
// to pay" when the user chose to cancel.
function PaymentStatusBadge({ property }: { property: PropertyRecord }) {
  const status = property.subscriptionStatus;
  if (status === "active") {
    return property.cancelAtPeriodEnd ? (
      <span className="badge-soft bg-secondary text-muted-foreground">Canceling</span>
    ) : (
      <span className="badge-soft">Paid</span>
    );
  }
  if (status === "canceled") {
    return <span className="badge-soft text-destructive">Canceled</span>;
  }
  if (status === "past_due" || status === "unpaid" || status === "incomplete") {
    return <span className="badge-soft-warning">Payment pending</span>;
  }
  return <span className="badge-soft-warning">Not Paid</span>;
}

// Only appears once the background AI health-score call (fired from addProperty())
// has landed — no loading state or placeholder, since older properties added before
// this feature shipped will simply never have a score and that's fine.
function AiScoreBadge({ score }: { score: PropertyAiScore | undefined }) {
  if (!score) return null;
  return (
    <p className="mt-1 text-sm text-accent">
      AI Score: {score.score}/100 — {score.summary}
    </p>
  );
}

// Shows the real per-property savings estimate computed during intake (see
// intake.tsx's runValidation) — the only number persisted here, never a
// fabricated one. Properties added before this field existed, or where the
// comps/formula method produced nothing usable, simply show nothing.
function SavingsLine({
  estimatedSavings,
  savingsBasis,
}: {
  estimatedSavings: number | null;
  // "ai" and "baseline" are legacy values from before the estimate was made
  // fully deterministic — still shown correctly on old rows, nothing writes
  // them anymore.
  savingsBasis: "comps" | "formula" | "ai" | "baseline" | null;
}) {
  if (!estimatedSavings || estimatedSavings <= 0) return null;
  return (
    <div className="mt-1">
      <div className="text-xs text-muted-foreground">Potential savings</div>
      <div className="text-lg font-semibold text-accent">
        {currency(estimatedSavings)}
        {(savingsBasis === "formula" || savingsBasis === "ai" || savingsBasis === "baseline") && (
          <span className="ml-1 align-middle text-[10px] font-normal text-muted-foreground">
            (estimate)
          </span>
        )}
      </div>
    </div>
  );
}

function PropertyCardSkeleton() {
  return (
    <div className="card-elev p-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="grid gap-2">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-4 w-56" />
        </div>
        <div className="grid gap-2 justify-items-end">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-7 w-32" />
        </div>
      </div>
      <div className="mt-4 flex gap-2">
        <Skeleton className="h-9 w-20" />
        <Skeleton className="h-9 w-20" />
      </div>
    </div>
  );
}
