import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { ScrollReveal } from "@/components/ScrollReveal";
import {
  openBillingPortal,
  getMyBilling,
  VALUE_BRACKETS,
  TIER_BRACKET_PRICES,
  CUSTOM_TIER,
  ADDITIONAL_PROPERTY_DISCOUNT,
  type PlanValue,
  type Tier,
} from "@/lib/billing";

export const Route = createFileRoute("/pricing")({
  head: () => ({
    meta: [
      { title: "Pricing — CorvusPT" },
      {
        name: "description",
        content:
          "Property-value-tiered pricing for CorvusPT: free AI review, Owner-Managed, or CorvusPT-Managed protest service.",
      },
      { property: "og:title", content: "CorvusPT Pricing" },
      {
        property: "og:description",
        content: "Free AI review. Then $99–$799/mo per property, priced by property value.",
      },
    ],
  }),
  component: Page,
});

const PAID_PLANS: {
  tier: Tier;
  name: string;
  tag: string;
  features: string[];
  highlight: boolean;
}[] = [
  {
    tier: "owner_managed",
    name: "Owner-Managed",
    tag: "Most popular",
    features: [
      "All 10 premium AI modules unlocked, per property",
      "AI Executive Protest Report",
      "AI Evidence Builder packet",
      "You file and represent yourself, AI-assisted",
    ],
    highlight: true,
  },
  {
    tier: "corvusrf_managed",
    name: "CorvusPT-Managed",
    tag: "White glove",
    features: [
      "Everything in Owner-Managed",
      "CorvusPT staff files your protest",
      "County communication + hearing representation",
      "Settlement approval workflow",
    ],
    highlight: false,
  },
];

// "ai_report" (flat-rate, self-file) and "managed_protest" (contingency, staff-filed)
// are the legacy tiers this pricing overhaul replaced — kept here only to decide
// whether "Manage Billing" should show at all for a grandfathered account.
const SUBSCRIBED_PLANS: PlanValue[] = [
  "owner_managed",
  "corvusrf_managed",
  "ai_report",
  "managed_protest",
];

