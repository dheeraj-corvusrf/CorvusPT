import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
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
import { generateCasePrep } from "@/lib/protest-case";
import { CopyButton } from "@/components/CopyButton";
import { ImportPropertiesModal } from "@/components/ImportPropertiesModal";
import { AddOwnershipsModal } from "@/components/AddOwnershipsModal";
import { BulkProtestAuthorizationFlow } from "@/components/BulkProtestAuthorizationFlow";
import { getCadRecordUrl, isDirectCadRecordUrl } from "@/lib/cad-record-url";
import { ExternalLink } from "lucide-react";

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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);

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
  // protest deadline happens to rank it.
  const sortedProperties = [...properties].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  function openAiReport(p: PropertyRecord) {
    updateIntake(buildAiReportIntakePatch(p));
    navigate({ to: "/ai-report" });
  }

  // Live-ish = a Stripe subscription that already exists / is pending, so
  // bulk-subscribe would refuse it (mirrors bulk-subscribe's server guard).
  const LIVEISH_SUB = new Set(["active", "trialing", "incomplete", "past_due", "unpaid"]);
  // A property gets a selection checkbox unless it's fully subscribed — an
  // "active" property can be neither bulk-subscribed (already is) nor
  // bulk-deleted (would strand a billing subscription).
  const bulkEligible = (p: PropertyRecord) => p.subscriptionStatus !== "active";
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
        <div className="flex flex-wrap gap-2">
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

      {selectedIds.size > 0 && (
        <div className="card-elev mt-4 flex flex-wrap items-center justify-between gap-3 p-3">
          <span className="text-sm font-medium">
            {selectedIds.size} propert{selectedIds.size === 1 ? "y" : "ies"} selected
          </span>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="btn-outline text-sm"
            >
              Clear
            </button>
            <button
              type="button"
              disabled={bulkDeleting}
              onClick={handleDeleteSelected}
              className="btn-outline text-destructive text-sm disabled:opacity-60"
            >
              {bulkDeleting ? "Deleting…" : "Delete selected"}
            </button>
            {stripeConfigured && subscribableSelected.length > 0 && (
              <button
                type="button"
                onClick={() => setBulkOpen(true)}
                className="btn-accent text-sm"
              >
                Subscribe selected
                {subscribableSelected.length !== selectedIds.size &&
                  ` (${subscribableSelected.length})`}
              </button>
            )}
          </div>
        </div>
      )}

      <BulkSubscribeModal
        properties={subscribableSelected}
        open={bulkOpen && subscribableSelected.length > 0}
        onOpenChange={setBulkOpen}
        onDone={handleBulkDone}
      />

      <div className="mt-6">
        {listError && <p className="mb-4 text-sm text-destructive">{listError}</p>}
        {propertiesLoading ? (
          <div className="grid gap-4">
            <PropertyCardSkeleton />
            <PropertyCardSkeleton />
          </div>
        ) : properties.length > 0 ? (
          <div className="grid gap-4">
            {sortedProperties.map((p, i) => {
              const existingProtest = protests.find((pr) => pr.propertyId === p.id);
              // A resolved protest from a prior tax year shouldn't permanently block
              // filing again — only offer re-filing once the case is actually closed
              // and a newer tax year has come around (never for an in-progress case).
              const canReFile =
                existingProtest?.status === "resolved" &&
                existingProtest.taxYear != null &&
                existingProtest.taxYear < CURRENT_YEAR;
              const cad = p.cad;
              const recordUrl = cad
                ? getCadRecordUrl({ cad, accountNumber: p.accountNumber })
                : null;
              // Beta bypasses per-property billing entirely; every other
              // plan reads this exact property's own real subscription.
              const isPaid = isBeta || p.subscriptionStatus === "active";
              const bracket = bracketForValue(p.totalValue);
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
                    {recordUrl && cad && (
                      <a
                        href={recordUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn-outline inline-flex items-center gap-1.5"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        {isDirectCadRecordUrl(cad)
                          ? "View Official CAD Record"
                          : `Search on ${cad}`}
                      </a>
                    )}
                    {existingProtest &&
                      (isPaid ? (
                        <Link
                          to="/dashboard/case"
                          search={{ propertyId: p.id }}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="btn-outline"
                        >
                          View Case
                        </Link>
                      ) : (
                        <button
                          type="button"
                          disabled
                          title="Subscribe to this property to view its case."
                          className="btn-outline cursor-not-allowed opacity-60"
                        >
                          View Case
                        </button>
                      ))}
                    {isPaid ? (
                      !existingProtest ? (
                        <button onClick={() => setAuthorizingProperty(p)} className="btn-outline">
                          Request Protest Filing
                        </button>
                      ) : (
                        canReFile && (
                          <button
                            onClick={() => setAuthorizingProperty(p)}
                            className="btn-primary btn-primary-hover"
                          >
                            Re-file for {CURRENT_YEAR}
                          </button>
                        )
                      )
                    ) : (
                      (["owner_managed", "corvusrf_managed"] as const).map((tier) => {
                        const isSubscribingThis =
                          subscribing?.propertyId === p.id && subscribing.tier === tier;
                        return (
                          <button
                            key={tier}
                            disabled={!!subscribing}
                            onClick={() => handleSubscribe(p, tier)}
                            className="btn-outline disabled:opacity-60"
                          >
                            {isSubscribingThis
                              ? "Redirecting…"
                              : `Subscribe — ${TIER_LABEL[tier]} $${formatMoney(TIER_BRACKET_PRICES[tier][bracket])}/mo`}
                          </button>
                        );
                      })
                    )}
                    {isPaid && !isBeta && p.cancelAtPeriodEnd && (
                      <button
                        disabled={resumingId === p.id}
                        onClick={() => handleResumeSubscription(p)}
                        className="btn-outline disabled:opacity-60"
                      >
                        {resumingId === p.id ? "Resuming…" : "Resume Subscription"}
                      </button>
                    )}
                    {isPaid && !isBeta && !p.cancelAtPeriodEnd && (
                      <button
                        disabled={cancelingId === p.id}
                        onClick={() => handleCancelSubscription(p)}
                        className="btn-outline text-warning-foreground disabled:opacity-60"
                      >
                        {cancelingId === p.id ? "Canceling…" : "Cancel Subscription"}
                      </button>
                    )}
                    <button
                      disabled={deletingId === p.id || isPaid}
                      onClick={() => handleDelete(p, isPaid)}
                      className="btn-outline text-destructive disabled:opacity-60"
                      title={
                        isPaid
                          ? "Cancel this property's subscription before deleting it."
                          : undefined
                      }
                    >
                      {deletingId === p.id ? "Removing…" : "Delete"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
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
        )}
      </div>

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
