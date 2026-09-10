import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Plus,
  Briefcase,
  Upload,
  Sparkles,
  ArrowUpRight,
  AlertTriangle,
  Building2,
  FileText,
  Scale,
  TrendingDown,
  Loader2,
  Mic,
  Volume2,
  VolumeX,
  type LucideIcon,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Cell,
  LabelList,
  ResponsiveContainer,
  PieChart,
  Pie,
} from "recharts";
import { useAuth } from "@/lib/auth";
import { currency, resetIntake, classifyAndStoreDocument, updateIntake } from "@/lib/intake-store";
import { listProperties, type PropertyRecord } from "@/lib/properties";
import { useSavingsBackfill } from "@/hooks/use-savings-backfill";
import { useHealthScoreBackfill } from "@/hooks/use-health-score-backfill";
import { listHealthScores, type PropertyAiScore } from "@/lib/property-scores";
import {
  getEffectiveTaxRate,
  getBaseReductionPct,
  classifyPropertyCategory,
} from "@/lib/texas-tax-rates";
import { listBppAccounts, type BppAccountRecord } from "@/lib/bpp-accounts";
import { listDocuments, type DocumentRecord } from "@/lib/documents";
import { listProtests, type ProtestRecord, type ProtestStatus } from "@/lib/protests";
import { getPropertyProtestStatus } from "@/lib/portfolio-status";
import { askRouter } from "@/lib/ask-router";
import { askAboutDocument } from "@/lib/document-ai";
import { buildUserContext } from "@/lib/ai-context";
import { getDeadlineNudge } from "@/lib/deadline-nudge";
import { getHearingNudge } from "@/lib/hearing-nudge";
import { AnimatedNumber } from "@/components/AnimatedNumber";
import { useFileDrop } from "@/hooks/use-file-drop";
import { useSpeechInput } from "@/hooks/use-speech-input";
import { useSpeechOutput } from "@/hooks/use-speech-output";
import { MarkdownLite } from "@/components/MarkdownLite";
import { ICON_COLORS } from "@/lib/icon-colors";

export const Route = createFileRoute("/dashboard/_layout/")({
  component: Overview,
});

const STATUS_LABEL: Record<ProtestStatus, string> = {
  requested: "Requested",
  filed: "Filed",
  under_review: "Under Review",
  offer_received: "Offer Received",
  hearing_scheduled: "Hearing Scheduled",
  decision_received: "Decision Received",
  appealing: "Appealing",
  arbitrating: "Arbitrating",
  resolved: "Resolved",
};

