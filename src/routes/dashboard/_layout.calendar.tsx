import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  addMonths,
  subMonths,
  isSameMonth,
  isToday,
  format,
} from "date-fns";
import { ChevronLeft, ChevronRight, Download, ExternalLink, RefreshCw, Copy } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { markPropertyPaid, listProperties } from "@/lib/properties";
import { listProtests } from "@/lib/protests";
import {
  getCalendarEvents,
  googleCalendarAddUrl,
  EVENT_TYPE_LABEL,
  EVENT_TYPE_COLOR,
  type CalendarEvent,
  type CalendarEventType,
} from "@/lib/tax-calendar";
import { findHearingConflicts, type HearingConflictGroup } from "@/lib/hearing-conflicts";
import { downloadIcs } from "@/lib/ics";
import {
  getOrCreateFeedToken,
  regenerateFeedToken,
  getFeedHttpsUrl,
  googleCalendarSubscribeUrl,
} from "@/lib/calendar-feed";
import {
  getGoogleCalendarStatus,
  startGoogleCalendarConnect,
  disconnectGoogleCalendar,
  type GoogleCalendarStatus,
} from "@/lib/google-calendar-sync";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

// google_connected/google_error round-trip from google-calendar-oauth-
// callback's redirect back here after the user finishes (or abandons) the
// Google consent screen — read once on mount to show the right toast, then
// cleared from the URL so refreshing the page doesn't re-show it.
export const Route = createFileRoute("/dashboard/_layout/calendar")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { google_connected?: string; google_error?: string } => ({
    google_connected:
      typeof search.google_connected === "string" ? search.google_connected : undefined,
    google_error: typeof search.google_error === "string" ? search.google_error : undefined,
  }),
  component: CalendarPage,
});

const GROUP_ORDER: CalendarEventType[] = [
  "protest_deadline",
  "informal_review",
  "hearing",
  "arb_decision",
  "tax_due",
  "tax_penalty",
  "refund_expected",
  "bpp_rendition",
  "reminder",
];

function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

function DaysLeftBadge({ event }: { event: CalendarEvent }) {
  if (event.resolved) return <span className="badge-soft text-success">Done</span>;
  const daysLeft = daysUntil(event.date);
  return (
    <span className={`badge-soft ${daysLeft <= 7 ? "text-destructive" : ""}`}>
      {daysLeft < 0
        ? "Past due"
        : daysLeft === 0
          ? "Today"
          : `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`}
    </span>
  );
}

function EventRow({
  event,
  onMarkPaid,
  markingPaid,
}: {
  event: CalendarEvent;
  onMarkPaid?: (propertyId: string) => void;
  markingPaid: boolean;
}) {
  const isPropertySnapshotBill = event.id.startsWith("tax-due:property:");
  return (
    <div className="card-elev p-4 flex items-center justify-between flex-wrap gap-3">
      <div>
        <div className="font-medium">{event.title}</div>
        <div className="text-xs text-muted-foreground">
          {format(new Date(event.date + "T00:00:00"), "MMM d, yyyy")}
          {event.amount != null ? ` • $${event.amount.toLocaleString()}` : ""}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <DaysLeftBadge event={event} />
        {isPropertySnapshotBill && !event.resolved && event.propertyId && onMarkPaid && (
          <button
            disabled={markingPaid}
            onClick={() => onMarkPaid(event.propertyId as string)}
            className="btn-outline text-sm disabled:opacity-60"
          >
            {markingPaid ? "Saving…" : "Mark as Paid"}
          </button>
        )}
        <a
          href={googleCalendarAddUrl(event)}
          target="_blank"
          rel="noreferrer"
          className="btn-outline text-sm inline-flex items-center gap-1"
          title="Add to Google Calendar"
        >
          <ExternalLink className="h-3.5 w-3.5" /> Google
        </a>
        <Link to={event.linkTo} className="text-sm text-muted-foreground hover:text-foreground">
          View
        </Link>
      </div>
    </div>
  );
}

