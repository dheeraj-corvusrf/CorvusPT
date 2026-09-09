import { listProperties, type PropertyRecord } from "./properties";
import { listProtests, type ProtestRecord } from "./protests";
import { listTaxBills, type TaxBillRecord } from "./tax-bills";
import { listBppAccounts, type BppAccountRecord } from "./bpp-accounts";
import { listReminders, type Reminder } from "./reminders";

export type CalendarEventType =
  | "protest_deadline"
  | "informal_review"
  | "hearing"
  | "arb_decision"
  | "tax_due"
  | "tax_penalty"
  | "refund_expected"
  | "bpp_rendition"
  | "refile_reminder"
  | "reminder";

export type CalendarEvent = {
  id: string;
  date: string; // ISO date (YYYY-MM-DD)
  type: CalendarEventType;
  title: string;
  amount: number | null;
  propertyId: string | null;
  linkTo: string;
  /** True once the event is behind us in a way that no longer needs action (paid, closed, past). */
  resolved: boolean;
  // The property address (or BPP business name) alone, no event-type prefix
  // — same value title's already built from, kept separate so the
  // month-grid can show it directly under each event without parsing it
  // back out of title's "Event type — X" string.
  propertyLabel: string;
};

export const EVENT_TYPE_LABEL: Record<CalendarEventType, string> = {
  protest_deadline: "Protest Deadline",
  informal_review: "Informal Review",
  hearing: "ARB Hearing",
  arb_decision: "ARB Decision",
  tax_due: "Tax Bill Due",
  tax_penalty: "Tax Penalty Date",
  refund_expected: "Refund Expected",
  bpp_rendition: "BPP Rendition Deadline",
  refile_reminder: "Re-File Reminder",
  reminder: "Reminder",
};

// Tailwind color tokens keyed by event type, used for the month-grid dots.
export const EVENT_TYPE_COLOR: Record<CalendarEventType, string> = {
  protest_deadline: "bg-destructive",
  informal_review: "bg-sky-500",
  hearing: "bg-accent",
  arb_decision: "bg-primary",
  tax_due: "bg-amber-500",
  tax_penalty: "bg-destructive",
  refund_expected: "bg-success",
  bpp_rendition: "bg-violet-500",
  refile_reminder: "bg-rose-400",
  reminder: "bg-fuchsia-500",
};

// Texas's BPP rendition deadline is a fixed statutory date (April 15) rather than
// something tracked per-account in the DB — computed here instead of stored.
function nextBppRenditionDeadline(from: Date): string {
  const year = from.getFullYear();
  const thisYearDeadline = new Date(Date.UTC(year, 3, 15));
  const deadline =
    from <= thisYearDeadline ? thisYearDeadline : new Date(Date.UTC(year + 1, 3, 15));
  return deadline.toISOString().slice(0, 10);
}

function toIsoDate(value: string): string {
  return value.length >= 10 ? value.slice(0, 10) : value;
}

function fromProperty(p: PropertyRecord, taxBillPropertyIds: Set<string>): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  if (p.protestDeadline) {
    events.push({
      id: `protest-deadline:${p.id}`,
      date: toIsoDate(p.protestDeadline),
      type: "protest_deadline",
      title: `Protest deadline — ${p.address}`,
      amount: null,
      propertyId: p.id,
      linkTo: "/dashboard/properties",
      resolved: new Date(p.protestDeadline) < new Date(),
      propertyLabel: p.address,
    });
  }
  // Only used as a fallback for properties that don't have a real tax_bills row yet —
  // once a bill exists there, that richer record supersedes this denormalized snapshot
  // (see updatePropertyBillSnapshot in src/lib/tax-bills.ts).
  if (p.paymentDueDate && !taxBillPropertyIds.has(p.id)) {
    events.push({
      id: `tax-due:property:${p.id}`,
      date: toIsoDate(p.paymentDueDate),
      type: "tax_due",
      title: `Tax bill due — ${p.address}`,
      amount: p.taxAmountDue,
      propertyId: p.id,
      linkTo: "/dashboard/tax-bills",
      resolved: !!p.paidAt,
      propertyLabel: p.address,
    });
  }
  return events;
}

