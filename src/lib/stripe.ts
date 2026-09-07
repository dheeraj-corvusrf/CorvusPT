import { loadStripe, type Stripe } from "@stripe/stripe-js";

// Publishable key — safe in the client bundle (see .env.example). Only the
// bulk-subscribe inline card form needs Stripe.js; the single-property flow
// still uses hosted Checkout (a redirect, no Stripe.js).
const KEY = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined;

let promise: Promise<Stripe | null> | null = null;

// Lazy singleton — loadStripe injects a <script>, so only call this when the
// bulk-subscribe modal actually opens, and reuse the same promise after that.
export function getStripe(): Promise<Stripe | null> {
  if (!KEY) return Promise.resolve(null);
  if (!promise) promise = loadStripe(KEY);
  return promise;
}

export const stripeConfigured = !!KEY;