// Real, same-day hearing conflicts across the user's whole portfolio — see
// findHearingConflicts() in hearing-conflicts.ts for what's actually
// deterministic vs. honestly absent here (no fabricated travel time).
function HearingConflictBanner({ group }: { group: HearingConflictGroup }) {
  return (
    <div className="card-elev border-amber-500/30 bg-amber-500/5 p-4">
      <h2 className="font-semibold text-amber-800">
        {group.hearings.length} hearings on{" "}
        {format(new Date(`${group.date}T00:00:00`), "MMMM d, yyyy")}
      </h2>
      <ul className="mt-2 grid gap-1 text-sm">
        {group.hearings.map((h) => (
          <li key={h.protestId} className="text-muted-foreground">
            <span className="font-medium text-foreground">{h.address}</span>
            {h.time ? ` — ${h.time}` : ""}
            {h.location ? ` (${h.location})` : ""}
            {h.mode ? ` — ${h.mode}` : ""}
          </li>
        ))}
      </ul>
      <ul className="mt-2 grid gap-1 text-xs text-muted-foreground">
        {group.guidance.map((g, i) => (
          <li key={i}>• {g}</li>
        ))}
      </ul>
      {group.directionsUrl && (
        <a
          href={group.directionsUrl}
          target="_blank"
          rel="noreferrer"
          className="btn-outline mt-3 inline-flex items-center gap-1.5 text-sm"
        >
          <ExternalLink className="h-3.5 w-3.5" /> Check real driving time between them
        </a>
      )}
    </div>
  );
}

