import { useEffect, useMemo, useState } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { getStripe } from "@/lib/stripe";
import {
  bulkSubscribe,
  bulkSubscribeSetup,
  bracketForValue,
  propertyMonthlyPrice,
  formatMoney,
  TIER_BRACKET_PRICES,
  type BulkSubResult,
  type Tier,
} from "@/lib/billing";
import type { PropertyRecord } from "@/lib/properties";
import { getErrorMessage } from "@/lib/error-message";

const TIER_LABEL: Record<Tier, string> = {
  owner_managed: "Owner-Managed",
  corvusrf_managed: "CorvusPT-Managed",
};

// Batch-aware price estimate: within each tier+bracket group the first
// property is full price, the rest take the 15% additional-property discount.
// Doesn't know about the customer's ALREADY-active properties in a bracket
// (the server does and may discount more), so it's labeled an estimate.
function estimateLines(properties: PropertyRecord[], tier: Tier) {
  const seenInBracket: Record<string, number> = {};
  return properties.map((p) => {
    const bracket = bracketForValue(p.totalValue);
    const n = seenInBracket[bracket] ?? 0;
    seenInBracket[bracket] = n + 1;
    return { property: p, price: propertyMonthlyPrice(tier, bracket, n > 0) };
  });
}

export function BulkSubscribeModal({
  properties,
  open,
  onOpenChange,
  onDone,
}: {
  properties: PropertyRecord[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (results: BulkSubResult[]) => void;
}) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const stripePromise = useMemo(() => getStripe(), []);

  useEffect(() => {
    if (!open) {
      setClientSecret(null);
      setSetupError(null);
      return;
    }
    let cancelled = false;
    bulkSubscribeSetup()
      .then(({ clientSecret }) => {
        if (!cancelled) setClientSecret(clientSecret);
      })
      .catch((err) => {
        if (!cancelled) setSetupError(getErrorMessage(err, "Could not start checkout."));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Subscribe to {properties.length} propert{properties.length === 1 ? "y" : "ies"}
          </DialogTitle>
          <DialogDescription>
            One card, one subscription per property. Each can still be canceled on its own later.
          </DialogDescription>
        </DialogHeader>

        {setupError ? (
          <p className="text-destructive text-sm">{setupError}</p>
        ) : !clientSecret ? (
          <p className="text-muted-foreground py-6 text-sm">Preparing secure checkout…</p>
        ) : (
          <Elements stripe={stripePromise} options={{ clientSecret }}>
            <BulkForm properties={properties} onDone={onDone} onOpenChange={onOpenChange} />
          </Elements>
        )}
      </DialogContent>
    </Dialog>
  );
}

function BulkForm({
  properties,
  onDone,
  onOpenChange,
}: {
  properties: PropertyRecord[];
  onDone: (results: BulkSubResult[]) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [tier, setTier] = useState<Tier>("owner_managed");
  const [submitting, setSubmitting] = useState(false);

  const lines = useMemo(() => estimateLines(properties, tier), [properties, tier]);
  const estTotal = lines.reduce((sum, l) => sum + l.price, 0);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements || submitting) return;
    setSubmitting(true);
    try {
      const { error, setupIntent } = await stripe.confirmSetup({
        elements,
        redirect: "if_required",
      });
      if (error) {
        toast.error(error.message ?? "Could not save your card.");
        return;
      }
      const pm = setupIntent?.payment_method;
      const paymentMethodId = typeof pm === "string" ? pm : (pm?.id ?? null);
      if (!paymentMethodId || setupIntent?.status !== "succeeded") {
        toast.error("Card wasn't confirmed. Please try again.");
        return;
      }
      const { results } = await bulkSubscribe(
        properties.map((p) => ({ propertyId: p.id, tier })),
        paymentMethodId,
      );
      onDone(results);
      onOpenChange(false);
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not complete the subscriptions."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-4">
      <div className="grid gap-2">
        <span className="text-xs font-medium">Plan for all selected properties</span>
        <div className="grid gap-2 sm:grid-cols-2">
          {(["owner_managed", "corvusrf_managed"] as const).map((t) => (
            <label
              key={t}
              htmlFor={`bulk-tier-${t}`}
              className={`flex cursor-pointer flex-col gap-0.5 rounded-lg border p-3 text-sm ${
                tier === t ? "border-accent bg-accent/5" : "border-border"
              }`}
            >
              <span className="flex items-center gap-2 font-medium">
                <input
                  id={`bulk-tier-${t}`}
                  type="radio"
                  name="bulk-tier"
                  checked={tier === t}
                  onChange={() => setTier(t)}
                />
                {TIER_LABEL[t]}
              </span>
              <span className="text-muted-foreground pl-6 text-xs">
                from ${formatMoney(TIER_BRACKET_PRICES[t].under2m)}/mo per property, by value
              </span>
            </label>
          ))}
        </div>
      </div>

      <ul className="border-border grid gap-1 rounded-lg border p-3 text-sm">
        {lines.map(({ property, price }) => (
          <li key={property.id} className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate">{property.address}</span>
            <span className="text-muted-foreground shrink-0">${formatMoney(price)}/mo</span>
          </li>
        ))}
        <li className="border-border mt-1 flex items-center justify-between gap-3 border-t pt-2 font-medium">
          <span>Estimated total</span>
          <span>${formatMoney(estTotal)}/mo</span>
        </li>
      </ul>
      <p className="text-muted-foreground -mt-2 text-[11px]">
        Estimate — your first invoice reflects the exact amount, including any additional-property
        discount for properties already in the same tier.
      </p>

      <div className="grid gap-1.5">
        <span className="text-xs font-medium">Card</span>
        <PaymentElement options={{ layout: "tabs" }} />
      </div>

      <button
        type="submit"
        disabled={!stripe || submitting}
        className="btn-accent w-full text-sm disabled:opacity-60"
      >
        {submitting
          ? "Subscribing…"
          : `Subscribe to ${properties.length} propert${properties.length === 1 ? "y" : "ies"} · ~$${formatMoney(estTotal)}/mo`}
      </button>
    </form>
  );
}
