// Shared by google-calendar-oauth-callback (first sync right after connect)
// and google-calendar-sync (the recurring cron pass). Deno-side
// reimplementation of src/lib/tax-calendar.ts's getCalendarEvents() — same
// duplication tradeoff as calendar-feed/index.ts (that file's own comment
// explains why: the browser supabase-js client isn't usable here). Keep
// this event-construction logic in sync by hand with tax-calendar.ts if it
// ever changes.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type SyncEvent = {
  // Same corvusrf-<id>@corvusre.com scheme as ics.ts/calendar-feed, reused
  // here as Google Calendar's iCalUID — the one stable key that lets a
  // reconciliation pass tell "already on their calendar" apart from "new."
  iCalUID: string;
  date: string; // YYYY-MM-DD
  title: string;
  amount: number | null;
};

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

function toIsoDate(value: string): string {
  return value.length >= 10 ? value.slice(0, 10) : value;
}

function nextBppRenditionDeadline(from: Date): string {
  const year = from.getUTCFullYear();
  const thisYearDeadline = new Date(Date.UTC(year, 3, 15));
  const deadline =
    from <= thisYearDeadline ? thisYearDeadline : new Date(Date.UTC(year + 1, 3, 15));
  return deadline.toISOString().slice(0, 10);
}

function uid(id: string): string {
  return `corvusrf-${id}@corvusre.com`;
}