// The real, continuous option — OAuth to the user's own Google account,
// then a ~5-minute cron pushes their deadlines directly via the Calendar
// API (see google-calendar-sync). A new deadline shows up within minutes,
// not on Google's own (often much slower) subscribe-link refresh timing —
// that link-based option is still available below as a lighter-weight
// alternative that needs no Google sign-in permission grant.
function GoogleConnectSection({ userId }: { userId: string }) {
  const [status, setStatus] = useState<GoogleCalendarStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  function loadStatus() {
    setLoading(true);
    getGoogleCalendarStatus()
      .then(setStatus)
      .catch((err) => toast.error(err instanceof Error ? err.message : "Could not check status."))
      .finally(() => setLoading(false));
  }

  useEffect(loadStatus, [userId]);

  async function handleConnect() {
    setConnecting(true);
    try {
      await startGoogleCalendarConnect(); // navigates away on success
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start Google sign-in.");
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    if (
      !window.confirm("Stop syncing to Google Calendar? Events already there won't be removed.")
    ) {
      return;
    }
    setDisconnecting(true);
    try {
      await disconnectGoogleCalendar();
      toast.success("Disconnected.");
      loadStatus();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not disconnect.");
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div className="card-elev p-4">
      <h2 className="font-semibold">Connect Google Calendar</h2>
      <p className="text-sm text-muted-foreground mt-1">
        Real, continuous sync to your own Google account — every deadline pushed directly, kept
        current automatically every few minutes as things change. Nothing to re-add later.
      </p>
      {loading ? (
        <Skeleton className="h-9 w-40 mt-3" />
      ) : status?.connected ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span className="badge-soft text-success">Connected</span>
          <span className="text-xs text-muted-foreground">
            {status.lastSyncedAt
              ? `Last synced ${new Date(status.lastSyncedAt).toLocaleString()}`
              : "First sync in progress…"}
          </span>
          <button
            type="button"
            onClick={handleDisconnect}
            disabled={disconnecting}
            className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-60"
          >
            {disconnecting ? "Disconnecting…" : "Disconnect"}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={handleConnect}
          disabled={connecting}
          className="btn-primary btn-primary-hover text-sm mt-3 inline-flex items-center gap-1.5 disabled:opacity-60"
        >
          <RefreshCw className="h-3.5 w-3.5" />{" "}
          {connecting ? "Redirecting…" : "Connect Google Calendar"}
        </button>
      )}
    </div>
  );
}

// Lighter-weight alternative to GoogleConnectSection above — a subscribe
// link for the WHOLE calendar (every property, every event type), no
// Google sign-in permission grant needed, works with Outlook/Apple
// Calendar too. Still real ongoing sync (new deadlines appear on their
// own), just on Google's own refresh schedule instead of our 5-minute
// cron — see GoogleConnectSection's own comment for that tradeoff.
function LinkSyncSection({ userId }: { userId: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getOrCreateFeedToken(userId)
      .then(setToken)
      .catch((err) => toast.error(err instanceof Error ? err.message : "Could not set up sync."))
      .finally(() => setLoading(false));
  }, [userId]);

  async function handleRegenerate() {
    if (
      !window.confirm(
        "Get a new sync link? Any calendar already subscribed with the old one will stop updating.",
      )
    ) {
      return;
    }
    setRegenerating(true);
    try {
      setToken(await regenerateFeedToken(userId));
      toast.success("New sync link generated.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not generate a new link.");
    } finally {
      setRegenerating(false);
    }
  }

  async function handleCopy() {
    if (!token) return;
    await navigator.clipboard.writeText(getFeedHttpsUrl(token));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="card-elev p-4">
      <h2 className="font-semibold">Or Use a Subscribe Link</h2>
      <p className="text-sm text-muted-foreground mt-1">
        One link for your whole tax calendar — every property's deadlines, hearings, tax bills, and
        BPP renditions. Subscribe once and new dates keep showing up on their own; Google typically
        checks for updates every 12–24 hours, not instantly.
      </p>
      {loading ? (
        <Skeleton className="h-9 w-40 mt-3" />
      ) : token ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <a
            href={googleCalendarSubscribeUrl(token)}
            target="_blank"
            rel="noreferrer"
            className="btn-primary btn-primary-hover text-sm inline-flex items-center gap-1.5"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Add to Google Calendar
          </a>
          <button
            type="button"
            onClick={handleCopy}
            className="btn-outline text-sm inline-flex items-center gap-1.5"
          >
            <Copy className="h-3.5 w-3.5" /> {copied ? "Copied!" : "Copy Link"}
          </button>
          <button
            type="button"
            onClick={handleRegenerate}
            disabled={regenerating}
            className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-60"
          >
            {regenerating ? "Generating…" : "Get a new link"}
          </button>
        </div>
      ) : (
        <p className="mt-3 text-sm text-destructive">Could not set up your sync link.</p>
      )}
    </div>
  );
}

const GOOGLE_ERROR_MESSAGES: Record<string, string> = {
  missing_state: "That connection link expired — please try again.",
  invalid_state: "That connection link expired — please try again.",
  missing_code: "Google didn't return a valid response — please try again.",
  token_exchange_failed: "Could not complete sign-in with Google — please try again.",
  no_refresh_token:
    "Google didn't grant lasting access — try disconnecting any prior CorvusPT access in your Google Account settings, then reconnect.",
  calendar_create_failed: "Could not create your CorvusPT calendar on Google — please try again.",
  access_denied: "Google sign-in was cancelled.",
  unexpected: "Something went wrong connecting to Google — please try again.",
};

