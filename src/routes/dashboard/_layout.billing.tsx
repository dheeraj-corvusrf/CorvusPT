import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import {
  getMyBilling,
  openBillingPortal,
  listMySubscriptions,
  formatMoney,
  TIER_BRACKET_PRICES,
  VALUE_BRACKETS,
  type PlanValue,
  type MySubscription,
} from "@/lib/billing";
import { listProperties, type PropertyRecord } from "@/lib/properties";

export const Route = createFileRoute("/dashboard/_layout/billing")({
  component: Billing,
});

const TIER_LABEL: Record<string, string> = {
  owner_managed: "Owner-Managed",
  corvusrf_managed: "CorvusPT-Managed",
};

const BRACKET_LABEL: Record<string, string> = Object.fromEntries(
  VALUE_BRACKETS.map((b) => [b.value, b.label]),
);

const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  trialing: "Trial",
  past_due: "Past due",
  unpaid: "Unpaid",
  incomplete: "Incomplete",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function money(cents: number | null): string {
  if (cents == null) return "—";
  return `$${formatMoney(Math.round(cents) / 100)}`;
}

function Billing() {
  const { user } = useAuth();
  const [plan, setPlan] = useState<PlanValue | null>(null);
  const [properties, setProperties] = useState<PropertyRecord[]>([]);
  const [subs, setSubs] = useState<MySubscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [subsError, setSubsError] = useState(false);
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
    // Stripe read, kept separate: a slow/failed Stripe call shouldn't hold up
    // the plan + property list, and its own failure just hides the money
    // detail (amount/renewal/card) rather than blanking the page.
    listMySubscriptions()
      .then(setSubs)
      .catch((err) => {
        console.error(err);
        setSubsError(true);
      });
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
  const propsById = new Map(properties.map((p) => [p.id, p]));

  // A subscription set to cancel is still billed until its period end, but it
  // isn't part of the ongoing monthly commitment — keep it out of the running
  // total (it still appears in the list below, with its own end date).
  const billingSubs = subs.filter((s) => !s.cancelAtPeriodEnd);
  const monthlyTotalCents = billingSubs.reduce((sum, s) => sum + (s.amountCents ?? 0), 0);
  const nextChargeIso =
    billingSubs
      .map((s) => s.currentPeriodEnd)
      .filter((d): d is string => !!d)
      .sort()[0] ?? null;

  return (
    <div>
      <h1 className="font-serif text-2xl font-semibold">Billing</h1>
      <p className="text-muted-foreground text-sm">Your CorvusPT subscriptions, by property.</p>

      {loading ? (
        <p className="text-muted-foreground mt-6 text-sm">Loading…</p>
      ) : isBeta ? (
        <div className="card-elev mt-6 max-w-2xl p-6">
          <div className="text-muted-foreground text-xs uppercase tracking-wide">Current plan</div>
          <div className="mt-1 font-serif text-2xl font-semibold">Beta</div>
          <p className="text-muted-foreground mt-2 text-sm">
            Every AI module is unlocked on every property, free, for as long as you're in the beta —
            no subscriptions to manage.
          </p>
        </div>
      ) : subs.length === 0 ? (
        <div className="card-elev mt-6 max-w-2xl p-6">
          <p className="text-muted-foreground text-sm">
            {subsError
              ? "Couldn't load your subscriptions just now. Try again shortly, or open the billing portal."
              : "You don't have any paid property subscriptions yet."}
          </p>
          <div className="mt-4 grid gap-2 sm:flex sm:flex-wrap">
            <Link to="/dashboard/properties" className="btn-outline">
              Manage Properties
            </Link>
            <Link to="/pricing" className="btn-primary btn-primary-hover">
              See Pricing
            </Link>
          </div>
        </div>
      ) : (
        <div className="mt-6 grid max-w-2xl gap-6">
          {/* Portfolio summary */}
          <div className="card-elev p-6">
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <div className="text-muted-foreground text-xs uppercase tracking-wide">Active</div>
                <div className="mt-1 font-serif text-2xl font-semibold">{billingSubs.length}</div>
                <div className="text-muted-foreground text-xs">
                  subscription{billingSubs.length === 1 ? "" : "s"}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs uppercase tracking-wide">
                  Monthly total
                </div>
                <div className="mt-1 font-serif text-2xl font-semibold">
                  {money(monthlyTotalCents)}
                </div>
                <div className="text-muted-foreground text-xs">across all properties</div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs uppercase tracking-wide">
                  Next charge
                </div>
                <div className="mt-1 font-serif text-2xl font-semibold">
                  {fmtDate(nextChargeIso)}
                </div>
                <div className="text-muted-foreground text-xs">earliest renewal</div>
              </div>
            </div>
            <div className="mt-5 grid gap-2 sm:flex sm:flex-wrap">
              <button
                onClick={handleManage}
                disabled={openingPortal}
                className="btn-outline disabled:opacity-60"
              >
                {openingPortal ? "Redirecting…" : "Payment method & invoices"}
              </button>
              <Link to="/dashboard/properties" className="btn-outline">
                Add or cancel a property
              </Link>
              <Link to="/pricing" className="btn-primary btn-primary-hover">
                Compare Plans
              </Link>
            </div>
            {subsError && (
              <p className="text-warning-foreground mt-3 text-xs">
                Some billing details couldn't be loaded from Stripe just now — amounts and dates may
                be missing.
              </p>
            )}
          </div>

          {/* One card per real subscription */}
          <ul className="grid gap-3">
            {subs.map((s) => {
              const prop = s.propertyId ? propsById.get(s.propertyId) : undefined;
              const tierLabel = s.tier ? (TIER_LABEL[s.tier] ?? s.tier) : null;
              const bracketLabel = s.bracket ? (BRACKET_LABEL[s.bracket] ?? null) : null;
              const listCents =
                s.tier && s.bracket ? TIER_BRACKET_PRICES[s.tier][s.bracket] * 100 : null;
              const discounted =
                listCents != null && s.amountCents != null && s.amountCents < listCents - 1;
              const heading =
                prop?.address ??
                s.productName ??
                (tierLabel ? `${tierLabel} subscription` : "Property subscription");
              const meta = [
                tierLabel,
                bracketLabel,
                prop?.accountNumber && `Acct ${prop.accountNumber}`,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <li key={s.id} className="card-elev p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium">{heading}</div>
                      {meta && <div className="text-muted-foreground text-xs">{meta}</div>}
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="font-semibold">
                        {money(s.amountCents)}
                        <span className="text-muted-foreground text-xs font-normal">/mo</span>
                      </div>
                      {discounted && (
                        <div className="text-accent text-[11px]">2nd-property discount applied</div>
                      )}
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span
                      className={`badge-soft ${
                        s.cancelAtPeriodEnd ? "bg-secondary text-muted-foreground" : ""
                      }`}
                    >
                      {s.cancelAtPeriodEnd ? "Canceling" : (STATUS_LABEL[s.status] ?? s.status)}
                    </span>
                    <span className="text-muted-foreground">
                      {s.cancelAtPeriodEnd
                        ? `Ends ${fmtDate(s.cancelAt ?? s.currentPeriodEnd)}`
                        : s.currentPeriodEnd
                          ? `Renews ${fmtDate(s.currentPeriodEnd)}`
                          : ""}
                      {s.card && ` · ${s.card.brand} ···· ${s.card.last4}`}
                    </span>
                  </div>
                  {!prop && (
                    <p className="text-muted-foreground mt-2 text-[11px]">
                      Not linked to a current property — it may have been deleted. Use the billing
                      portal to cancel it.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
