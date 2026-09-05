// @vitest-environment jsdom
// buildReferralLink reads window.location.origin, which doesn't exist under
// the default node environment set in vitest.config.ts.
import { describe, it, expect, vi } from "vitest";
import { mockQueryBuilder } from "./test-utils/supabase-query-mock";

const mockFrom = vi.fn();
const mockRpc = vi.fn();
const mockInvoke = vi.fn();

vi.mock("./supabase", () => ({
  supabase: {
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));
vi.mock("./edge-functions", () => ({
  invokeEdgeFunction: (...args: unknown[]) => mockInvoke(...args),
}));

// Imported after the mocks above so referrals.ts picks up the mocked module.
const { getMyReferralCode, getMyReferrals, buildReferralLink, sendReferralInvite } =
  await import("./referrals");

describe("buildReferralLink", () => {
  it("builds a real sign-up URL carrying the code as a clean path, not a query string", () => {
    const link = buildReferralLink("ABCD1234");
    expect(link).toBe(`${window.location.origin}${import.meta.env.BASE_URL}join/ABCD1234`);
    expect(link).not.toContain("?");
  });

  it("URL-encodes the code", () => {
    const link = buildReferralLink("has space");
    expect(link).toContain("join/has%20space");
  });
});

describe("getMyReferralCode", () => {
  it("returns the real code from the profile row", async () => {
    mockFrom.mockReturnValue(
      mockQueryBuilder({ data: { referral_code: "ABCD1234" }, error: null }),
    );
    const code = await getMyReferralCode("user-1");
    expect(mockFrom).toHaveBeenCalledWith("profiles");
    expect(code).toBe("ABCD1234");
  });

  it("returns null when the row is missing", async () => {
    mockFrom.mockReturnValue(mockQueryBuilder({ data: null, error: null }));
    const code = await getMyReferralCode("user-1");
    expect(code).toBeNull();
  });

  it("throws on a real Supabase error", async () => {
    mockFrom.mockReturnValue(mockQueryBuilder({ data: null, error: new Error("boom") }));
    await expect(getMyReferralCode("user-1")).rejects.toThrow("boom");
  });
});

describe("getMyReferrals", () => {
  it("maps the RPC's snake_case rows to ReferralRecord", async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          id: "u2",
          first_name: "Jamie",
          signed_up_at: "2026-01-01T00:00:00Z",
          converted: true,
          rewarded: true,
        },
        {
          id: "u3",
          first_name: null,
          signed_up_at: "2026-02-01T00:00:00Z",
          converted: false,
          rewarded: false,
        },
      ],
      error: null,
    });

    const result = await getMyReferrals();

    expect(mockRpc).toHaveBeenCalledWith("get_my_referrals");
    expect(result).toEqual([
      {
        id: "u2",
        firstName: "Jamie",
        signedUpAt: "2026-01-01T00:00:00Z",
        converted: true,
        rewarded: true,
      },
      {
        id: "u3",
        firstName: null,
        signedUpAt: "2026-02-01T00:00:00Z",
        converted: false,
        rewarded: false,
      },
    ]);
  });

  it("throws on a real Supabase error", async () => {
    mockRpc.mockResolvedValue({ data: null, error: new Error("nope") });
    await expect(getMyReferrals()).rejects.toThrow("nope");
  });
});

describe("sendReferralInvite", () => {
  it("invokes send-referral-invite with the target email and the real origin+base prefix", async () => {
    mockInvoke.mockResolvedValue({ ok: true });
    await sendReferralInvite("friend@example.com");
    expect(mockInvoke).toHaveBeenCalledWith("send-referral-invite", {
      toEmail: "friend@example.com",
      origin: `${window.location.origin}${import.meta.env.BASE_URL}`,
    });
  });

  it("throws when the edge function call fails", async () => {
    mockInvoke.mockRejectedValue(new Error("send failed"));
    await expect(sendReferralInvite("friend@example.com")).rejects.toThrow("send failed");
  });
});