function CalendarPage() {
  const { user } = useAuth();
  const nav = useNavigate();
  const search = Route.useSearch();
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [markingPaidId, setMarkingPaidId] = useState<string | null>(null);
  const [syncOpen, setSyncOpen] = useState(!!(search.google_connected || search.google_error));
  const [hearingConflicts, setHearingConflicts] = useState<HearingConflictGroup[]>([]);

  useEffect(() => {
    if (!user) return;
    getCalendarEvents(user.id)
      .then(setEvents)
      .catch((err) => console.error(err))
      .finally(() => setLoading(false));
  }, [user]);

  // Real cross-property hearing-conflict check — only meaningful once a
  // user has more than one hearing on file, so this loads independently of
  // the calendar-event list above (which doesn't carry per-hearing
  // location/mode, just a folded title string).
  useEffect(() => {
    if (!user) return;
    Promise.all([listProtests(user.id), listProperties(user.id)])
      .then(([protests, properties]) =>
        setHearingConflicts(findHearingConflicts(protests, properties)),
      )
      .catch((err) => console.error("Could not check for hearing conflicts:", err));
  }, [user]);

  // One-time: show the result of a just-completed (or abandoned) Google
  // connect attempt, then strip these params so refreshing doesn't re-show
  // the toast.
  useEffect(() => {
    if (search.google_connected) {
      toast.success("Google Calendar connected — your deadlines will start appearing shortly.");
      nav({ to: "/dashboard/calendar", search: {}, replace: true });
    } else if (search.google_error) {
      toast.error(
        GOOGLE_ERROR_MESSAGES[search.google_error] ?? "Could not connect Google Calendar.",
      );
      nav({ to: "/dashboard/calendar", search: {}, replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleMarkPaid(propertyId: string) {
    setMarkingPaidId(propertyId);
    try {
      await markPropertyPaid(propertyId);
      setEvents((prev) =>
        prev.map((e) =>
          e.propertyId === propertyId && e.type === "tax_due" ? { ...e, resolved: true } : e,
        ),
      );
      toast.success("Marked as paid.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update this bill.");
    } finally {
      setMarkingPaidId(null);
    }
  }

  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const e of events) {
      const list = map.get(e.date) ?? [];
      list.push(e);
      map.set(e.date, list);
    }
    return map;
  }, [events]);

  const gridDays = useMemo(() => {
    const start = startOfWeek(startOfMonth(month));
    const end = endOfWeek(endOfMonth(month));
    return eachDayOfInterval({ start, end });
  }, [month]);

  const upcomingCount = events.filter((e) => !e.resolved && daysUntil(e.date) >= 0).length;

  const visibleEvents = selectedDate ? (eventsByDate.get(selectedDate) ?? []) : events;

  const grouped = GROUP_ORDER.map((type) => ({
    type,
    items: visibleEvents.filter((e) => e.type === type),
  })).filter((g) => g.items.length > 0);

  if (loading) {
    return (
      <div className="grid gap-8">
        <div>
          <h1 className="font-serif text-2xl font-semibold">Calendar</h1>
          <p className="text-muted-foreground text-sm">
            Protest deadlines, ARB hearings, tax bills, and BPP renditions, in one place.
          </p>
        </div>
        <div className="grid gap-3">
          {[0, 1].map((i) => (
            <div key={i} className="card-elev p-4 flex items-center justify-between gap-2">
              <div className="grid gap-2">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-56" />
              </div>
              <Skeleton className="h-6 w-24 shrink-0" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-8">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-serif text-2xl font-semibold">Calendar</h1>
          <p className="text-muted-foreground text-sm">
            {upcomingCount > 0
              ? `${upcomingCount} upcoming item${upcomingCount === 1 ? "" : "s"} across protests, hearings, and tax bills.`
              : "Protest deadlines, ARB hearings, tax bills, and BPP renditions, in one place."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSyncOpen((o) => !o)}
            className="btn-outline text-sm inline-flex items-center gap-1.5"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Sync with Google Calendar
          </button>
          {events.length > 0 && (
            <button
              onClick={() => downloadIcs("corvuspt-tax-calendar.ics", events)}
              className="btn-outline text-sm inline-flex items-center gap-1.5"
            >
              <Download className="h-3.5 w-3.5" /> Export all (.ics)
            </button>
          )}
        </div>
      </div>

      {hearingConflicts.length > 0 && (
        <div className="grid gap-3">
          {hearingConflicts.map((group) => (
            <HearingConflictBanner key={group.date} group={group} />
          ))}
        </div>
      )}

      {syncOpen && user && (
        <div className="grid gap-4 sm:grid-cols-2">
          <GoogleConnectSection userId={user.id} />
          <LinkSyncSection userId={user.id} />
        </div>
      )}

      <div className="card-elev p-4">
        <div className="flex items-center justify-between">
          <button
            onClick={() => setMonth((m) => subMonths(m, 1))}
            className="rounded-md p-1.5 hover:bg-secondary"
            aria-label="Previous month"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <h2 className="font-semibold">{format(month, "MMMM yyyy")}</h2>
          <button
            onClick={() => setMonth((m) => addMonths(m, 1))}
            className="rounded-md p-1.5 hover:bg-secondary"
            aria-label="Next month"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-4 grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground">
          {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => (
            <div key={d} className="py-1">
              {d}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {gridDays.map((day) => {
            const iso = format(day, "yyyy-MM-dd");
            const dayEvents = eventsByDate.get(iso) ?? [];
            const inMonth = isSameMonth(day, month);
            const selected = selectedDate === iso;
            // Property addresses shown directly on the grid now, not just on
            // hover — up to 3 visible, the rest folded into a "+N more" line
            // (still hoverable for the full list) so a day with a lot on it
            // doesn't blow out every row's height.
            const VISIBLE = 3;
            const shown = dayEvents.slice(0, VISIBLE);
            const overflow = dayEvents.length - shown.length;
            const dayButton = (
              <button
                key={iso}
                onClick={() => setSelectedDate(selected ? null : iso)}
                className={`min-h-20 rounded-md p-1 text-left text-sm transition-colors ${
                  selected
                    ? "bg-accent/20 ring-1 ring-accent"
                    : dayEvents.length > 0
                      ? "hover:bg-secondary/60"
                      : "hover:bg-secondary/30"
                } ${!inMonth ? "text-muted-foreground/40" : ""}`}
              >
                <span
                  className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-xs ${
                    isToday(day) ? "bg-primary text-primary-foreground" : ""
                  }`}
                >
                  {format(day, "d")}
                </span>
                {shown.length > 0 && (
                  <div className="mt-1 grid gap-0.5">
                    {shown.map((e) => (
                      <div key={e.id} className="flex items-center gap-1 min-w-0">
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${EVENT_TYPE_COLOR[e.type]}`}
                        />
                        <span className="truncate text-[10px] leading-tight text-muted-foreground">
                          {e.propertyLabel}
                        </span>
                      </div>
                    ))}
                    {overflow > 0 && (
                      <span className="text-[10px] leading-tight text-muted-foreground pl-2.5">
                        +{overflow} more
                      </span>
                    )}
                  </div>
                )}
              </button>
            );
            // Hover still gives the full list with event type included (the
            // grid itself only has room for the property address) — a
            // supplement, not the only way to see what's there anymore.
            if (dayEvents.length === 0) return dayButton;
            return (
              <Tooltip key={iso}>
                <TooltipTrigger asChild>{dayButton}</TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs">
                  <div className="grid gap-0.5">
                    {dayEvents.map((e) => (
                      <span key={e.id}>{e.title}</span>
                    ))}
                  </div>
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </div>

      {selectedDate && (
        <div className="-mt-4 flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Showing {format(new Date(selectedDate + "T00:00:00"), "MMMM d, yyyy")}
          </p>
          <button
            onClick={() => setSelectedDate(null)}
            className="text-sm text-accent hover:underline"
          >
            Clear filter — show all
          </button>
        </div>
      )}

      {grouped.length === 0 ? (
        <div className="card-elev p-6 text-center text-sm text-muted-foreground">
          {selectedDate
            ? "Nothing on this day."
            : "No dates tracked yet. Add a property, protest, or tax bill and its dates will show up here."}
        </div>
      ) : (
        grouped.map(({ type, items }) => (
          <section key={type}>
            <h2 className="font-semibold">{EVENT_TYPE_LABEL[type]}</h2>
            <div className="mt-3 grid gap-3">
              {items.map((event) => (
                <EventRow
                  key={event.id}
                  event={event}
                  onMarkPaid={handleMarkPaid}
                  markingPaid={markingPaidId === event.propertyId}
                />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
