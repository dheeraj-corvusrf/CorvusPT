// @vitest-environment jsdom
// startPropertyCheckout/openBillingPortal write to window.location, which
// doesn't exist under the default node environment set in vitest.config.ts.
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
  startPropertyCheckout,
  openBillingPortal,
  cancelPropertySubscription,
  resumePropertySubscription,
  bracketForValue,
  propertyMonthlyPrice,
} = await import("./billing");

describe("getMyBilling", () => {
  it("reads the real plan column off profiles", async () => {
    mockFrom.mockReturnValue(mockQueryBuilder({ data: { plan: "owner_managed" }, error: null }));

    const result = await getMyBilling("user-1");

    expect(mockFrom).toHaveBeenCalledWith("profiles");
    expect(result).toEqual({ plan: "owner_managed" });
  });

  it("throws when Supabase returns an error", async () => {
    mockFrom.mockReturnValue(mockQueryBuilder({ data: null, error: new Error("row not found") }));
    await expect(getMyBilling("user-1")).rejects.toThrow("row not found");
  });
});

describe("startPropertyCheckout", () => {
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

  it("calls create-checkout-session with the property/tier/base-path-aware redirect paths and redirects to the returned URL", async () => {
    mockInvoke.mockResolvedValue({ url: "https://checkout.stripe.com/session/abc" });

    await startPropertyCheckout("prop-1", "owner_managed");

    expect(mockInvoke).toHaveBeenCalledWith("create-checkout-session", {
      propertyId: "prop-1",
      tier: "owner_managed",
      successPath: `${import.meta.env.BASE_URL}dashboard/properties?checkout=success`,
      cancelPath: `${import.meta.env.BASE_URL}dashboard/properties`,
    });
    expect(window.location.href).toBe("https://checkout.stripe.com/session/abc");
  });

  it("throws instead of redirecting when Stripe returns no URL", async () => {
    mockInvoke.mockResolvedValue({ url: "" });
    await expect(startPropertyCheckout("prop-1", "corvusrf_managed")).rejects.toThrow(
      /did not return a checkout URL/,
    );
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

describe("cancelPropertySubscription", () => {
  it("calls cancel-property-subscription with the property id", async () => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue({ ok: true });
    await cancelPropertySubscription("prop-1");
    expect(mockInvoke).toHaveBeenCalledWith("cancel-property-subscription", {
      propertyId: "prop-1",
    });
  });
});

describe("resumePropertySubscription", () => {
  it("calls resume-subscription with the property id", async () => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue({ ok: true });
    await resumePropertySubscription("prop-1");
    expect(mockInvoke).toHaveBeenCalledWith("resume-subscription", { propertyId: "prop-1" });
  });
});

describe("bracketForValue", () => {
  it("classifies by the real $2M/$10M boundaries", () => {
    expect(bracketForValue(1_500_000)).toBe("under2m");
    expect(bracketForValue(2_000_000)).toBe("mid2m10m");
    expect(bracketForValue(9_999_999)).toBe("mid2m10m");
    expect(bracketForValue(10_000_000)).toBe("over10m");
    expect(bracketForValue(50_000_000)).toBe("over10m");
  });

  it("defaults to the cheapest bracket for a missing value, never a guess upward", () => {
    expect(bracketForValue(null)).toBe("under2m");
    expect(bracketForValue(undefined)).toBe("under2m");
  });
});

describe("propertyMonthlyPrice", () => {
  it("charges full price for a customer's first property in a bracket", () => {
    expect(propertyMonthlyPrice("owner_managed", "under2m", false)).toBe(99);
  });

  it("discounts 15% for an additional property in the same bracket", () => {
    // 799 * 0.85 = 679.15
    expect(propertyMonthlyPrice("corvusrf_managed", "over10m", true)).toBeCloseTo(679.15, 5);
  });
});
