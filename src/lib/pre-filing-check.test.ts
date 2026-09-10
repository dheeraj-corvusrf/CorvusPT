import { describe, it, expect } from "vitest";
import { getPreFilingCheck, isPreFilingBlocked } from "./pre-filing-check";
import type { PropertyRecord } from "./properties";
import type { ProtestRecord } from "./protests";

// Derived from "now" so the fixture is always internally consistent against
// the deadline-passed / deadline-wrong-year inconsistency checks, whatever
// date the suite runs on.
const NOW_YEAR = new Date().getFullYear();
const FUTURE_DEADLINE = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);

const property: PropertyRecord = {
  id: "prop-1",
  address: "123 Main St, Plano, TX 75023",
  cad: "Collin Central Appraisal District",
  accountNumber: "12345",
  ownerName: "Test Owner LLC",
  propertyType: "Commercial",
  landValue: 100000,
  improvementValue: 400000,
  totalValue: 500000,
  taxYear: NOW_YEAR,
  protestDeadline: FUTURE_DEADLINE,
  paymentDueDate: null,
  taxAmountDue: null,
  paidAt: null,
  estimatedSavings: null,
  savingsBasis: null,
  createdAt: "2026-01-01T00:00:00Z",
  valueHistory: null,
};

const protest: ProtestRecord = {
  id: "protest-1",
  propertyId: "prop-1",
  status: "requested",
  notes: null,
  requestedAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  originalValue: 500000,
  settlementOfferValue: null,
  settlementOfferReceivedAt: null,
  hearingDate: null,
  hearingTime: null,
  hearingLocation: null,
  hearingMode: null,
  informalStatus: "not_requested",
  informalReviewDate: null,
  informalAppraiserCategory: null,
  attendanceType: null,
  arbDecision: null,
  arbDecisionDate: null,
  finalValue: null,
  escalationPath: null,
  closedAt: null,
  taxYear: NOW_YEAR,
  corvusGuidanceAckAt: "2026-01-01T00:00:00Z",
};