export async function buildUserEvents(
  adminClient: SupabaseClient,
  userId: string,
): Promise<SyncEvent[]> {
  const [{ data: properties }, { data: protests }, { data: taxBills }, { data: bppAccounts }] =
    await Promise.all([
      adminClient
        .from("properties")
        .select("id, address, protest_deadline, payment_due_date, tax_amount_due")
        .eq("user_id", userId),
      adminClient
        .from("protests")
        .select(
          "id, property_id, status, hearing_date, hearing_time, hearing_location, arb_decision_date, informal_status, informal_review_date, tax_year",
        )
        .eq("user_id", userId),
      adminClient
        .from("tax_bills")
        .select(
          "id, property_id, tax_year, amount_due, due_date, penalty_date, refund_amount, refund_expected_at",
        )
        .eq("user_id", userId),
      adminClient.from("bpp_accounts").select("id, business_name").eq("user_id", userId),
    ]);

  type Row = Record<string, unknown>;
  const propertyById = new Map(((properties ?? []) as Row[]).map((p) => [p.id as string, p]));
  const taxBillPropertyIds = new Set(
    ((taxBills ?? []) as Row[]).map((b) => b.property_id as string),
  );
  // Mirrors getCalendarEvents()'s own propertiesWithCurrentProtest set in
  // src/lib/tax-calendar.ts by hand — suppresses the refile_reminder below
  // once a property already has a protest on file for the current tax year.
  const currentYear = new Date().getFullYear();
  const propertiesWithCurrentProtest = new Set(
    ((protests ?? []) as Row[])
      .filter((p) => typeof p.tax_year === "number" && (p.tax_year as number) >= currentYear)
      .map((p) => p.property_id as string),
  );
  const events: SyncEvent[] = [];

  for (const p of (properties ?? []) as Row[]) {
    const id = p.id as string;
    const address = p.address as string;
    if (p.protest_deadline) {
      events.push({
        iCalUID: uid(`protest-deadline:${id}`),
        date: toIsoDate(p.protest_deadline as string),
        title: `${EVENT_TYPE_LABEL.protest_deadline} — ${address}`,
        amount: null,
      });
    }
    if (p.payment_due_date && !taxBillPropertyIds.has(id)) {
      events.push({
        iCalUID: uid(`tax-due:property:${id}`),
        date: toIsoDate(p.payment_due_date as string),
        title: `${EVENT_TYPE_LABEL.tax_due} — ${address}`,
        amount: p.tax_amount_due as number | null,
      });
    }
  }

  for (const pr of (protests ?? []) as Row[]) {
    const id = pr.id as string;
    const address =
      (propertyById.get(pr.property_id as string)?.address as string) ?? "your property";
    if (pr.informal_status === "scheduled" && pr.informal_review_date) {
      events.push({
        iCalUID: uid(`informal-review:${id}`),
        date: toIsoDate(pr.informal_review_date as string),
        title: `${EVENT_TYPE_LABEL.informal_review} — ${address}`,
        amount: null,
      });
    }
    if (pr.status === "hearing_scheduled" && pr.hearing_date) {
      // Real time/location from an actual uploaded hearing notice, when
      // there is one (see extract-hearing-notice) — mirrors
      // hearingEventTitle() in src/lib/tax-calendar.ts by hand, since this
      // Deno function can't import that browser module.
      const titleParts = [`${EVENT_TYPE_LABEL.hearing} — ${address}`];
      if (pr.hearing_time) titleParts.push(`at ${pr.hearing_time as string}`);
      if (pr.hearing_location) titleParts.push(`(${pr.hearing_location as string})`);
      events.push({
        iCalUID: uid(`hearing:${id}`),
        date: toIsoDate(pr.hearing_date as string),
        title: titleParts.join(" "),
        amount: null,
      });
    }
    if (pr.arb_decision_date) {
      events.push({
        iCalUID: uid(`arb-decision:${id}`),
        date: toIsoDate(pr.arb_decision_date as string),
        title: `${EVENT_TYPE_LABEL.arb_decision} — ${address}`,
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
      (pr.tax_year as number) < currentYear &&
      !propertiesWithCurrentProtest.has(pr.property_id as string)
    ) {
      events.push({
        iCalUID: uid(`refile-reminder:${id}:${currentYear}`),
        date: `${currentYear}-04-01`,
        title: `Check for this year's notice — re-file for ${currentYear}? — ${address}`,
        amount: null,
      });
    }
  }

  for (const bill of (taxBills ?? []) as Row[]) {
    const id = bill.id as string;
    const address =
      (propertyById.get(bill.property_id as string)?.address as string) ?? "your property";
    const yearLabel = bill.tax_year ? ` (${bill.tax_year})` : "";
    if (bill.due_date) {
      events.push({
        iCalUID: uid(`tax-due:bill:${id}`),
        date: toIsoDate(bill.due_date as string),
        title: `${EVENT_TYPE_LABEL.tax_due}${yearLabel} — ${address}`,
        amount: bill.amount_due as number | null,
      });
    }
    if (bill.penalty_date) {
      events.push({
        iCalUID: uid(`tax-penalty:${id}`),
        date: toIsoDate(bill.penalty_date as string),
        title: `${EVENT_TYPE_LABEL.tax_penalty}${yearLabel} — ${address}`,
        amount: null,
      });
    }
    if (bill.refund_expected_at) {
      events.push({
        iCalUID: uid(`refund:${id}`),
        date: toIsoDate(bill.refund_expected_at as string),
        title: `${EVENT_TYPE_LABEL.refund_expected}${yearLabel} — ${address}`,
        amount: bill.refund_amount as number | null,
      });
    }
  }

  const bppDate = nextBppRenditionDeadline(new Date());
  for (const account of (bppAccounts ?? []) as Row[]) {
    events.push({
      iCalUID: uid(`bpp-rendition:${account.id}:${bppDate}`),
      date: bppDate,
      title: `${EVENT_TYPE_LABEL.bpp_rendition} — ${account.business_name}`,
      amount: null,
    });
  }

  return events;
}

// Exchanges a stored refresh_token for a fresh access_token — refresh
// tokens don't expire from use (only if revoked), access tokens are
// short-lived (~1hr), so this runs on every sync pass.
export async function getAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CALENDAR_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CALENDAR_CLIENT_SECRET")!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token refresh failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

type GoogleEvent = {
  id: string;
  iCalUID?: string;
  start?: { date?: string };
  summary?: string;
};

// Reconciles Google's actual state to match `events` exactly: inserts what's
// missing, updates anything whose date/title drifted, and deletes any
// CorvusPT-created event (recognized by the corvusrf- UID prefix) that's no
// longer in `events` — e.g. a bill got paid and its penalty-date event
// dropped off the real list. Never touches events Google events that aren't
// ours (no UID match), since this calendar is otherwise still a normal
// Google Calendar the user could add their own things to.
export async function reconcileGoogleCalendar(
  accessToken: string,
  calendarId: string,
  events: SyncEvent[],
): Promise<void> {
  const listUrl = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
  );
  listUrl.searchParams.set("maxResults", "2500");
  listUrl.searchParams.set("showDeleted", "false");
  listUrl.searchParams.set("singleEvents", "true");
  const listRes = await fetch(listUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!listRes.ok) throw new Error(`Google events.list failed: ${listRes.status}`);
  const { items } = (await listRes.json()) as { items: GoogleEvent[] };

  const existingByUid = new Map<string, GoogleEvent>();
  for (const item of items) {
    if (item.iCalUID?.startsWith("corvusrf-")) existingByUid.set(item.iCalUID, item);
  }

  const wantedUids = new Set(events.map((e) => e.iCalUID));

  for (const event of events) {
    const existing = existingByUid.get(event.iCalUID);
    const end = new Date(event.date + "T00:00:00Z");
    end.setUTCDate(end.getUTCDate() + 1);
    const body = {
      summary: event.title,
      description: `${event.amount != null ? `$${event.amount.toLocaleString()} — ` : ""}via CorvusPT.ai`,
      start: { date: event.date },
      end: { date: end.toISOString().slice(0, 10) },
      iCalUID: event.iCalUID,
    };
    if (!existing) {
      await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
    } else if (existing.start?.date !== event.date || existing.summary !== event.title) {
      await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${existing.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
    }
  }

  for (const [uid, existing] of existingByUid) {
    if (!wantedUids.has(uid)) {
      await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${existing.id}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } },
      );
    }
  }
}