// Real time/location extracted from an actual uploaded hearing notice (see
// extract-hearing-notice), when there is one — every event on this calendar
// is otherwise all-day/date-only (see toIsoDate), so this is the one place
// a real time-of-day surfaces, folded into the title text rather than a
// structural change to CalendarEvent itself. Same shared helper used by
// this file's own client-side builder and its two server-side mirrors
// (_shared/google-calendar-sync.ts, calendar-feed's ICS builder) — kept in
// sync by hand since Deno edge functions can't import this browser module.
export function hearingEventTitle(
  address: string,
  time: string | null | undefined,
  location: string | null | undefined,
): string {
  const parts = [`ARB hearing — ${address}`];
  if (time) parts.push(`at ${time}`);
  if (location) parts.push(`(${location})`);
  return parts.join(" ");
}

function fromProtest(
  pr: ProtestRecord,
  properties: PropertyRecord[],
  propertiesWithCurrentProtest: Set<string>,
): CalendarEvent[] {
  const property = properties.find((p) => p.id === pr.propertyId);
  const address = property?.address ?? "your property";
  const events: CalendarEvent[] = [];
  // Real, self-reported date once the county and owner have actually
  // agreed on one — see InformalReviewSection in CaseDetailModal.tsx and
  // scheduleInformalReview() in protest-case.ts. Independent of the formal
  // hearing event below — a case can have both scheduled at once.
  if (pr.informalStatus === "scheduled" && pr.informalReviewDate) {
    events.push({
      id: `informal-review:${pr.id}`,
      date: toIsoDate(pr.informalReviewDate),
      type: "informal_review",
      title: `Informal review — ${address}`,
      amount: null,
      propertyId: pr.propertyId,
      linkTo: "/dashboard/properties",
      resolved: new Date(pr.informalReviewDate) < new Date(),
      propertyLabel: address,
    });
  }
  if (pr.status === "hearing_scheduled" && pr.hearingDate) {
    events.push({
      id: `hearing:${pr.id}`,
      date: toIsoDate(pr.hearingDate),
      type: "hearing",
      title: hearingEventTitle(address, pr.hearingTime, pr.hearingLocation),
      amount: null,
      propertyId: pr.propertyId,
      linkTo: "/dashboard/properties",
      resolved: new Date(pr.hearingDate) < new Date(),
      propertyLabel: address,
    });
  }
  if (pr.arbDecisionDate) {
    events.push({
      id: `arb-decision:${pr.id}`,
      date: toIsoDate(pr.arbDecisionDate),
      type: "arb_decision",
      title: `ARB decision — ${address}`,
      amount: null,
      propertyId: pr.propertyId,
      linkTo: "/dashboard/properties",
      resolved: true,
      propertyLabel: address,
    });
  }
  // A resolved case from a prior tax year is eligible to re-file once a new
  // tax year has rolled around — same real condition
  // dashboard/_layout.properties.tsx's own canReFile already uses. This
  // surfaces that as an actual dated reminder instead of only a button the
  // user has to remember to go find on their own — deliberately NOT an
  // automatically-created new case (product direction was explicitly
  // "opt-in reminder only," not auto-renewal), just a real nudge pointing
  // back at the real Re-file button. April 1 mirrors
  // nextBppRenditionDeadline()'s own real-statutory-season convention
  // (Texas appraisal notices are typically mailed in April) rather than an
  // arbitrary date; if that's already passed this year the reminder still
  // shows (marked "Past due" by the calendar page's own daysUntil badge,
  // same as any other date-only event), since real time remains before the
  // real May 15 protest deadline. Suppressed once a newer protest already
  // exists for this property (propertiesWithCurrentProtest, computed once
  // in getCalendarEvents) — otherwise this would keep reminding forever
  // even after the user actually re-filed, since this OLD row's own taxYear
  // never changes.
  const currentYear = new Date().getFullYear();
  if (
    pr.status === "resolved" &&
    pr.taxYear != null &&
    pr.taxYear < currentYear &&
    !propertiesWithCurrentProtest.has(pr.propertyId)
  ) {
    events.push({
      id: `refile-reminder:${pr.id}:${currentYear}`,
      date: `${currentYear}-04-01`,
      type: "refile_reminder",
      title: `Check for this year's notice — re-file for ${currentYear}? — ${address}`,
      amount: null,
      propertyId: pr.propertyId,
      linkTo: "/dashboard/properties",
      resolved: false,
      propertyLabel: address,
    });
  }
  return events;
}

