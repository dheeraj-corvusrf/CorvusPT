import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { getStripeMode } from "./app-settings";

// Publishable keys — safe in the client bundle (see .env.example). Both are
// shipped so the admin test/live toggle (app_settings.stripe_mode) can switch
// which one is used at runtime, with no rebuild. VITE_STRIPE_PUBLISHABLE_KEY
// (no suffix) is still read as the test fallback for envs not yet updated.
const TEST_KEY = (import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY_TEST ??
  import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY) as string | undefined;
const LIVE_KEY = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY_LIVE as string | undefined;

export const stripeConfigured = !!(TEST_KEY || LIVE_KEY);

let promise: Promise<Stripe | null> | null = null;

// Lazy singleton — loadStripe injects a <script>, so only call this when the
// bulk-subscribe modal actually opens. Resolves the current mode first, then
// loads with the matching publishable key.
export function getStripe(): Promise<Stripe | null> {
  if (!promise) {
    promise = getStripeMode().then((mode) => {
      const key = mode === "live" ? LIVE_KEY : TEST_KEY;
      if (!key) return null;
      return loadStripe(key);
    });
  }
  return promise;
}
