import { useEffect, useState } from "react";
import { getStripeMode, type StripeMode } from "@/lib/app-settings";

// A quiet "you're not making real payments" marker, shown next to billing UI
// while Stripe is in test mode (app_settings.stripe_mode). Renders nothing in
// live mode — that's the normal state, and the admin Settings tab already
// flags it there.
export function PaymentsModeChip() {
  const [mode, setMode] = useState<StripeMode | null>(null);
  useEffect(() => {
    getStripeMode()
      .then(setMode)
      .catch(() => {});
  }, []);
  if (mode !== "test") return null;
  return (
    <span
      className="badge-soft-warning"
      title="Stripe is in test mode — use a test card (4242 4242 4242 4242). Nothing is charged."
    >
      Test mode — no real charges
    </span>
  );
}