function Page() {
  const { user } = useAuth();
  const [openingPortal, setOpeningPortal] = useState(false);
  const [currentPlan, setCurrentPlan] = useState<PlanValue | null>(null);

  useEffect(() => {
    if (!user) {
      setCurrentPlan(null);
      return;
    }
    getMyBilling(user.id)
      .then((b) => setCurrentPlan(b.plan))
      .catch(() => setCurrentPlan(null));
  }, [user]);

  // Beta access has no Stripe subscription behind it at all (granted at
  // signup — see handle_new_user() in supabase/schema.sql).
  const isBeta = currentPlan === "beta";
  const alreadySubscribed = !!currentPlan && SUBSCRIBED_PLANS.includes(currentPlan);

  async function handleManageBilling() {
    setOpeningPortal(true);
    try {
      await openBillingPortal();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not open billing portal. Please try again.",
      );
      setOpeningPortal(false);
    }
  }

  return (
    <div>
      <div className="container-page pt-16">
        <div className="max-w-3xl">
          <span className="badge-soft">Pricing</span>
          <h1 className="mt-3 text-4xl md:text-5xl font-semibold">
            Pricing that scales with property value.
          </h1>
          <p className="mt-4 text-lg text-muted-foreground">
            Start free. Pick Owner-Managed to do it yourself with AI, or CorvusPT-Managed to have
            our staff file and represent you. Each property gets its own subscription, priced by
            that property's value, billed monthly — subscribe right from a property's own page once
            you've added it.
          </p>
        </div>
      </div>

      {/* One table with every price side by side. Always visible, regardless
          of sign-in/subscription state, since it's a plain reference: every
          number here reads straight off TIER_BRACKET_PRICES/VALUE_BRACKETS/
          ADDITIONAL_PROPERTY_DISCOUNT/CUSTOM_TIER — the exact same single
          source of truth create-checkout-session actually charges, so this
          can never drift out of sync with what a subscriber is charged. */}
      <div className="container-page">
        <ScrollReveal className="card-elev overflow-hidden">
          <div className="p-6 pb-4">
            <h2 className="font-serif text-xl font-semibold">Pricing at a glance</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Every price for both plans, by property value.
            </p>
          </div>
          {/* min-w keeps every column at a readable width instead of the table
              shrinking to fit a narrow viewport and clipping the header text (confirmed
              live at 390px: without it, "Additional property, same bracket" squeezed down
              to unreadable fragments instead of the wrapper actually scrolling) — wide
              content should scroll inside its own container, never squeeze. */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-t border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="whitespace-nowrap py-3 pl-6 pr-4 font-medium">
                    Property value range
                  </th>
                  <th className="whitespace-nowrap py-3 pr-4 font-medium">Owner-Managed</th>
                  <th className="whitespace-nowrap py-3 pr-4 font-medium">CorvusPT-Managed</th>
                  <th className="whitespace-nowrap py-3 pr-6 font-medium">
                    Price per additional property, same bracket
                  </th>
                </tr>
              </thead>
              <tbody>
                {VALUE_BRACKETS.map((b) => (
                  <tr key={b.value} className="border-t border-border">
                    <td className="py-3 pl-6 pr-4 font-medium">{b.label}</td>
                    <td className="py-3 pr-4">
                      ${TIER_BRACKET_PRICES.owner_managed[b.value]}
                      <span className="text-muted-foreground">/mo</span>
                    </td>
                    <td className="py-3 pr-4">
                      ${TIER_BRACKET_PRICES.corvusrf_managed[b.value]}
                      <span className="text-muted-foreground">/mo</span>
                    </td>
                    <td className="py-3 pr-6 text-muted-foreground">
                      {Math.round(ADDITIONAL_PROPERTY_DISCOUNT * 100)}% off base price
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-border">
                  <td className="py-3 pl-6 pr-4 font-medium">{CUSTOM_TIER.label}</td>
                  <td className="py-3 pr-4 text-muted-foreground">Custom</td>
                  <td className="py-3 pr-4 text-muted-foreground">Custom</td>
                  <td className="py-3 pr-6 text-muted-foreground">—</td>
                </tr>
              </tbody>
            </table>
          </div>
        </ScrollReveal>
      </div>

      <div className="container-page pb-16">
        {isBeta ? (
          <div className="mt-8 max-w-xl rounded-lg border border-accent/40 bg-accent/10 p-6">
            <div className="text-3xl font-semibold">$0</div>
            <h2 className="mt-1 font-serif text-xl font-semibold">You have full Beta access 🎉</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Thanks for testing CorvusPT with us — every AI module is unlocked on every property,
              free, for as long as you're in the beta. No card, no subscription to manage.
            </p>
          </div>
        ) : (
          <>
            {alreadySubscribed && (
              <div className="mt-6 max-w-3xl rounded-lg border border-border bg-secondary/40 p-4 text-sm">
                <p>Each of your properties has its own real subscription.</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link to="/dashboard/properties" className="btn-outline">
                    View My Properties
                  </Link>
                  <button
                    onClick={handleManageBilling}
                    disabled={openingPortal}
                    className="btn-outline disabled:opacity-60"
                  >
                    {openingPortal ? "Redirecting…" : "Manage Billing"}
                  </button>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Manage Billing opens Stripe's portal, where every property's subscription is
                  listed separately — cancel, update payment method, or view invoices for any one of
                  them individually.
                </p>
              </div>
            )}

            {!alreadySubscribed && (
              <div className="mt-8 text-sm text-muted-foreground">
                Just want the free AI review first?{" "}
                <Link to="/" className="font-medium text-accent underline underline-offset-2">
                  Start a free review
                </Link>{" "}
                — no card required, one property.
              </div>
            )}

            {/* Informational only — subscribing to a specific property
            happens on that property's own card on /dashboard/properties,
            where its real value bracket is already known and priced
            automatically. Both tiers shown side by side, plus a Custom card
            for $25M+, so a visitor can compare every price without
            switching tabs. */}
            <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-3">
              {PAID_PLANS.map((p, i) => {
                const isWhiteGlove = p.tier === "corvusrf_managed";
                return (
                  <ScrollReveal
                    key={p.tier}
                    delay={i * 120}
                    className={`card-elev relative overflow-hidden p-6 flex flex-col h-full transition-all hover:-translate-y-0.5 hover:shadow-elev ${p.highlight ? "ring-2 ring-accent" : isWhiteGlove ? "ring-2 ring-warning/60" : ""}`}
                  >
                    {/* A real focal band on the recommended tier, not just a
                    thin ring — "more colorful/bolder" feedback called out
                    this exact spot as the one place a visitor picks between
                    plans. */}
                    {p.highlight && (
                      <span className="brand-gradient absolute inset-x-0 top-0 h-1.5" />
                    )}
                    <div
                      className={
                        isWhiteGlove ? "badge-soft-warning self-start" : "badge-soft self-start"
                      }
                    >
                      {p.tag}
                    </div>
                    <h3 className="mt-3 font-serif text-2xl">{p.name}</h3>
                    <div className="mt-2 flex items-baseline gap-1">
                      <span className="text-4xl font-semibold">
                        ${TIER_BRACKET_PRICES[p.tier].under2m}–$
                        {TIER_BRACKET_PRICES[p.tier].over10m}
                      </span>
                      <span className="text-muted-foreground text-sm">/mo, per property</span>
                    </div>
                    <ul className="mt-4 space-y-2 text-sm">
                      {p.features.map((f) => (
                        <li key={f} className="flex gap-2">
                          <span
                            className={`mt-1.5 h-1.5 w-1.5 rounded-full ${isWhiteGlove ? "bg-warning" : "bg-accent"}`}
                          />
                          {f}
                        </li>
                      ))}
                    </ul>
                    <div className="mt-6 flex-1" />
                    <Link
                      to="/dashboard/properties"
                      className={`w-full text-center ${p.highlight ? "btn-accent" : "btn-primary btn-primary-hover"}`}
                    >
                      Add a Property to Subscribe
                    </Link>
                  </ScrollReveal>
                );
              })}

              <ScrollReveal
                delay={PAID_PLANS.length * 120}
                className="card-elev p-6 flex flex-col h-full"
              >
                <div className="badge-soft self-start">{CUSTOM_TIER.tag}</div>
                <h3 className="mt-3 font-serif text-2xl">{CUSTOM_TIER.label}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{CUSTOM_TIER.blurb}</p>
                <div className="mt-6 flex-1" />
                <Link to="/contact" className="w-full btn-outline text-center">
                  Contact Us
                </Link>
              </ScrollReveal>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
