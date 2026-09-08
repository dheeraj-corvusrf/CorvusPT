import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockQueryBuilder } from "./test-utils/supabase-query-mock";

const mockFrom = vi.fn();
const mockSubmitWeb3Form = vi.fn();

vi.mock("./supabase", () => ({ supabase: { from: (...args: unknown[]) => mockFrom(...args) } }));
vi.mock("./web3forms", () => ({
  submitWeb3Form: (...args: unknown[]) => mockSubmitWeb3Form(...args),
}));

const { requestProtest, listProtests } = await import("./protests");

const ROW = {
  id: "pr1",
  property_id: "prop1",
  status: "requested",
  notes: null,
  requested_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  original_value: 400000,
  settlement_offer_value: null,
  settlement_offer_received_at: null,
  hearing_date: null,
  arb_decision: null,
  arb_decision_date: null,
  final_value: null,
  escalation_path: null,
  closed_at: null,
};

describe("requestProtest", () => {
  beforeEach(() => {
    mockFrom.mockReset();
    mockSubmitWeb3Form.mockReset();
  });

  it("inserts into the protests table and maps the returned row", async () => {
    mockFrom.mockReturnValue(mockQueryBuilder({ data: ROW, error: null }));
    mockSubmitWeb3Form.mockResolvedValue(undefined);

    const result = await requestProtest("user1", "prop1", {
      address: "123 Main St",
      userEmail: "owner@example.com",
      originalValue: 400000,
    });

    expect(mockFrom).toHaveBeenCalledWith("protests");
    expect(result).toEqual({
      id: "pr1",
      propertyId: "prop1",
      status: "requested",
      notes: null,
      requestedAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      originalValue: 400000,
      settlementOfferValue: null,
      settlementOfferReceivedAt: null,
      hearingDate: null,
      arbDecision: null,
      arbDecisionDate: null,
      finalValue: null,
      escalationPath: null,
      closedAt: null,
    });
  });

  it("still resolves with the created record even when the staff notification fails", async () => {
    mockFrom.mockReturnValue(mockQueryBuilder({ data: ROW, error: null }));
    mockSubmitWeb3Form.mockRejectedValue(new Error("Web3Forms is down"));

    await expect(requestProtest("user1", "prop1")).resolves.toEqual(
      expect.objectContaining({ id: "pr1", status: "requested" }),
    );
  });

  it("throws when the insert fails, and does not notify staff", async () => {
    mockFrom.mockReturnValue(mockQueryBuilder({ data: null, error: new Error("insert failed") }));

    await expect(requestProtest("user1", "prop1")).rejects.toThrow("insert failed");
    expect(mockSubmitWeb3Form).not.toHaveBeenCalled();
  });
});

describe("listProtests", () => {
  it("queries by user_id and maps every row", async () => {
    mockFrom.mockReset();
    mockFrom.mockReturnValue(mockQueryBuilder({ data: [ROW], error: null }));

    const result = await listProtests("user1");

    expect(mockFrom).toHaveBeenCalledWith("protests");
    expect(result).toHaveLength(1);
    expect(result[0].propertyId).toBe("prop1");
  });

  it("throws when the query fails", async () => {
    mockFrom.mockReset();
    mockFrom.mockReturnValue(mockQueryBuilder({ data: null, error: new Error("query failed") }));
    await expect(listProtests("user1")).rejects.toThrow("query failed");
  });
});
