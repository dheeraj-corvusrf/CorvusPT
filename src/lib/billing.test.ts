// @vitest-environment jsdom
// startCheckout/openBillingPortal write to window.location, which doesn't
// exist under the default node environment set in vitest.config.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockQueryBuilder } from "./test-utils/supabase-query-mock";

const mockFrom = vi.fn();
const mockInvoke = vi.fn();

vi.mock("./supabase", () => ({ supabase: { from: (...args: unknown[]) => mockFrom(...args) } }));
vi.mock("./edge-functions", () => ({
  invokeEdgeFunction: (...args: unknown[]) => mockInvoke(...args),
}));

// Imported after the mocks above so billing.ts picks up the mocked modules.
const {
  getMyBilling,
  startCheckout,
  openBillingPortal,
  resumeSubscription,
  removePropertyFromPlan,
  bracketLineTotal,
  bracketMonthlyTotal,
  getEntitledPropertyIds,
  planUsesPerPropertyEntitlement,
} = await import("./billing");

describe("getMyBilling", () => {
  it("maps snake_case profile columns to BillingInfo", async () => {
    mockFrom.mockReturnValue(
      mockQueryBuilder({
        data: {
          plan: "owner_managed",
          subscription_status: "active",
          subscription_quantity: 3,
          qty_under_2m: 2,
          qty_2m_10m: 1,
          qty_over_10m: 0,
          cancel_at_period_end: false,
          cancel_at: null,
        },
        error: null,
      }),
    );

    const result = await getMyBilling("user-1");

    expect(mockFrom).toHaveBeenCalledWith("profiles");
    expect(result).toEqual({
      plan: "owner_managed",
      subscriptionStatus: "active",
      subscriptionQuantity: 3,
      subscriptionBrackets: { under2m: 2, mid2m10m: 1, over10m: 0 },
      cancelAtPeriodEnd: false,
      cancelAt: null,
    });
  });

  it("throws when Supabase returns an error", async () => {
    mockFrom.mockReturnValue(mockQueryBuilder({ data: null, error: new Error("row not found") }));
    await expect(getMyBilling("user-1")).rejects.toThrow("row not found");
  });
});

describe("startCheckout", () => {
  const originalLocation = window.location;

  beforeEach(() => {
    mockInvoke.mockReset();
    // jsdom's window.location isn't directly assignable; delete + redefine.
    // @ts-expect-error -- test-only override
    delete window.location;
    // @ts-expect-error -- test-only override
    window.location = { href: "" };
  });

  afterEach(() => {
    // @ts-expect-error -- test-only override
    window.location = originalLocation;
  });

  it("calls create-checkout-session with the tier/brackets/base-path-aware redirect paths and redirects to the returned URL", async () => {
    mockInvoke.mockResolvedValue({ url: "https://checkout.stripe.com/session/abc" });

    await startCheckout("owner_managed", { under2m: 2, mid2m10m: 0, over10m: 0 });

    expect(mockInvoke).toHaveBeenCalledWith("create-checkout-session", {
      tier: "owner_managed",
      brackets: { under2m: 2, mid2m10m: 0, over10m: 0 },
      successPath: `${import.meta.env.BASE_URL}dashboard?checkout=success`,
      cancelPath: `${import.meta.env.BASE_URL}pricing`,
    });
    expect(window.location.href).toBe("https://checkout.stripe.com/session/abc");
  });

  it("throws instead of redirecting when Stripe returns no URL", async () => {
    mockInvoke.mockResolvedValue({ url: "" });
    await expect(
      startCheckout("corvusrf_managed", { under2m: 1, mid2m10m: 0, over10m: 0 }),
    ).rejects.toThrow(/did not return a checkout URL/);
    expect(window.location.href).toBe("");
  });
});

describe("openBillingPortal", () => {
  it("calls create-billing-portal-session and redirects to the returned URL", async () => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue({ url: "https://billing.stripe.com/portal/abc" });
    // @ts-expect-error -- test-only override
    delete window.location;
    // @ts-expect-error -- test-only override
    window.location = { href: "" };

    await openBillingPortal();

    expect(mockInvoke).toHaveBeenCalledWith("create-billing-portal-session", {
      returnPath: `${import.meta.env.BASE_URL}dashboard`,
    });
    expect(window.location.href).toBe("https://billing.stripe.com/portal/abc");
  });
});

describe("resumeSubscription", () => {
  it("calls resume-subscription with no body", async () => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue({ ok: true });
    await resumeSubscription();
    expect(mockInvoke).toHaveBeenCalledWith("resume-subscription", {});
  });
});

describe("removePropertyFromPlan", () => {
  it("calls remove-property-from-plan with the property id and returns the real remaining count", async () => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue({ ok: true, remainingPaidCount: 2 });
    const remaining = await removePropertyFromPlan("prop-1");
    expect(mockInvoke).toHaveBeenCalledWith("remove-property-from-plan", { propertyId: "prop-1" });
    expect(remaining).toBe(2);
  });
});

describe("bracketLineTotal", () => {
  it("returns 0 for zero quantity", () => {
    expect(bracketLineTotal(499, 0)).toBe(0);
  });

  it("charges full price for a single property", () => {
    expect(bracketLineTotal(499, 1)).toBe(499);
  });

  it("discounts every property after the first by 15%", () => {
    // 1 full-price + 2 at 85% = 499 + 2 * 424.15
    expect(bracketLineTotal(499, 3)).toBeCloseTo(499 + 2 * 424.15, 5);
  });
});

describe("bracketMonthlyTotal", () => {
  it("sums the discounted total across brackets", () => {
    const total = bracketMonthlyTotal("owner_managed", { under2m: 2, mid2m10m: 0, over10m: 0 });
    // 1 full-price ($99) + 1 at 85% ($84.15)
    expect(total).toBeCloseTo(99 + 84.15, 5);
  });
});

describe("getEntitledPropertyIds", () => {
  const properties = [
    { id: "c", createdAt: "2024-03-01T00:00:00Z" },
    { id: "a", createdAt: "2024-01-01T00:00:00Z" },
    { id: "b", createdAt: "2024-02-01T00:00:00Z" },
  ];

  it("returns nothing for a zero or negative paid count", () => {
    expect(getEntitledPropertyIds(properties, 0)).toEqual(new Set());
    expect(getEntitledPropertyIds(properties, -1)).toEqual(new Set());
  });

  it("picks the oldest N properties by createdAt, regardless of input order", () => {
    expect(getEntitledPropertyIds(properties, 1)).toEqual(new Set(["a"]));
    expect(getEntitledPropertyIds(properties, 2)).toEqual(new Set(["a", "b"]));
  });

  it("covers every property once the paid count meets or exceeds the total", () => {
    expect(getEntitledPropertyIds(properties, 3)).toEqual(new Set(["a", "b", "c"]));
    expect(getEntitledPropertyIds(properties, 10)).toEqual(new Set(["a", "b", "c"]));
  });
});

describe("planUsesPerPropertyEntitlement", () => {
  it("is true only for the two real bracket-priced tiers", () => {
    expect(planUsesPerPropertyEntitlement("owner_managed")).toBe(true);
    expect(planUsesPerPropertyEntitlement("corvusrf_managed")).toBe(true);
  });

  it("is false for beta and the legacy pre-bracket plans", () => {
    expect(planUsesPerPropertyEntitlement("beta")).toBe(false);
    expect(planUsesPerPropertyEntitlement("ai_report")).toBe(false);
    expect(planUsesPerPropertyEntitlement("managed_protest")).toBe(false);
    expect(planUsesPerPropertyEntitlement("free_ai_review")).toBe(false);
  });
});
