// Deploy via CLI: `supabase functions deploy calendar-feed --no-verify-jwt`
// (--no-verify-jwt because Google/Outlook/Apple Calendar fetch this on their
// own schedule with no Supabase session at all — the token in the URL IS the
// auth, checked against profiles.calendar_feed_token below).
//
// This is a self-contained Deno-side reimplementation of
// src/lib/tax-calendar.ts's getCalendarEvents() + src/lib/ics.ts's
// buildIcsCalendar() — those two files import the browser supabase-js
// client (src/lib/supabase.ts), which isn't usable from an Edge Function
// (wrong client, wrong auth model). Keep this in sync by hand with those two
// files if the event set/logic ever changes there.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type EventRow = {
  id: string;
  date: string;
  type: string;
  title: string;
  amount: number | null;
};

type PropertyRow = {
  id: string;
  address: string;
  protest_deadline: string | null;
  payment_due_date: string | null;
  tax_amount_due: number | null;
  paid_at: string | null;
};

function toIsoDate(value: string): string {
  return value.length >= 10 ? value.slice(0, 10) : value;
}

const EVENT_TYPE_LABEL: Record<string, string> = {
  protest_deadline: "Protest Deadline",
  informal_review: "Informal Review",
  hearing: "ARB Hearing",
  arb_decision: "ARB Decision",
  tax_due: "Tax Bill Due",
  tax_penalty: "Tax Penalty Date",
  refund_expected: "Refund Expected",
  bpp_rendition: "BPP Rendition Deadline",
  refile_reminder: "Re-File Reminder",
};

function nextBppRenditionDeadline(from: Date): string {
  const year = from.getUTCFullYear();
  const thisYearDeadline = new Date(Date.UTC(year, 3, 15));
  const deadline =
    from <= thisYearDeadline ? thisYearDeadline : new Date(Date.UTC(year + 1, 3, 15));
  return deadline.toISOString().slice(0, 10);
}

function escapeIcsText(text: string): string {
  return text.replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
}

function dateStamp(iso: string): string {
  return iso.replace(/-/g, "");
}

