import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { getMyBilling, openBillingPortal, PLAN_OPTIONS, type PlanValue } from "@/lib/billing";
import { listProperties, type PropertyRecord } from "@/lib/properties";

export const Route = createFileRoute("/dashboard/_layout/billing")({
  component: Billing,
});

const TIER_LABEL: Record<string, string> = {
  owner_managed: "Owner-Managed",
  corvusrf_managed: "CorvusPT-Managed",
};

function Billing() {
  const { user } = useAuth();
  const [plan, setPlan] = useState<PlanValue | null>(null);
  const [properties, setProperties] = useState<PropertyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [openingPortal, setOpeningPortal] = useState(false);

  useEffect(() => {
    if (!user) return;
    Promise.all([getMyBilling(user.id), listProperties(user.id)])
      .then(([b, props]) => {
        setPlan(b.plan);
        setProperties(props);
      })
      .catch((err) => console.error(err))
      .finally(() => setLoading(false));
  }, [user]);

  async function handleManage() {
    setOpeningPortal(true);
    try {
      await openBillingPortal();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not open billing portal.");
      setOpeningPortal(false);
    }
  }

  const isBeta = plan === "beta";
  const planLabel = PLAN_OPTIONS.find((o) => o.value === plan)?.label ?? plan;
  // Every property now carries its own independent Stripe subscription (see
  // src/lib/properties.ts) — there's no single account-level subscription to
  // summarize anymore, so this lists each one instead.
  const subscribedProperties = properties.filter(
    (p) => p.subscriptionStatus === "active" || p.cancelAtPeriodEnd,
  );

  return (
    <div>
      <h1 className="font-serif text-2xl font-semibold">Billing</h1>
      <p className="text-muted-foreground text-sm">Your CorvusPT subscriptions, by property.</p>

      {loading ? (
        <p className="mt-6 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="mt-6 card-elev p-6 max-w-xl">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">Current plan</div>
          <div className="mt-1 font-serif text-2xl font-semibold">{planLabel}</div>

          {isBeta ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Every AI module is unlocked on every property, free, for as long as you're in the beta
              — no subscriptions to manage.
            </p>
          ) : subscribedProperties.length > 0 ? (
            <ul className="mt-4 grid gap-2">
              {subscribedProperties.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{p.address}</div>
                    <div className="text-xs text-muted-foreground">
                      {p.planTier ? TIER_LABEL[p.planTier] : "—"}
                      {p.cancelAtPeriodEnd && " · Canceling at period end"}
                    </div>
                  </div>
                  <span className="badge-soft shrink-0">
                    {p.subscriptionStatus === "active" ? "Active" : (p.subscriptionStatus ?? "—")}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              You don't have any paid property subscriptions yet.
            </p>
          )}

          <div className="mt-6 grid gap-2 sm:flex sm:flex-wrap">
            <Link to="/dashboard/properties" className="btn-outline">
              Manage Properties
            </Link>
            {!isBeta && subscribedProperties.length > 0 && (
              <button
                onClick={handleManage}
                disabled={openingPortal}
                className="btn-outline disabled:opacity-60"
              >
                {openingPortal ? "Redirecting…" : "Manage Billing"}
              </button>
            )}
            {!isBeta && (
              <Link to="/pricing" className="btn-primary btn-primary-hover">
                {subscribedProperties.length > 0 ? "Compare Plans" : "See Pricing"}
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
