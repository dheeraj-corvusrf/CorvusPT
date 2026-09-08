import { invokeEdgeFunction } from "./edge-functions";

// The real financial picture for the admin dashboard — MRR, active
// subscriptions, gross collected (last ~12 months) and a monthly series, a
// plan mix, plus headline counts from our own DB. All aggregated server-side
// in admin-financials (admin-gated, reads Stripe with the live key).
export type AdminFinancials = {
  mode: "test" | "live";
  currency: string;
  mrrCents: number;
  activeSubscriptions: number;
  subscriptionCustomers: number;
  subscriptionsByStatus: Record<string, number>;
  planMix: { label: string; count: number; mrrCents: number }[];
  collectedRecentCents: number;
  refundedRecentCents: number;
  collectedByMonth: { month: string; amountCents: number }[];
  signups: number;
  propertiesByStatus: Record<string, number>;
};

export async function getAdminFinancials(): Promise<AdminFinancials> {
  return invokeEdgeFunction<AdminFinancials>("admin-financials", {});
}

export function dollars(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}
