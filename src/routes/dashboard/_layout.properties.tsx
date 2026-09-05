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
  bracketForValue,
  formatMoney,
  TIER_BRACKET_PRICES,
  type BillingInfo,
  type Tier,
} from "@/lib/billing";
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
  const [subscribing, setSubscribing] = useState<{ propertyId: string; tier: Tier } | null>(null);

  useEffect(() => {
    if (!user) return;
    listProperties(user.id)
      .then(setProperties)
      .catch((err) =>
        setListError(err instanceof Error ? err.message : "Could not load your properties."),
      )
      .finally(() => setPropertiesLoading(false));
    listProtests(user.id)
      .then(setProtests)
      .catch((err) => console.error(err));
    listHealthScores(user.id)
      .then(setHealthScores)
      .catch((err) => console.error(err));
    getMyBilling(user.id)
      .then(setBilling)
      .catch((err) => console.error("Could not load billing info:", err));
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
  // startPropertyCheckout in billing.ts. Redirects the page to Stripe on
  // success; only the failure path needs to release the loading state.
  async function handleSubscribe(p: PropertyRecord, tier: Tier) {
    setSubscribing({ propertyId: p.id, tier });
    try {
      await startPropertyCheckout(p.id, tier);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not start checkout. Please try again.",
      );
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
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setImportOpen(true)} className="btn-outline">
            Import CSV
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
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">{p.cad}</span>
                        <ActionStatusBadge property={p} protests={protests} />
                        {!isBeta && <PaymentStatusBadge paid={isPaid} />}
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
                    {existingProtest && (
                      <Link
                        to="/dashboard/case"
                        search={{ propertyId: p.id }}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn-outline"
                      >
                        View Case
                      </Link>
                    )}
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
                    {isPaid && !isBeta && (
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

// `paid` means this property's OWN real Stripe subscription is active — see
// isPaid in the property map above. Never shown for beta accounts, which
// have no per-property subscription to report on at all.
function PaymentStatusBadge({ paid }: { paid: boolean }) {
  return (
    <span className={paid ? "badge-soft" : "badge-soft-warning"}>{paid ? "Paid" : "Not Paid"}</span>
  );
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