describe("getPreFilingCheck", () => {
  it("returns all 17 items the product spec requires, each with a label", () => {
    const items = getPreFilingCheck(property, protest);
    expect(items).toHaveLength(17);
    for (const item of items) {
      expect(item.label.length).toBeGreaterThan(0);
    }
  });

  it("surfaces the county-data freshness (verified date + source)", () => {
    const row = getPreFilingCheck(property, protest).find(
      (i) => i.label === "County Requirements Verified",
    );
    expect(row?.value).toMatch(/^As of \d{4}-\d{2}-\d{2} · https?:\/\//);
    expect(row?.blocking).toBe(false);
  });

  it("flags a passed protest deadline as needs_review and blocks filing", () => {
    const past = { ...property, protestDeadline: "2020-05-15" };
    const items = getPreFilingCheck(past, protest);
    const row = items.find((i) => i.label === "Protest Deadline");
    expect(row?.status).toBe("needs_review");
    expect(row?.issue).toMatch(/already passed/i);
    expect(isPreFilingBlocked(items)).toBe(true);
  });

  it("flags a deadline whose year doesn't line up with the tax year", () => {
    const off = { ...property, protestDeadline: `${NOW_YEAR + 5}-05-15` };
    const items = getPreFilingCheck(off, protest);
    const row = items.find((i) => i.label === "Protest Deadline");
    expect(row?.status).toBe("needs_review");
    expect(isPreFilingBlocked(items)).toBe(true);
  });

  it("flags a tax-year mismatch between the protest and the property record", () => {
    const items = getPreFilingCheck(property, { ...protest, taxYear: NOW_YEAR - 1 });
    const row = items.find((i) => i.label === "Tax Year");
    expect(row?.status).toBe("needs_review");
    expect(row?.issue).toContain(String(NOW_YEAR - 1));
    expect(isPreFilingBlocked(items)).toBe(true);
  });

  it("flags a blank CAD classification but does NOT block on it", () => {
    const noClass = { ...property, propertyType: null };
    const items = getPreFilingCheck(noClass, protest);
    const row = items.find((i) => i.label === "Property Type");
    expect(row?.status).toBe("needs_review");
    expect(isPreFilingBlocked(items)).toBe(false);
  });

  it("is not blocked when every blocking field is real", () => {
    const items = getPreFilingCheck(property, protest);
    expect(isPreFilingBlocked(items)).toBe(false);
  });

  it("blocks when a critical identity field is genuinely missing", () => {
    const missingOwner = { ...property, ownerName: null };
    const items = getPreFilingCheck(missingOwner, protest);
    expect(isPreFilingBlocked(items)).toBe(true);
    const ownerRow = items.find((i) => i.label === "Owner / Entity");
    expect(ownerRow?.status).toBe("missing");
  });

  it("blocks when the protest deadline is missing", () => {
    const noDeadline = { ...property, protestDeadline: null };
    const items = getPreFilingCheck(noDeadline, protest);
    expect(isPreFilingBlocked(items)).toBe(true);
  });

  it("never blocks on a non-blocking procedural row, even when unconfirmed for the county", () => {
    // A property whose county has no county-protest-info.ts entry at all —
    // every procedural row should degrade to an honest "Not confirmed" /
    // generic-default value, never "missing"/blocking.
    const unresearchedCounty = { ...property, cad: "Some Uncovered County CAD" };
    const items = getPreFilingCheck(unresearchedCounty, protest);
    expect(isPreFilingBlocked(items)).toBe(false);
    for (const label of [
      "Filing Method",
      "Online Filing Available",
      "Email Filing Available",
      "Mail / In-Person Filing",
      "County Contact Information",
      "Applicable County Instructions",
    ]) {
      const row = items.find((i) => i.label === label);
      expect(row?.blocking).toBe(false);
      expect(row?.status).toBe("confirmed"); // always has a real fallback string
    }
  });

  it("reflects the real uploaded-evidence-document count in Required Supporting Documents", () => {
    expect(
      getPreFilingCheck(property, protest, 3).find(
        (i) => i.label === "Required Supporting Documents",
      )?.value,
    ).toBe("3 documents uploaded");
    expect(
      getPreFilingCheck(property, protest, 1).find(
        (i) => i.label === "Required Supporting Documents",
      )?.value,
    ).toBe("1 document uploaded");
    expect(
      getPreFilingCheck(property, protest, 0).find(
        (i) => i.label === "Required Supporting Documents",
      )?.value,
    ).toBe("None uploaded yet");
    expect(
      getPreFilingCheck(property, protest).find((i) => i.label === "Required Supporting Documents")
        ?.value,
    ).toBe("Not on file");
  });

  it("uses the real per-county filing method and portal for a county with data", () => {
    const items = getPreFilingCheck(property, protest);
    const row = items.find((i) => i.label === "Filing Method");
    expect(row?.value).toContain("onlineportal.collincad.org");
  });

  it("reports the county's real, confirmed Email Filing Available answer", () => {
    const dallasProperty = { ...property, cad: "Dallas Central Appraisal District" };
    const graysonProperty = { ...property, cad: "Grayson Central Appraisal District" };
    expect(
      getPreFilingCheck(dallasProperty, protest).find((i) => i.label === "Email Filing Available")
        ?.value,
    ).toBe("No");
    expect(
      getPreFilingCheck(graysonProperty, protest).find((i) => i.label === "Email Filing Available")
        ?.value,
    ).toBe("Yes");
  });
});

describe("isPreFilingBlocked", () => {
  it("is true when a blocking item is missing OR needs_review", () => {
    expect(
      isPreFilingBlocked([{ label: "x", value: "y", status: "confirmed", blocking: true }]),
    ).toBe(false);
    expect(
      isPreFilingBlocked([{ label: "x", value: null, status: "missing", blocking: false }]),
    ).toBe(false);
    expect(
      isPreFilingBlocked([{ label: "x", value: null, status: "missing", blocking: true }]),
    ).toBe(true);
    expect(
      isPreFilingBlocked([
        { label: "x", value: "y", status: "needs_review", issue: "z", blocking: true },
      ]),
    ).toBe(true);
    expect(
      isPreFilingBlocked([
        { label: "x", value: "y", status: "needs_review", issue: "z", blocking: false },
      ]),
    ).toBe(false);
  });
});
