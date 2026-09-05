import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { ScrollReveal } from "@/components/ScrollReveal";
import {
  startCheckout,
  openBillingPortal,
  resumeSubscription,
  getMyBilling,
  bracketMonthlyTotal,
  bracketPropertyCount,
  formatMoney,
  EMPTY_BRACKETS,
  VALUE_BRACKETS,
  TIER_BRACKET_PRICES,
  CUSTOM_TIER,
  ADDITIONAL_PROPERTY_DISCOUNT,
  type PlanValue,
  type Tier,
  type BracketQuantities,
  type PropertyValueBracket,
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

// Session-only (not persisted across browser restarts) — holds a pending
// checkout selection across the sign-in detour when a signed-out visitor
// clicks Subscribe. See handleSubscribe/the resume effect below.
const PENDING_SUBSCRIBE_KEY = "crf_pending_subscribe";

const SUBSCRIBED_PLANS: PlanValue[] = [
  "owner_managed",
  "corvusrf_managed",
  "ai_report",
  "managed_protest",
];

// "ai_report" (flat-rate, self-file) and "managed_protest" (contingency, staff-filed)
// are the legacy tiers this pricing overhaul replaced — mapped to their closest
// current equivalent so a pre-existing subscriber's card still highlights correctly
// instead of matching neither of the two current tiers.
const CURRENT_TIER: Partial<Record<PlanValue, Tier>> = {
  owner_managed: "owner_managed",
  ai_report: "owner_managed",
  corvusrf_managed: "corvusrf_managed",
  managed_protest: "corvusrf_managed",
};

function Page() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [checkingOutTier, setCheckingOutTier] = useState<Tier | null>(null);
  const [openingPortal, setOpeningPortal] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [currentPlan, setCurrentPlan] = useState<PlanValue | null>(null);
  const [subscriptionStatus, setSubscriptionStatus] = useState<string | null>(null);
  const [subscriptionBrackets, setSubscriptionBrackets] =
    useState<BracketQuantities>(EMPTY_BRACKETS);
  const [cancelAtPeriodEnd, setCancelAtPeriodEnd] = useState(false);
  const [cancelAt, setCancelAt] = useState<string | null>(null);
  // Separate quantities per tier, not one shared set — a property you'd put
  // on Owner-Managed isn't necessarily the same one you'd put on
  // CorvusPT-Managed, so each card gets its own 3 bracket inputs (6 boxes
  // total) rather than both cards pricing the same shared property list.
  const [ownerBrackets, setOwnerBrackets] = useState<BracketQuantities>(EMPTY_BRACKETS);
  const [managedBrackets, setManagedBrackets] = useState<BracketQuantities>(EMPTY_BRACKETS);

  useEffect(() => {
    // Stripe Checkout/Portal are separate origins, so hitting the browser Back button
    // after starting one commonly restores this page from the back-forward cache
    // instead of reloading it — freezing the button mid-"Redirecting…" forever. The
    // pageshow event's persisted flag is exactly how you detect a bfcache restore.
    function onPageShow(e: PageTransitionEvent) {
      if (e.persisted) {
        setCheckingOutTier(null);
        setOpeningPortal(false);
      }
    }
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  useEffect(() => {
    if (!user) {
      setCurrentPlan(null);
      setSubscriptionStatus(null);
      setCancelAtPeriodEnd(false);
      setCancelAt(null);
      return;
    }
    getMyBilling(user.id)
      .then((b) => {
        setCurrentPlan(b.plan);
        setSubscriptionStatus(b.subscriptionStatus);
        setSubscriptionBrackets(b.subscriptionBrackets);
        setCancelAtPeriodEnd(b.cancelAtPeriodEnd);
        setCancelAt(b.cancelAt);
      })
      .catch(() => {
        setCurrentPlan(null);
        setSubscriptionStatus(null);
        setCancelAtPeriodEnd(false);
        setCancelAt(null);
      });
  }, [user]);

  const alreadySubscribed = !!currentPlan && SUBSCRIBED_PLANS.includes(currentPlan);
  // Beta access has no Stripe subscription behind it (granted at signup — see
  // handle_new_user() in supabase/schema.sql), so it's neither "subscribed"
  // (nothing to manage/switch via the billing portal) nor the normal picker flow.
  const isBeta = currentPlan === "beta";
  const currentTier = currentPlan ? CURRENT_TIER[currentPlan] : undefined;
  const hasPaymentProblem = subscriptionStatus === "past_due" || subscriptionStatus === "unpaid";
  const subscribedCount = bracketPropertyCount(subscriptionBrackets);

  function bracketsFor(tier: Tier): BracketQuantities {
    return tier === "owner_managed" ? ownerBrackets : managedBrackets;
  }
  function setBracketQty(tier: Tier, bracket: PropertyValueBracket, value: number) {
    const setter = tier === "owner_managed" ? setOwnerBrackets : setManagedBrackets;
    setter((prev) => ({ ...prev, [bracket]: Math.max(0, value) }));
  }

  async function startSubscribeCheckout(tier: Tier, brackets: BracketQuantities) {
    setCheckingOutTier(tier);
    try {
      await startCheckout(tier, brackets);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not start checkout. Please try again.",
      );
      setCheckingOutTier(null);
    }
  }

  async function handleSubscribe(tier: Tier) {
    if (!user) {
      // Sign-in used to always land back on "/", losing the property
      // selection the visitor had just set up — save it here and restore +
      // auto-continue to checkout once they're back (see the effect below),
      // instead of dropping them on the homepage empty-handed.
      sessionStorage.setItem(
        PENDING_SUBSCRIBE_KEY,
        JSON.stringify({ tier, brackets: bracketsFor(tier) }),
      );
      navigate({ to: "/sign-in", search: { redirect: "/pricing" } });
      return;
    }
    await startSubscribeCheckout(tier, bracketsFor(tier));
  }

  // Runs once right after a signed-out "Subscribe" click round-trips through
  // sign-in and lands back here with a real user.
  useEffect(() => {
    if (!user) return;
    const raw = sessionStorage.getItem(PENDING_SUBSCRIBE_KEY);
    if (!raw) return;
    sessionStorage.removeItem(PENDING_SUBSCRIBE_KEY);
    try {
      const pending = JSON.parse(raw) as { tier: Tier; brackets: BracketQuantities };
      if (pending.tier === "owner_managed") setOwnerBrackets(pending.brackets);
      else setManagedBrackets(pending.brackets);
      startSubscribeCheckout(pending.tier, pending.brackets);
    } catch {
      // Malformed/stale sessionStorage entry — nothing to resume.
    }
  }, [user]);

  async function handleManageSubscription() {
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

  async function handleResume() {
    setResuming(true);
    try {
      await resumeSubscription();
      setCancelAtPeriodEnd(false);
      setCancelAt(null);
      toast.success("Your subscription will continue — it's no longer set to cancel.");
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : "Could not resume your subscription. Please try again.",
      );
    } finally {
      setResuming(false);
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
            our staff file and represent you. Priced per property, by property value, billed
            monthly.
          </p>
        </div>
      </div>

      {/* One table with every price side by side — Own and Corvus were previously
          only comparable by scanning between the two separate picker cards further
          down (or, before that overhaul, by switching tabs). Always visible,
          regardless of sign-in/subscription state, since it's a plain reference:
          every number here reads straight off TIER_BRACKET_PRICES/VALUE_BRACKETS/
          ADDITIONAL_PROPERTY_DISCOUNT/CUSTOM_TIER — the exact same single source of
          truth the interactive cards below and the real Stripe checkout both use —
          so this can never drift out of sync with what a subscriber is actually
          charged the way the $699/$799 mismatch did. */}
      <div className="container-page">
        <ScrollReveal className="card-elev overflow-hidden">
          <div className="p-6 pb-4">
            <h2 className="font-serif text-xl font-semibold">Pricing at a glance</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Every price for both plans, by property value — compare them here before picking one
              below.
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
                    Price per additional property
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
            {hasPaymentProblem && (
              <div className="mt-6 max-w-3xl rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
                There's a problem with your last payment — update your billing details to keep your
                subscription active.
              </div>
            )}
            {cancelAtPeriodEnd && (
              <div className="mt-6 max-w-3xl rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
                Your subscription is set to cancel
                {cancelAt
                  ? ` on ${new Date(cancelAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}`
                  : " at the end of your current billing period"}
                . You'll keep full access until then — click Resubscribe below if you'd like to keep
                it going.
              </div>
            )}
            {alreadySubscribed && (
              <div className="mt-6 max-w-3xl rounded-lg border border-border bg-secondary/40 p-4 text-sm">
                <p>
                  You're subscribed for {subscribedCount} propert
                  {subscribedCount === 1 ? "y" : "ies"}.
                </p>
                <ul className="mt-1 text-muted-foreground">
                  {VALUE_BRACKETS.filter((b) => subscriptionBrackets[b.value] > 0).map((b) => (
                    <li key={b.value}>
                      {subscriptionBrackets[b.value]} × {b.label}
                    </li>
                  ))}
                </ul>
                <p className="mt-2">Manage your plan, brackets, or payment method below.</p>
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

            {/* Both tiers shown side by side, plus a Custom card for $25M+ —
            so a visitor can compare every price without switching tabs. */}
            <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-3">
              {PAID_PLANS.map((p, i) => {
                const isWhiteGlove = p.tier === "corvusrf_managed";
                const tierBrackets = bracketsFor(p.tier);
                const monthlyTotal = bracketMonthlyTotal(p.tier, tierBrackets);
                const propertyCount = bracketPropertyCount(tierBrackets);
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
                    {alreadySubscribed ? (
                      <div className="mt-3 grid grid-cols-3 gap-2">
                        {VALUE_BRACKETS.map((b) => (
                          <div
                            key={b.value}
                            className="rounded-lg border border-border bg-secondary/40 px-2 py-2 text-center"
                          >
                            <div className="text-[10px] text-muted-foreground">{b.label}</div>
                            <div className="text-sm font-semibold">
                              ${TIER_BRACKET_PRICES[p.tier][b.value]}/mo
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      // Editable per-bracket quantities live right on this card —
                      // previously these were a separate row of 6 boxes above,
                      // duplicating the tier name/price on every box and leaving
                      // two different "Subscribe" buttons for the same tier. One
                      // card per tier, one button, is the whole flow now.
                      <div className="mt-4 space-y-2">
                        {VALUE_BRACKETS.map((b) => {
                          const qty = tierBrackets[b.value];
                          return (
                            <div
                              key={b.value}
                              className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
                            >
                              <div>
                                <div className="text-sm font-semibold">
                                  ${TIER_BRACKET_PRICES[p.tier][b.value]}/mo
                                </div>
                                <div className="text-xs text-muted-foreground">{b.label}</div>
                              </div>
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() =>
                                    setBracketQty(p.tier, b.value, Math.max(0, qty - 1))
                                  }
                                  disabled={qty === 0}
                                  aria-label={`Decrease ${p.name} ${b.label} quantity`}
                                  className="h-8 w-8 rounded-md border border-input text-base font-medium leading-none disabled:opacity-40"
                                >
                                  −
                                </button>
                                <span
                                  className="w-5 text-center text-sm font-semibold"
                                  aria-live="polite"
                                >
                                  {qty}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => setBracketQty(p.tier, b.value, qty + 1)}
                                  aria-label={`Increase ${p.name} ${b.label} quantity`}
                                  className="h-8 w-8 rounded-md border border-input text-base font-medium leading-none"
                                >
                                  +
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
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
                    <div className="mt-6 grid gap-2">
                      {currentTier === p.tier ? (
                        cancelAtPeriodEnd ? (
                          // Scheduled to cancel — two distinct actions rather than one button,
                          // since "keep it" and "manage billing details" are different intents.
                          <>
                            <button
                              onClick={handleResume}
                              disabled={resuming}
                              className="w-full btn-accent disabled:opacity-60"
                            >
                              {resuming ? "Resuming…" : "Resubscribe"}
                            </button>
                            <button
                              onClick={handleManageSubscription}
                              disabled={openingPortal}
                              className="w-full btn-outline disabled:opacity-60"
                            >
                              {openingPortal ? "Redirecting…" : "Manage Subscription"}
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={handleManageSubscription}
                            disabled={openingPortal}
                            className="w-full btn-outline disabled:opacity-60"
                          >
                            {openingPortal ? "Redirecting…" : "Manage Subscription"}
                          </button>
                        )
                      ) : alreadySubscribed ? (
                        // Subscribed, but to the *other* tier — switching plans is a change to
                        // the existing subscription, not a brand new checkout, so this also
                        // opens the billing portal rather than starting a second subscription.
                        <button
                          onClick={handleManageSubscription}
                          disabled={openingPortal}
                          className="w-full btn-outline disabled:opacity-60"
                        >
                          {openingPortal ? "Redirecting…" : `Switch to ${p.name}`}
                        </button>
                      ) : (
                        <button
                          onClick={() => handleSubscribe(p.tier)}
                          disabled={checkingOutTier !== null || propertyCount === 0}
                          className={`w-full ${p.highlight ? "btn-accent" : "btn-primary btn-primary-hover"} disabled:opacity-60`}
                        >
                          {checkingOutTier === p.tier
                            ? "Redirecting to checkout…"
                            : propertyCount === 0
                              ? "Add at least one property above"
                              : `Subscribe — $${formatMoney(monthlyTotal)}/mo`}
                        </button>
                      )}
                    </div>
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
