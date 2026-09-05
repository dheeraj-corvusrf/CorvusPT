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
  getEntitledPropertyIds,
  bracketPropertyCount,
  planUsesPerPropertyEntitlement,
  removePropertyFromPlan,
  type BillingInfo,
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
  component: Properties,
});

const CURRENT_YEAR = new Date().getFullYear();

function Properties() {
  const navigate = useNavigate();
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
  const [removingFromPlanId, setRemovingFromPlanId] = useState<string | null>(null);

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

  // Which properties this subscription's paid bracket quantities actually
  // cover — see getEntitledPropertyIds's own comment in billing.ts (oldest
  // `paidPropertyCount` properties, by createdAt). Only meaningful for the
  // two real bracket-priced tiers (planUsesPerPropertyEntitlement) — beta
  // and the free/legacy plans have no such per-property purchase to check
  // against, so `entitledIds` stays null: no Paid/Not Paid badge, and
  // Request Protest Filing/Re-file stay unrestricted for those. Unconditional
  // otherwise (no admin toggle) — drives both the badge below and the real
  // gate on Request Protest Filing/Re-file (see isPaid in the property map).
  const showsPaymentStatus = !!billing && planUsesPerPropertyEntitlement(billing.plan);
  // The REAL Stripe-paid count — not entitledIds.size, which is capped at
  // properties.length and so understates this whenever the subscription
  // pays for more properties than the customer has actually added yet.
  const paidCount = billing ? bracketPropertyCount(billing.subscriptionBrackets) : 0;
  const entitledIds = showsPaymentStatus ? getEntitledPropertyIds(properties, paidCount) : null;

  useSavingsBackfill(properties, setProperties);

  // Real "stop paying for this one" action (see remove-property-from-plan/
  // index.ts) — reduces the paid count by one directly on the live Stripe
  // subscription. Coverage is oldest-properties-first across the WHOLE
  // account, not a specific slot tied to this property (see
  // getEntitledPropertyIds's own comment in billing.ts), so reducing the
  // count by one doesn't always mean THIS exact property loses coverage —
  // simulated here (one fewer paid slot) so the confirmation is honest about
  // which outcome will actually happen before the customer confirms.
  async function handleRemoveFromPlan(p: PropertyRecord) {
    const stillCoveredAfter = getEntitledPropertyIds(properties, Math.max(0, paidCount - 1)).has(
      p.id,
    );
    const confirmed = window.confirm(
      stillCoveredAfter
        ? "This reduces your paid property count by one. Coverage applies to your oldest properties first, so a different (newer) property will lose coverage instead of this one. Continue?"
        : `This removes paid coverage for ${p.address} — you'll no longer be charged for it, and it'll show as Not Paid. Continue?`,
    );
    if (!confirmed || !user) return;
    setRemovingFromPlanId(p.id);
    try {
      await removePropertyFromPlan(p.id);
      toast.success("Your plan has been updated.");
      // Real remaining count comes back from Stripe immediately; the DB's
      // own profiles.qty_* sync lands a moment later via the existing
      // customer.subscription.updated webhook, same lag any Stripe-driven
      // change already has. Re-fetching billing here (rather than trusting
      // the function's own return value to patch state by hand) keeps this
      // page reading from the one real source, same as on initial load.
      const fresh = await getMyBilling(user.id);
      setBilling(fresh);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not update your plan. Please try again.",
      );
    } finally {
      setRemovingFromPlanId(null);
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Remove this property from your dashboard?")) return;
    setDeletingId(id);
    try {
      await deleteProperty(id);
      setProperties((prev) => prev.filter((p) => p.id !== id));
      resetIntake();
      toast.success("Property removed.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove this property.");
    } finally {
      setDeletingId(null);
    }
  }

  // Soonest deadline first — the property that needs attention should always be
  // the first thing you see, not buried in whatever order they were added.
  const sortedProperties = [...properties].sort((a, b) => {
    const rankA = a.protestDeadline ? new Date(a.protestDeadline).getTime() : Infinity;
    const rankB = b.protestDeadline ? new Date(b.protestDeadline).getTime() : Infinity;
    return rankA - rankB;
  });

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
              // No entitlement cap applies at all (beta/free/legacy plans —
              // see showsPaymentStatus above) counts as paid: there's
              // nothing to gate. Otherwise, real per-property coverage.
              const isPaid = !entitledIds || entitledIds.has(p.id);
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
                        {entitledIds && <PaymentStatusBadge paid={entitledIds.has(p.id)} />}
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
                    <Link to="/pricing" className="btn-outline">
                      Upgrade
                    </Link>
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
                    {existingProtest ? (
                      <>
                        <Link
                          to="/dashboard/case"
                          search={{ propertyId: p.id }}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="btn-outline"
                        >
                          View Case
                        </Link>
                        {canReFile && (
                          <ProtestActionButton
                            isPaid={isPaid}
                            label={`Re-file for ${CURRENT_YEAR}`}
                            primary
                            onAuthorize={() => setAuthorizingProperty(p)}
                          />
                        )}
                      </>
                    ) : (
                      <ProtestActionButton
                        isPaid={isPaid}
                        label="Request Protest Filing"
                        onAuthorize={() => setAuthorizingProperty(p)}
                      />
                    )}
                    {isPaid && entitledIds && (
                      <button
                        disabled={removingFromPlanId === p.id}
                        onClick={() => handleRemoveFromPlan(p)}
                        className="btn-outline text-warning-foreground disabled:opacity-60"
                      >
                        {removingFromPlanId === p.id ? "Updating…" : "Remove from Plan"}
                      </button>
                    )}
                    <button
                      disabled={deletingId === p.id}
                      onClick={() => handleDelete(p.id)}
                      className="btn-outline text-destructive disabled:opacity-60"
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

// Only rendered at all on a bracket-priced plan (owner_managed/
// corvusrf_managed) — see showsPaymentStatus/entitledIds above. `paid` means
// this property is one of the ones the subscription's paid property count
// actually covers (oldest properties first — see getEntitledPropertyIds in
// billing.ts), not that a payment was literally attached to this one row.
function PaymentStatusBadge({ paid }: { paid: boolean }) {
  return (
    <span className={paid ? "badge-soft" : "badge-soft-warning"}>{paid ? "Paid" : "Not Paid"}</span>
  );
}

// Request Protest Filing / Re-file, gated on isPaid. Renders grayed out (not
// a true `disabled` button — still a real, clickable link) when the
// property isn't paid for: a bracket-priced subscription's paid property
// count is a QUANTITY, not tied to any specific price/bracket, so there's no
// way to know from here which of the 6 real prices (2 tiers × 3 value
// brackets) this specific property should be added under, or to send anyone
// straight into Stripe with that already decided — Pricing is where the
// customer actually sees and picks their tier/bracket themselves. Opens in
// a new tab so the property list stays put underneath.
function ProtestActionButton({
  isPaid,
  label,
  onAuthorize,
  primary,
}: {
  isPaid: boolean;
  label: string;
  onAuthorize: () => void;
  primary?: boolean;
}) {
  const className = `${primary ? "btn-primary btn-primary-hover" : "btn-outline"} ${isPaid ? "" : "opacity-50"}`;
  if (!isPaid) {
    return (
      <Link
        to="/pricing"
        target="_blank"
        rel="noopener noreferrer"
        className={className}
        title="This property isn't covered by your plan yet — opens Pricing in a new tab so you can add it."
      >
        {label}
      </Link>
    );
  }
  return (
    <button onClick={onAuthorize} className={className}>
      {label}
    </button>
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