function buildIcsEvent(event: EventRow): string {
  const start = dateStamp(event.date);
  const end = new Date(event.date + "T00:00:00Z");
  end.setUTCDate(end.getUTCDate() + 1);
  const endStamp = dateStamp(end.toISOString().slice(0, 10));
  const details = `${EVENT_TYPE_LABEL[event.type] ?? event.type}${
    event.amount != null ? ` — $${event.amount.toLocaleString()}` : ""
  } — via CorvusPT.ai`;
  return [
    "BEGIN:VEVENT",
    `UID:corvusrf-${event.id}@corvusre.com`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").split(".")[0]}Z`,
    `DTSTART;VALUE=DATE:${start}`,
    `DTEND;VALUE=DATE:${endStamp}`,
    `SUMMARY:${escapeIcsText(event.title)}`,
    `DESCRIPTION:${escapeIcsText(details)}`,
    "END:VEVENT",
  ].join("\r\n");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return new Response("Missing token.", { status: 400, headers: corsHeaders });
  }

  const adminClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: profile } = await adminClient
    .from("profiles")
    .select("id")
    .eq("calendar_feed_token", token)
    .maybeSingle();
  if (!profile) {
    return new Response("Unknown or revoked calendar link.", {
      status: 404,
      headers: corsHeaders,
    });
  }
  const userId = profile.id as string;

  const [{ data: properties }, { data: protests }, { data: taxBills }, { data: bppAccounts }] =
    await Promise.all([
      adminClient
        .from("properties")
        .select("id, address, protest_deadline, payment_due_date, tax_amount_due, paid_at")
        .eq("user_id", userId),
      adminClient
        .from("protests")
        .select(
          "id, property_id, status, hearing_date, hearing_time, hearing_location, arb_decision_date, informal_status, informal_review_date, informal_review_time, tax_year",
        )
        .eq("user_id", userId),
      adminClient
        .from("tax_bills")
        .select(
          "id, property_id, tax_year, amount_due, due_date, penalty_date, paid_at, refund_amount, refund_expected_at, refund_received_at",
        )
        .eq("user_id", userId),
      adminClient.from("bpp_accounts").select("id, business_name").eq("user_id", userId),
    ]);

  const propertyById = new Map((properties ?? []).map((p: PropertyRow) => [p.id, p] as const));
  const taxBillPropertyIds = new Set(
    (taxBills ?? []).map((b: { property_id: string }) => b.property_id),
  );
  // Mirrors getCalendarEvents()'s own propertiesWithCurrentProtest set in
  // src/lib/tax-calendar.ts by hand — suppresses the refile_reminder below
  // once a property already has a protest on file for the current tax year.
  const currentYear = new Date().getFullYear();
  const propertiesWithCurrentProtest = new Set(
    (protests ?? [])
      .filter(
        (p: { tax_year: number | null }) =>
          typeof p.tax_year === "number" && p.tax_year >= currentYear,
      )
      .map((p: { property_id: string }) => p.property_id),
  );
  const events: EventRow[] = [];

  for (const p of properties ?? []) {
    if (p.protest_deadline) {
      events.push({
        id: `protest-deadline:${p.id}`,
        date: toIsoDate(p.protest_deadline),
        type: "protest_deadline",
        title: `Protest deadline — ${p.address}`,
        amount: null,
      });
    }
    if (p.payment_due_date && !taxBillPropertyIds.has(p.id)) {
      events.push({
        id: `tax-due:property:${p.id}`,
        date: toIsoDate(p.payment_due_date),
        type: "tax_due",
        title: `Tax bill due — ${p.address}`,
        amount: p.tax_amount_due,
      });
    }
  }

  for (const pr of protests ?? []) {
    const address = propertyById.get(pr.property_id)?.address ?? "your property";
    // Mirrors the informal_review branch in src/lib/tax-calendar.ts's
    // fromProtest() (and _shared/google-calendar-sync.ts) by hand — this
    // feed omitted it entirely before. Real time-of-day folded into the
    // title the same way the hearing block below does.
    if (pr.informal_status === "scheduled" && pr.informal_review_date) {
      const informalParts = [`Informal review — ${address}`];
      if (pr.informal_review_time) informalParts.push(`at ${pr.informal_review_time}`);
      events.push({
        id: `informal-review:${pr.id}`,
        date: toIsoDate(pr.informal_review_date),
        type: "informal_review",
        title: informalParts.join(" "),
        amount: null,
      });
    }
    if (pr.status === "hearing_scheduled" && pr.hearing_date) {
      // Real time/location from an actual uploaded hearing notice, when
      // there is one (see extract-hearing-notice) — mirrors
      // hearingEventTitle() in src/lib/tax-calendar.ts by hand, since this
      // Deno function can't import that browser module.
      const titleParts = [`ARB hearing — ${address}`];
      if (pr.hearing_time) titleParts.push(`at ${pr.hearing_time}`);
      if (pr.hearing_location) titleParts.push(`(${pr.hearing_location})`);
      events.push({
        id: `hearing:${pr.id}`,
        date: toIsoDate(pr.hearing_date),
        type: "hearing",
        title: titleParts.join(" "),
        amount: null,
      });
    }
    if (pr.arb_decision_date) {
      events.push({
        id: `arb-decision:${pr.id}`,
        date: toIsoDate(pr.arb_decision_date),
        type: "arb_decision",
        title: `ARB decision — ${address}`,
        amount: null,
      });
    }
    // Mirrors the refile_reminder block in src/lib/tax-calendar.ts's
    // fromProtest() by hand — a one-time-per-year, opt-in-only nudge to
    // check for a fresh notice once a resolved protest's tax year has
    // passed, suppressed as soon as the property has a protest on file for
    // the current year (see propertiesWithCurrentProtest above).
    if (
      pr.status === "resolved" &&
      typeof pr.tax_year === "number" &&
      pr.tax_year < currentYear &&
      !propertiesWithCurrentProtest.has(pr.property_id)
    ) {
      events.push({
        id: `refile-reminder:${pr.id}:${currentYear}`,
        date: `${currentYear}-04-01`,
        type: "refile_reminder",
        title: `Check for this year's notice — re-file for ${currentYear}? — ${address}`,
        amount: null,
      });
    }
  }

  for (const bill of taxBills ?? []) {
    const address = propertyById.get(bill.property_id)?.address ?? "your property";
    const yearLabel = bill.tax_year ? ` (${bill.tax_year})` : "";
    if (bill.due_date) {
      events.push({
        id: `tax-due:bill:${bill.id}`,
        date: toIsoDate(bill.due_date),
        type: "tax_due",
        title: `Tax bill due${yearLabel} — ${address}`,
        amount: bill.amount_due,
      });
    }
    if (bill.penalty_date) {
      events.push({
        id: `tax-penalty:${bill.id}`,
        date: toIsoDate(bill.penalty_date),
        type: "tax_penalty",
        title: `Penalty date${yearLabel} — ${address}`,
        amount: null,
      });
    }
    if (bill.refund_expected_at) {
      events.push({
        id: `refund:${bill.id}`,
        date: toIsoDate(bill.refund_expected_at),
        type: "refund_expected",
        title: `Refund expected${yearLabel} — ${address}`,
        amount: bill.refund_amount,
      });
    }
  }

  const now = new Date();
  const bppDate = nextBppRenditionDeadline(now);
  for (const account of bppAccounts ?? []) {
    events.push({
      id: `bpp-rendition:${account.id}:${bppDate}`,
      date: bppDate,
      type: "bpp_rendition",
      title: `BPP rendition deadline — ${account.business_name}`,
      amount: null,
    });
  }

  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//CorvusPT.ai//Tax Calendar//EN",
    "CALSCALE:GREGORIAN",
    // Hints Google/Outlook to actually re-poll periodically rather than
    // treating this as a one-time import — without it some clients only
    // ever fetch once at subscribe time.
    "X-WR-CALNAME:CorvusPT Tax Calendar",
    "REFRESH-INTERVAL;VALUE=DURATION:PT12H",
    ...events.map(buildIcsEvent),
    "END:VCALENDAR",
  ].join("\r\n");

  return new Response(ics, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
});