function fromTaxBill(bill: TaxBillRecord, properties: PropertyRecord[]): CalendarEvent[] {
  const property = properties.find((p) => p.id === bill.propertyId);
  const address = property?.address ?? "your property";
  const yearLabel = bill.taxYear ? ` (${bill.taxYear})` : "";
  const events: CalendarEvent[] = [];
  if (bill.dueDate) {
    events.push({
      id: `tax-due:bill:${bill.id}`,
      date: toIsoDate(bill.dueDate),
      type: "tax_due",
      title: `Tax bill due${yearLabel} — ${address}`,
      amount: bill.amountDue,
      propertyId: bill.propertyId,
      linkTo: "/dashboard/tax-bills",
      resolved: !!bill.paidAt,
      propertyLabel: address,
    });
  }
  if (bill.penaltyDate) {
    events.push({
      id: `tax-penalty:${bill.id}`,
      date: toIsoDate(bill.penaltyDate),
      type: "tax_penalty",
      title: `Penalty date${yearLabel} — ${address}`,
      amount: null,
      propertyId: bill.propertyId,
      linkTo: "/dashboard/tax-bills",
      resolved: !!bill.paidAt || new Date(bill.penaltyDate) < new Date(),
      propertyLabel: address,
    });
  }
  if (bill.refundExpectedAt) {
    events.push({
      id: `refund:${bill.id}`,
      date: toIsoDate(bill.refundExpectedAt),
      type: "refund_expected",
      title: `Refund expected${yearLabel} — ${address}`,
      amount: bill.refundAmount,
      propertyId: bill.propertyId,
      linkTo: "/dashboard/tax-bills",
      resolved: !!bill.refundReceivedAt,
      propertyLabel: address,
    });
  }
  return events;
}

function fromBppAccount(account: BppAccountRecord, now: Date): CalendarEvent {
  const date = nextBppRenditionDeadline(now);
  return {
    id: `bpp-rendition:${account.id}:${date}`,
    date,
    type: "bpp_rendition",
    title: `BPP rendition deadline — ${account.businessName}`,
    amount: null,
    propertyId: null,
    linkTo: "/dashboard/bpp-accounts",
    resolved: false,
    propertyLabel: account.businessName,
  };
}

function fromReminder(r: Reminder, properties: PropertyRecord[]): CalendarEvent {
  const property = r.propertyId ? properties.find((p) => p.id === r.propertyId) : undefined;
  const propertyLabel = property?.address ?? "Personal reminder";
  return {
    id: `reminder-${r.id}`,
    date: r.remindOn.slice(0, 10),
    type: "reminder",
    title: `Reminder — ${r.note}`,
    amount: null,
    propertyId: r.propertyId,
    linkTo: property ? `/dashboard/case?propertyId=${property.id}` : "/dashboard/calendar",
    resolved: r.done || r.remindOn.slice(0, 10) < new Date().toISOString().slice(0, 10),
    propertyLabel,
  };
}

export async function getCalendarEvents(userId: string): Promise<CalendarEvent[]> {
  const [properties, protests, taxBills, bppAccounts, reminders] = await Promise.all([
    listProperties(userId),
    listProtests(userId),
    listTaxBills(userId),
    listBppAccounts(userId),
    listReminders(userId),
  ]);

  const taxBillPropertyIds = new Set(taxBills.map((b) => b.propertyId));
  const now = new Date();
  const currentYear = now.getFullYear();
  // Which properties already have a protest for the current (or a future)
  // tax year — computed once here, not per-protest, so the refile_reminder
  // check in fromProtest can suppress itself once the user has actually
  // re-filed rather than reminding forever off a stale, already-resolved row.
  const propertiesWithCurrentProtest = new Set(
    protests.filter((p) => p.taxYear != null && p.taxYear >= currentYear).map((p) => p.propertyId),
  );

  const events: CalendarEvent[] = [
    ...properties.flatMap((p) => fromProperty(p, taxBillPropertyIds)),
    ...protests.flatMap((pr) => fromProtest(pr, properties, propertiesWithCurrentProtest)),
    ...taxBills.flatMap((b) => fromTaxBill(b, properties)),
    ...bppAccounts.map((a) => fromBppAccount(a, now)),
    ...reminders.map((r) => fromReminder(r, properties)),
  ];

  return events.sort((a, b) => a.date.localeCompare(b.date));
}

// Google's "quick add" calendar link — no auth, no API key, just a prefilled form.
export function googleCalendarAddUrl(event: CalendarEvent): string {
  const compact = event.date.replace(/-/g, "");
  // All-day event: end date is exclusive, so use the following day.
  const end = new Date(event.date + "T00:00:00Z");
  end.setUTCDate(end.getUTCDate() + 1);
  const endCompact = end.toISOString().slice(0, 10).replace(/-/g, "");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.title,
    dates: `${compact}/${endCompact}`,
    details: `${EVENT_TYPE_LABEL[event.type]}${event.amount != null ? ` — $${event.amount.toLocaleString()}` : ""} — via CorvusPT.ai`,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