function Overview() {
  const nav = useNavigate();
  const { user } = useAuth();
  const [properties, setProperties] = useState<PropertyRecord[]>([]);
  const [bppAccounts, setBppAccounts] = useState<BppAccountRecord[]>([]);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [protests, setProtests] = useState<ProtestRecord[]>([]);
  const [healthScores, setHealthScores] = useState<Record<string, PropertyAiScore>>({});
  const [loaded, setLoaded] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [askQuery, setAskQuery] = useState("");
  const [asking, setAsking] = useState(false);
  // The last question + its answer, shown as a small conversation panel
  // under Quick Actions (markdown-rendered — not a raw-text toast).
  const [askAnswer, setAskAnswer] = useState<{ q: string; a: string; dest: string | null } | null>(
    null,
  );
  // Read the AI's reply aloud — when the toggle is on, or when the question
  // was just asked by voice (a spoken question gets a spoken answer).
  const askTts = useSpeechOutput();
  const askedByVoice = useRef(false);
  // Voice input for the "Ask AI" quick action. Fills the box as you speak,
  // then auto-submits when you stop talking so a spoken question is fully
  // hands-free.
  const askSpeech = useSpeechInput(setAskQuery, {
    onFinal: (text) => {
      askedByVoice.current = true;
      setAskQuery(text);
      void runAsk(text);
    },
  });
  const [nudge, setNudge] = useState<string | null>(null);
  const nudgedPropertyId = useRef<string | null>(null);
  const [hearingNudge, setHearingNudge] = useState<string | null>(null);
  const nudgedHearingProtestId = useRef<string | null>(null);

  useEffect(() => {
    if (!user) return;
    Promise.all([
      listProperties(user.id),
      listBppAccounts(user.id),
      listDocuments(user.id),
      listProtests(user.id),
      listHealthScores(user.id),
    ])
      .then(([props, bpp, docs, prot, scores]) => {
        setProperties(props);
        setBppAccounts(bpp);
        setDocuments(docs);
        setProtests(prot);
        setHealthScores(scores);
      })
      .catch((err) => console.error(err))
      .finally(() => setLoaded(true));
  }, [user]);

  useSavingsBackfill(properties, setProperties);
  useHealthScoreBackfill(properties, healthScores, setHealthScores);

  function openAiReport(p: PropertyRecord) {
    updateIntake({
      address: p.address,
      cad: p.cad ?? undefined,
      accountNumber: p.accountNumber ?? undefined,
      ownerName: p.ownerName ?? undefined,
      propertyType: p.propertyType ?? undefined,
      landValue: p.landValue ?? undefined,
      improvementValue: p.improvementValue ?? undefined,
      totalValue: p.totalValue ?? undefined,
      taxYear: p.taxYear ?? undefined,
      valueHistory: p.valueHistory ?? undefined,
      confirmed: true,
    });
    nav({ to: "/ai-report" });
  }

  const addressFor = (propertyId: string) =>
    properties.find((p) => p.id === propertyId)?.address ?? "Property removed";

  // Prefers the real per-property estimate computed during intake (comps- or
  // formula-grounded — see src/lib/savings-estimate.ts) whenever it's on file.
  // Only falls back to the same deterministic formula's base reduction rate for
  // properties useSavingsBackfill hasn't caught up to yet — deliberately not
  // calling estimateSavings() synchronously here, since that's what the
  // backfill hook above already does in the background and persists.
  const estimatedSavings = useMemo(
    () =>
      properties.reduce((sum, p) => {
        if (p.estimatedSavings != null) return sum + p.estimatedSavings;
        if (!p.totalValue) return sum;
        const category = classifyPropertyCategory(p.propertyType);
        return (
          sum +
          Math.round(
            p.totalValue * getBaseReductionPct(p.cad, category) * getEffectiveTaxRate(p.cad),
          )
        );
      }, 0),
    [properties],
  );

  const deadlines = properties
    .filter((p) => !!p.protestDeadline)
    .map((p) => ({
      property: p,
      when: new Date(p.protestDeadline as string),
      label: "Protest deadline",
    }));
  const bills = properties
    .filter((p) => !!p.paymentDueDate && !p.paidAt)
    .map((p) => ({
      property: p,
      when: new Date(p.paymentDueDate as string),
      label: "Tax bill due",
    }));
  const hearingDates = protests
    .filter((pr) => pr.status === "hearing_scheduled" && !!pr.hearingDate)
    .map((pr) => ({
      property: properties.find((p) => p.id === pr.propertyId),
      when: new Date(pr.hearingDate as string),
      label: "ARB hearing",
    }))
    .filter((h): h is { property: PropertyRecord; when: Date; label: string } => !!h.property);
  const upcoming = [...deadlines, ...bills, ...hearingDates]
    .sort((a, b) => a.when.getTime() - b.when.getTime())
    .slice(0, 4);

  // Same 14-day threshold as NEEDS_ACTION_WINDOW_DAYS in portfolio-status.ts —
  // a hearing this close is exactly as urgent as a protest deadline this close.
  const HEARING_REMINDER_WINDOW_DAYS = 14;
  const hearingReminders = protests
    .filter((pr) => pr.status === "hearing_scheduled" && !!pr.hearingDate)
    .map((pr) => {
      const property = properties.find((p) => p.id === pr.propertyId);
      const daysLeft = Math.ceil(
        (new Date(pr.hearingDate as string).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
      );
      return { protest: pr, property, daysLeft };
    })
    .filter(
      (h): h is { protest: ProtestRecord; property: PropertyRecord; daysLeft: number } =>
        !!h.property && h.daysLeft <= HEARING_REMINDER_WINDOW_DAYS,
    )
    .sort((a, b) => a.daysLeft - b.daysLeft);

  // Properties flagged "needs_action" by the shared status helper (see
  // src/lib/portfolio-status.ts — also used for the Properties page's per-property
  // badges, so this banner and those badges never disagree). Drives the AI reminder
  // banner below.
  const urgentProperties = properties
    .map((p) => ({ property: p, ...getPropertyProtestStatus(p, protests) }))
    .filter(
      (u): u is typeof u & { daysLeft: number } =>
        u.status === "needs_action" && u.daysLeft != null,
    )
    .sort((a, b) => a.daysLeft - b.daysLeft);

  useEffect(() => {
    if (urgentProperties.length === 0) return;
    const soonest = urgentProperties[0];
    if (nudgedPropertyId.current === soonest.property.id) return;
    nudgedPropertyId.current = soonest.property.id;
    getDeadlineNudge({
      address: soonest.property.address,
      daysLeft: soonest.daysLeft,
      totalValue: soonest.property.totalValue ?? undefined,
    })
      .then((r) => setNudge(r.message))
      .catch((err) => console.error("Deadline nudge failed:", err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urgentProperties.length > 0 ? urgentProperties[0].property.id : null]);

  useEffect(() => {
    if (hearingReminders.length === 0) return;
    const soonest = hearingReminders[0];
    if (nudgedHearingProtestId.current === soonest.protest.id) return;
    nudgedHearingProtestId.current = soonest.protest.id;
    getHearingNudge({ address: soonest.property.address, daysLeft: soonest.daysLeft })
      .then((r) => setHearingNudge(r.message))
      .catch((err) => console.error("Hearing nudge failed:", err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hearingReminders.length > 0 ? hearingReminders[0].protest.id : null]);

  async function onUploadNotice(f: File) {
    setUploading(true);
    try {
      await classifyAndStoreDocument(f);
      nav({ to: "/document-review" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not read this document.");
      setUploading(false);
    }
  }

  const { isDragging: isDraggingNotice, dropHandlers: noticeDropHandlers } = useFileDrop(
    onUploadNotice,
    uploading,
  );

  async function runAsk(text: string) {
    const q = text.trim();
    if (!q || asking) return;
    setAsking(true);
    try {
      // Actually answer the question with the user's own data (same engine
      // as the Ask AI widget) — not the guest route-classifier, which would
      // send a signed-in dashboard user to /sign-in. route-intent still runs
      // in parallel, but only as a "continue to…" hint when it lands on a
      // real in-app page.
      const context = user ? await buildUserContext(user.id).catch(() => "") : "";
      const [ansRes, routeRes] = await Promise.allSettled([
        askAboutDocument({ question: q, context: context || undefined, conversational: true }),
        askRouter(q),
      ]);
      const answer =
        ansRes.status === "fulfilled"
          ? ansRes.value.answer
          : "Sorry — I couldn't answer that. Please try again.";
      const dest =
        routeRes.status === "fulfilled" &&
        /^\/(dashboard|ai-report)(\/|$)/.test(routeRes.value.destination)
          ? routeRes.value.destination
          : null;
      setAskAnswer({ q, a: answer, dest });
      if (askTts.enabled || askedByVoice.current) askTts.speak(answer);
      setAskQuery("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not process that. Please try again.");
    } finally {
      setAsking(false);
      askedByVoice.current = false;
    }
  }

  function submitAsk(e: React.FormEvent) {
    e.preventDefault();
    void runAsk(askQuery);
  }

  const firstName = user?.user_metadata?.first_name as string | undefined;

  return (
    <div className="dashboard-contrast grid grid-cols-1 min-w-0 gap-6">
      <div>
        <span className="badge-soft">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" /> AI is watching your properties
        </span>
        <h1 className="mt-3 font-serif text-3xl font-bold">
          Welcome back{firstName ? `, ${firstName}` : ""}.
        </h1>
        <p className="text-muted-foreground">
          Pick any entry point below — AI figures out the right workflow.
        </p>
      </div>

      {nudge && urgentProperties.length > 0 && (
        <div className="card-elev p-4 border-destructive/30 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 shrink-0 text-destructive mt-0.5" />
          <div className="min-w-0">
            <p className="text-sm font-medium">{nudge}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {urgentProperties[0].property.address}
              {urgentProperties.length > 1 &&
                ` — +${urgentProperties.length - 1} other propert${urgentProperties.length - 1 === 1 ? "y" : "ies"} also need attention`}
            </p>
            <Link to="/dashboard/properties" className="btn-outline text-sm mt-3 inline-flex">
              Review &amp; Request Protest
            </Link>
          </div>
        </div>
      )}

      {hearingNudge && hearingReminders.length > 0 && (
        <div className="card-elev p-4 border-destructive/30 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 shrink-0 text-destructive mt-0.5" />
          <div className="min-w-0">
            <p className="text-sm font-medium">{hearingNudge}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {hearingReminders[0].property.address}
              {hearingReminders.length > 1 &&
                ` — +${hearingReminders.length - 1} other hearing${hearingReminders.length - 1 === 1 ? "" : "s"} coming up`}
            </p>
            <Link to="/dashboard/properties" className="btn-outline text-sm mt-3 inline-flex">
              View Case
            </Link>
          </div>
        </div>
      )}

      {/* Entry points */}
      <div>
        <h2 className="font-serif text-xl font-bold">Quick Actions</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Link
            to="/intake"
            onClick={() => resetIntake()}
            className="card-elev flex items-center gap-2.5 p-3 transition-all hover:-translate-y-0.5 hover:bg-secondary/40 hover:shadow-elev"
          >
            <span
              className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${ICON_COLORS[0].bg} ${ICON_COLORS[0].text}`}
            >
              <Plus className="h-4 w-4" />
            </span>
            <div className="flex items-center gap-1 text-sm font-semibold">
              Add Property <ArrowUpRight className="h-3.5 w-3.5" />
            </div>
          </Link>

          <Link
            to="/dashboard/bpp-accounts"
            className="card-elev flex items-center gap-2.5 p-3 transition-all hover:-translate-y-0.5 hover:bg-secondary/40 hover:shadow-elev"
            style={{ animationDelay: "60ms" }}
          >
            <span
              className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${ICON_COLORS[1].bg} ${ICON_COLORS[1].text}`}
            >
              <Briefcase className="h-4 w-4" />
            </span>
            <div className="flex items-center gap-1 text-sm font-semibold">
              Add BPP Account <ArrowUpRight className="h-3.5 w-3.5" />
            </div>
          </Link>

          <label
            className={`card-elev flex cursor-pointer items-center gap-2.5 p-3 transition-all ${
              uploading
                ? "opacity-60 pointer-events-none"
                : "hover:-translate-y-0.5 hover:bg-secondary/40 hover:shadow-elev"
            } ${isDraggingNotice ? "border-accent bg-accent/5" : ""}`}
            style={{ animationDelay: "120ms" }}
            {...noticeDropHandlers}
          >
            <span
              className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${ICON_COLORS[2].bg} ${ICON_COLORS[2].text}`}
            >
              {uploading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
            </span>
            <div className="text-sm font-semibold">
              {isDraggingNotice
                ? "Drop to upload"
                : uploading
                  ? "Reading document…"
                  : "Upload Notice"}
            </div>
            <input
              type="file"
              className="hidden"
              accept=".pdf,image/*"
              disabled={uploading}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onUploadNotice(f);
              }}
            />
          </label>

          <form
            onSubmit={submitAsk}
            className="card-elev flex items-center gap-2.5 p-3 transition-all hover:shadow-elev"
            style={{ animationDelay: "180ms" }}
          >
            <span
              className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${ICON_COLORS[4].bg} ${ICON_COLORS[4].text}`}
            >
              <Sparkles className="h-4 w-4" />
            </span>
            <input
              value={askQuery}
              onChange={(e) => {
                setAskQuery(e.target.value);
                askedByVoice.current = false;
              }}
              placeholder={askSpeech.listening ? "Listening…" : "Ask AI…"}
              disabled={asking}
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground disabled:opacity-60"
            />
            {askTts.supported && (
              <button
                type="button"
                onClick={() => askTts.setEnabled(!(askTts.enabled || askTts.speaking))}
                aria-label={askTts.enabled ? "Turn off read-aloud" : "Read answers aloud"}
                title={askTts.enabled ? "Read-aloud on" : "Read answers aloud"}
                className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border transition-colors ${
                  askTts.enabled
                    ? "bg-accent/10 text-accent"
                    : "text-muted-foreground hover:text-foreground"
                } ${askTts.speaking ? "animate-pulse" : ""}`}
              >
                {askTts.enabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
              </button>
            )}
            {askSpeech.supported && (
              <button
                type="button"
                onClick={() => {
                  if (!askSpeech.listening) askedByVoice.current = true;
                  askSpeech.toggle();
                }}
                disabled={asking}
                aria-label={askSpeech.listening ? "Stop listening" : "Speak your question"}
                title={askSpeech.listening ? "Stop listening" : "Speak your question"}
                className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border transition-colors disabled:opacity-60 ${
                  askSpeech.listening
                    ? "bg-destructive/10 text-destructive"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Mic className="h-4 w-4" />
              </button>
            )}
          </form>
        </div>

        {(asking || askAnswer) && (
          <div className="card-elev mt-3 p-4">
            {askAnswer && (
              <div className="ml-auto mb-2 w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-accent px-3 py-1.5 text-sm text-accent-foreground">
                {askAnswer.q}
              </div>
            )}
            <div className="mr-auto max-w-[92%] rounded-2xl rounded-bl-sm bg-secondary/50 px-3 py-2 text-sm">
              {asking ? (
                <span className="text-muted-foreground">Thinking…</span>
              ) : askAnswer ? (
                <>
                  <MarkdownLite text={askAnswer.a} />
                  {askAnswer.dest && (
                    <button
                      type="button"
                      onClick={() => nav({ to: askAnswer.dest as string })}
                      className="btn-primary btn-primary-hover mt-2 inline-flex text-xs py-1.5"
                    >
                      Open
                    </button>
                  )}
                </>
              ) : null}
            </div>
            {askAnswer && !asking && (
              <button
                type="button"
                onClick={() => setAskAnswer(null)}
                className="mt-2 text-xs text-muted-foreground hover:text-foreground"
              >
                Dismiss
              </button>
            )}
          </div>
        )}
      </div>

      {/* Stats */}
      <div>
        <h2 className="font-serif text-xl font-bold">Your Portfolio at a Glance</h2>
        <div className="mt-3 grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
          <StatCard
            label="Properties"
            value={loaded ? properties.length : null}
            to="/dashboard/properties"
            delayMs={0}
            icon={Building2}
            color={ICON_COLORS[0]}
          />
          <StatCard
            label="BPP Accounts"
            value={loaded ? bppAccounts.length : null}
            to="/dashboard/bpp-accounts"
            delayMs={40}
            icon={Briefcase}
            color={ICON_COLORS[1]}
          />
          <StatCard
            label="Documents"
            value={loaded ? documents.length : null}
            to="/dashboard/documents"
            delayMs={80}
            icon={FileText}
            color={ICON_COLORS[2]}
          />
          <StatCard
            label="Cases"
            value={loaded ? protests.length : null}
            to="/dashboard/properties"
            delayMs={120}
            icon={Scale}
            color={ICON_COLORS[4]}
          />
          <StatCard
            label="Est. Savings"
            value={loaded ? estimatedSavings : null}
            format={currency}
            delayMs={160}
            icon={TrendingDown}
            color={ICON_COLORS[5]}
          />
        </div>
      </div>

      <div>
        <h2 className="font-serif text-xl font-bold">Insights &amp; Activity</h2>
        <div className="mt-3 grid grid-cols-1 gap-6">
          {properties.length > 0 && (
            <div className="card-elev p-5 min-w-0">
              <h3 className="text-base font-bold">Portfolio Value</h3>
              <PortfolioValueChart properties={properties} onOpenReport={openAiReport} />
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="card-elev p-5 min-w-0">
              <h3 className="text-base font-bold">Cases & AI Recommendations</h3>
              {protests.length > 0 ? (
                <ProtestStatusChart protests={protests} addressFor={addressFor} />
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">
                  No cases yet. Use an entry point above.
                </p>
              )}
            </div>

            <div className="card-elev p-5 min-w-0">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-bold">Deadlines</h3>
                <Link to="/dashboard/deadlines" className="text-xs text-accent hover:underline">
                  View all
                </Link>
              </div>
              {upcoming.length > 0 ? (
                <div className="mt-3 grid min-w-0 gap-2">
                  {upcoming.map((u, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between gap-2 text-sm min-w-0"
                    >
                      <span className="truncate min-w-0">
                        {u.label} — {u.property.address}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {u.when.toLocaleDateString()}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">
                  No deadlines yet. AI will surface them as you add properties.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  to,
  format,
  delayMs = 0,
  icon: Icon,
  color = ICON_COLORS[0],
}: {
  label: string;
  value: number | null;
  to?: "/dashboard/properties" | "/dashboard/bpp-accounts" | "/dashboard/documents";
  format?: (n: number) => string;
  delayMs?: number;
  icon: LucideIcon;
  color?: (typeof ICON_COLORS)[number];
}) {
  const content = (
    <>
      <span className={`grid h-9 w-9 place-items-center rounded-lg ${color.bg} ${color.text}`}>
        <Icon className="h-5 w-5" />
      </span>
      <div className="mt-2 text-sm font-medium text-muted-foreground">{label}</div>
      <div className="mt-auto truncate font-serif text-4xl font-black leading-none tracking-tight sm:text-5xl">
        {value === null ? "…" : <AnimatedNumber value={value} format={format} />}
      </div>
    </>
  );
  if (to) {
    return (
      <Link
        to={to}
        className="card-elev aspect-square flex flex-col p-5 transition-all hover:-translate-y-0.5 hover:bg-secondary/40 hover:shadow-elev"
        style={{ animationDelay: `${delayMs}ms` }}
      >
        {content}
      </Link>
    );
  }
  return (
    <div
      className="card-elev aspect-square flex flex-col p-5"
      style={{ animationDelay: `${delayMs}ms` }}
    >
      {content}
    </div>
  );
}

const PORTFOLIO_COLORS = [
  "var(--accent)",
  "var(--success)",
  "var(--warning)",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
];

// Each bar opens that property's AI report — the whole point of showing "which
// properties make up my portfolio" is to be able to jump straight into one, not
// just look at the chart. Bars get a pointer cursor and darken slightly on
// hover (native SVG :hover, no extra state needed) as the button affordance;
// the Y-axis address labels are real buttons too, for the same click target
// without needing to land precisely on a (sometimes short) bar.
function PortfolioValueChart({
  properties,
  onOpenReport,
}: {
  properties: PropertyRecord[];
  onOpenReport: (p: PropertyRecord) => void;
}) {
  const data = properties
    .filter((p) => p.totalValue != null)
    .sort((a, b) => (b.totalValue ?? 0) - (a.totalValue ?? 0))
    .slice(0, 8)
    .map((p) => ({
      id: p.id,
      name: p.address.length > 28 ? `${p.address.slice(0, 26)}…` : p.address,
      value: p.totalValue ?? 0,
      property: p,
    }));

  if (data.length === 0) {
    return <p className="mt-2 text-sm text-muted-foreground">Value data not available yet.</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={Math.max(120, data.length * 40)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 72, bottom: 4, left: 4 }}>
        <XAxis type="number" hide domain={[0, (max: number) => max * 1.2]} />
        <YAxis
          type="category"
          dataKey="name"
          width={160}
          tickLine={false}
          axisLine={false}
          tick={(props) => <PortfolioAxisTick {...props} data={data} onOpenReport={onOpenReport} />}
        />
        <Bar
          dataKey="value"
          radius={[0, 6, 6, 0]}
          barSize={22}
          cursor="pointer"
          onClick={(entry: (typeof data)[number]) => onOpenReport(entry.property)}
        >
          {data.map((_, i) => (
            <Cell
              key={i}
              fill={PORTFOLIO_COLORS[i % PORTFOLIO_COLORS.length]}
              className="transition-opacity hover:opacity-80"
            />
          ))}
          <LabelList
            dataKey="value"
            position="right"
            formatter={(v: number) => currency(v)}
            style={{ fontSize: 12, fontWeight: 600, fill: "var(--foreground)" }}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// Recharts' <YAxis tick> renders raw SVG, not HTML — a real <button> can't go
// here, so this renders a <text> that behaves like one (pointer cursor,
// underline-on-hover, click handler) using the same per-row property lookup
// the bars themselves use.
function PortfolioAxisTick(
  props: {
    x?: number;
    y?: number;
    payload?: { value: string };
  } & {
    data: { name: string; property: PropertyRecord }[];
    onOpenReport: (p: PropertyRecord) => void;
  },
) {
  const { x = 0, y = 0, payload, data, onOpenReport } = props;
  const row = data.find((d) => d.name === payload?.value);
  if (!row) return null;
  const lines = row.name.split(/(?<=,)\s+/);
  return (
    <text
      x={x}
      y={y}
      dy={4}
      textAnchor="end"
      fontSize={12}
      fill="var(--foreground)"
      cursor="pointer"
      className="hover:underline"
      onClick={() => onOpenReport(row.property)}
    >
      {lines.map((line, i) => (
        <tspan key={i} x={x} dy={i === 0 ? -((lines.length - 1) * 6) : 12}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

const STATUS_COLORS: Record<ProtestStatus, string> = {
  requested: "var(--muted-foreground)",
  filed: "var(--accent)",
  under_review: "var(--warning)",
  offer_received: "#f59e0b",
  hearing_scheduled: "#8b5cf6",
  decision_received: "#0ea5e9",
  appealing: "#ec4899",
  arbitrating: "#ec4899",
  resolved: "var(--success)",
};

function ProtestStatusChart({
  protests,
  addressFor,
}: {
  protests: ProtestRecord[];
  addressFor: (propertyId: string) => string;
}) {
  const counts = protests.reduce(
    (acc, p) => {
      acc[p.status] = (acc[p.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<ProtestStatus, number>,
  );
  const data = (Object.keys(STATUS_LABEL) as ProtestStatus[])
    .filter((s) => counts[s] > 0)
    .map((s) => ({ name: STATUS_LABEL[s], value: counts[s], status: s }));

  return (
    <>
      <div className="mt-3 grid grid-cols-[7rem_1fr] items-center gap-3">
        <ResponsiveContainer width="100%" height={110}>
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius={30}
              outerRadius={50}
              paddingAngle={2}
            >
              {data.map((d) => (
                <Cell key={d.status} fill={STATUS_COLORS[d.status]} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="grid gap-1.5">
          {data.map((d) => (
            <div key={d.status} className="flex items-center gap-2 text-sm">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: STATUS_COLORS[d.status] }}
              />
              <span className="flex-1">{d.name}</span>
              <span className="font-medium">{d.value}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-4 grid min-w-0 gap-2 border-t border-border pt-3">
        {protests.slice(0, 3).map((pr) => (
          <div key={pr.id} className="flex items-center justify-between gap-2 text-sm min-w-0">
            <span className="truncate min-w-0">{addressFor(pr.propertyId)}</span>
            <span className="badge-soft shrink-0">{STATUS_LABEL[pr.status]}</span>
          </div>
        ))}
      </div>
    </>
  );
}
