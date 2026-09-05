import { useEffect, useState } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { readIntake, classifyAndStoreDocument, type IntakeState } from "@/lib/intake-store";
import { useAuth } from "@/lib/auth";
import { listProtests, type ProtestRecord, type ProtestStatus } from "@/lib/protests";
import { listProperties, type PropertyRecord } from "@/lib/properties";
import { useFileDrop } from "@/hooks/use-file-drop";
import { ProtestAuthorizationFlow } from "@/components/ProtestAuthorizationFlow";

const STEP_LABELS = [
  "Start",
  "Identify County",
  "Find Property",
  "Upload Documents",
  "AI Review",
  "Choose Service",
  "Prepare Filing",
  "Submit",
  "Track",
  "Decision",
  "Savings",
] as const;

const TOTAL_STEPS = STEP_LABELS.length;

// Steps 6-11 used to render permanently locked ("coming soon") because the
// filing workflow they describe didn't exist yet. It does now — protests.status
// moves through this exact pipeline (advanced by CorvusPT staff via the admin
// panel), so those steps are driven by the signed-in user's real cases instead.
const STATUS_RANK: Record<ProtestStatus, number> = {
  requested: 1,
  filed: 2,
  under_review: 3,
  offer_received: 3,
  hearing_scheduled: 4,
  decision_received: 4,
  appealing: 4,
  arbitrating: 4,
  resolved: 5,
};

type Action = { label: string; to?: string; upload?: boolean; protestLaunch?: boolean };
type StepMessage = { title: string; actions?: Action[] };

// `state` reflects only the CURRENT browser session's intake flow, which resets
// every time a new property is started (resetIntake() on the homepage) — a
// returning user looking at an OLDER property (added in a past session, or a
// different one than whatever's currently mid-flow) would otherwise look like
// they'd regressed on steps that property already completed, since none of
// this session's state describes it. `assumeCompleteFallback` (true for any
// property that isn't the one this session's own state describes — see
// propertyMatchesIntakeState below) papers over that by treating steps 1-5 as
// already done. For the property THIS session's state actually IS about, the
// fallback must stay false — otherwise a property just added via a plain
// address search would still show "Upload Documents" checked off, which is
// exactly wrong: it didn't happen for this property, session or not.
// `skipped[i]` flags a step that's counted as done for progression purposes
// (it doesn't block moving on to later steps) but wasn't actually performed
// — currently only ever "Upload Documents," when the user chose "Continue to
// AI Review" instead. Kept separate from `done` so JourneyBlock can render
// it as bypassed (gray) rather than implying a document was really uploaded.
function computeIntakeSteps(
  state: IntakeState,
  assumeCompleteFallback: boolean,
): { done: boolean[]; skipped: boolean[] } {
  const hasStarted = !!(state.address || state.extraction || state.noticeFileName);
  const hasCounty = !!(state.cad || state.extraction?.county || state.extraction?.cadName);
  const hasProperty = !!(
    (state.accountNumber && state.ownerName) ||
    state.extraction?.accountNumber ||
    state.confirmed
  );
  const documentUploaded = !!(state.noticeFileName || state.extraction);
  // aiReviewReached also satisfies "Upload Documents" — upload is explicitly
  // optional (see case 3's message below), and a user who chose "Continue to
  // AI Review" instead has, by definition, moved past this step, even though
  // they never actually uploaded anything for documentUploaded to pick up.
  const hasDocument = documentUploaded || !!state.aiReviewReached;
  // Not flagged skipped under assumeCompleteFallback — that path means "a
  // different property, no real signal either way," not "we know this one
  // was bypassed," so it stays a plain done/green like every other step
  // assumeCompleteFallback covers.
  const documentSkipped = !documentUploaded && !!state.aiReviewReached && !assumeCompleteFallback;
  // extractionConfirmed only gets set by document-review.tsx's confirm step,
  // which a no-upload path never visits — aiReviewReached is what actually
  // fires for that path, once the user is really on /ai-report (see its own
  // comment in intake-store.ts). Without this, "AI Review" stayed stuck
  // incomplete forever for anyone who skipped the optional upload.
  const hasReview = !!(state.extractionConfirmed || state.aiReviewReached);
  const done = [hasStarted, hasCounty, hasProperty, hasDocument, hasReview].map(
    (d) => d || assumeCompleteFallback,
  );
  return { done, skipped: [false, false, false, documentSkipped, false] };
}

// True when the current browser session's in-progress intake state is
// actually ABOUT this specific saved property — i.e. it's the one the user
// just searched/confirmed, not some other property from an earlier session.
// Matched by CAD account number first (the real unique key), falling back to
// address when either side lacks one.
function propertyMatchesIntakeState(property: PropertyRecord, state: IntakeState): boolean {
  if (state.cad && state.accountNumber && property.cad && property.accountNumber) {
    return state.cad === property.cad && state.accountNumber === property.accountNumber;
  }
  if (state.address && property.address) {
    return state.address.trim().toLowerCase() === property.address.trim().toLowerCase();
  }
  return false;
}

function computeFilingSteps(rank: number): boolean[] {
  return [
    rank >= 1, // Choose Service — a protest has been requested
    rank >= 1, // Prepare Filing — same signal; nothing more granular than "requested" exists yet
    rank >= 2, // Submit — filed with the county
    rank >= 3, // Track — under county review
    rank >= 4, // Decision — hearing scheduled or a decision reached
    rank >= 5, // Savings — resolved
  ];
}

function getMessage(currentStep: number, allDone: boolean): StepMessage | null {
  if (allDone) {
    return {
      title: "Your case is resolved. Check your dashboard for the outcome and savings.",
      actions: [{ label: "View Dashboard", to: "/dashboard" }],
    };
  }
  switch (currentStep) {
    case 0:
      return {
        title: "Start by entering your property address or uploading your notice.",
        actions: [
          { label: "Enter Address", to: "/intake" },
          { label: "Upload Notice", upload: true },
        ],
      };
    case 1:
      return {
        title: "AI is identifying your county and CAD records.",
        actions: [{ label: "Edit Address", to: "/intake" }],
      };
    case 2:
      return {
        title: "AI needs a valid property address to find your CAD record.",
        actions: [{ label: "Edit Address", to: "/intake" }],
      };
    case 3:
      return {
        // Optional, not required — by this step the real address/CAD match
        // (steps 1-2) already gave the AI Report enough to run on; a
        // notice just adds real deadline/value detail on top of that. The
        // second action makes that an explicit choice instead of Upload
        // Notice looking like the only way to move forward.
        title:
          "Upload your appraisal notice (optional) so AI can extract deadlines and values — or continue straight to your AI Review.",
        actions: [
          { label: "Upload Notice", upload: true },
          { label: "Continue to AI Review", to: "/ai-report" },
        ],
      };
    case 4:
      return {
        title: "Review AI's extraction and confirm the details.",
        actions: [{ label: "Review Document", to: "/document-review" }],
      };
    case 5:
    case 6:
      return {
        title: "Ready to save on your property taxes? Choose a service to get started.",
        actions: [
          { label: "Protest My Property", to: "/property-protest", protestLaunch: true },
          { label: "File BPP Rendition", to: "/bpp-rendition" },
        ],
      };
    case 7:
      return { title: "CorvusPT staff is filing your protest with the county." };
    case 8:
      return {
        title: "Your protest has been filed. CorvusPT is tracking it for updates.",
        actions: [{ label: "View My Cases", to: "/dashboard" }],
      };
    case 9:
      return { title: "Your protest is under county review." };
    case 10:
      return { title: "Your hearing is scheduled. Awaiting the county's decision." };
    default:
      return null;
  }
}

export function JourneyTracker() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [state, setState] = useState<IntakeState>({ previewsUsed: [] });
  const [protests, setProtests] = useState<ProtestRecord[]>([]);
  const [properties, setProperties] = useState<PropertyRecord[]>([]);
  const [uploading, setUploading] = useState(false);
  const [page, setPage] = useState(0);
  const [authorizingProperty, setAuthorizingProperty] = useState<PropertyRecord | null>(null);
  // This component lives in __root.tsx, so it mounts once and persists across
  // every route change in the app — it never remounts just because the user
  // navigated from /intake (after adding a property) to /dashboard, so a plain
  // `useEffect(..., [user])` only ever fetched once per sign-in and then went
  // stale, requiring a manual page reload to see a newly-added property or a
  // freshly-loaded session's intake state. Re-running on every pathname change
  // (not just user identity) fixes that without needing a dedicated pub/sub
  // "something changed" event.
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    setState(readIntake());
  }, [pathname]);

  useEffect(() => {
    if (!user) return;
    listProtests(user.id)
      .then(setProtests)
      .catch((err) => console.error(err));
    listProperties(user.id)
      .then(setProperties)
      .catch((err) => console.error(err));
  }, [user, pathname]);

  async function onFile(f: File) {
    setUploading(true);
    try {
      await classifyAndStoreDocument(f);
      navigate({ to: "/document-review" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not read this document.");
      setUploading(false);
    }
  }

  const { isDragging, dropHandlers } = useFileDrop(onFile, uploading);

  // "/" and "/dashboard" each already have their own address/upload widget
  // built directly into the page — showing JourneyTracker's generic action
  // buttons there too duplicates the exact same action right next to itself.
  const suppressActions = pathname === "/" || pathname === "/dashboard";

  const hasSavedProperty = properties.length > 0;
  // Clamp rather than reset to 0 outright, so losing the last property on the
  // last page (e.g. it gets removed) lands on the new last page instead of
  // always yanking back to the first one.
  const currentPage = Math.min(page, Math.max(0, properties.length - 1));

  // Nobody has a saved property yet — one generic tracker driven purely by
  // whatever the current browser session's in-progress intake flow has done so
  // far, since there's no per-property case to show progress for.
  if (!hasSavedProperty) {
    const intake = computeIntakeSteps(state, false);
    return (
      <section className="card-elev p-6">
        <span className="badge-soft">Your Journey</span>
        <JourneyBlock
          steps={[...intake.done, false, false, false, false, false, false]}
          skippedSteps={[...intake.skipped, false, false, false, false, false, false]}
          uploading={uploading}
          onFile={onFile}
          isDragging={isDragging}
          dropHandlers={dropHandlers}
          suppressActions={suppressActions}
        />
      </section>
    );
  }

  // One box, one property's tracker at a time — each block is driven by that
  // specific property's own protest (if any), rather than blending every case
  // the user has into one bar. A property with no protest yet simply sits at
  // "Choose Service". Switch properties via the page numbers below instead of
  // stacking every property's tracker in one long scroll.
  const activeProperty = properties[currentPage];
  const activeProtest = protests.find((pr) => pr.propertyId === activeProperty.id);
  const activeRank = activeProtest ? STATUS_RANK[activeProtest.status] : 0;
  // Only trust this session's real intake signals (no document uploaded, no
  // county identified yet, etc.) when the session is actually ABOUT this
  // property. For any other property — added in an earlier session, or a
  // different one than whatever's currently mid-flow — assume steps 1-5 are
  // already done rather than showing it as having regressed.
  const intakeSteps = computeIntakeSteps(state, !propertyMatchesIntakeState(activeProperty, state));

  return (
    <section className="card-elev p-6">
      <span className="badge-soft">Your Journey</span>
      <JourneyBlock
        key={activeProperty.id}
        title={activeProperty.address}
        steps={[...intakeSteps.done, ...computeFilingSteps(activeRank)]}
        skippedSteps={[...intakeSteps.skipped, false, false, false, false, false, false]}
        uploading={uploading}
        onFile={onFile}
        isDragging={isDragging}
        dropHandlers={dropHandlers}
        suppressActions={suppressActions}
        onProtestClick={() => setAuthorizingProperty(activeProperty)}
      />
      {user && (
        <ProtestAuthorizationFlow
          userId={user.id}
          property={activeProperty}
          userEmail={user.email}
          open={!!authorizingProperty}
          onOpenChange={(open) => {
            if (!open) setAuthorizingProperty(null);
          }}
          onDone={(created) => {
            setProtests((prev) => [created, ...prev]);
            setAuthorizingProperty(null);
          }}
        />
      )}
      {properties.length > 1 && (
        <nav aria-label="Select property" className="mt-6 flex flex-wrap items-center gap-2">
          {properties.map((p, i) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPage(i)}
              aria-current={i === currentPage ? "page" : undefined}
              aria-label={p.address}
              title={p.address}
              className={`h-8 w-8 rounded-full text-xs font-semibold transition-colors ${
                i === currentPage
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-muted-foreground hover:text-foreground"
              }`}
            >
              {i + 1}
            </button>
          ))}
        </nav>
      )}
    </section>
  );
}

export function JourneyBlock({
  title,
  steps,
  skippedSteps,
  uploading,
  onFile,
  isDragging,
  dropHandlers,
  suppressActions,
  onProtestClick,
}: {
  title?: string;
  steps: boolean[];
  // Same length as `steps` — true for a step that counts as done for
  // progression (it doesn't block later steps) but wasn't actually performed
  // (see computeIntakeSteps' own comment on documentSkipped). Rendered as a
  // bypassed gray circle instead of a green one, so "I skipped this" doesn't
  // read as "I did this."
  skippedSteps?: boolean[];
  uploading: boolean;
  onFile: (file: File) => void;
  isDragging: boolean;
  dropHandlers: ReturnType<typeof useFileDrop>["dropHandlers"];
  suppressActions?: boolean;
  onProtestClick?: () => void;
}) {
  const completedCount = steps.filter(Boolean).length;
  const firstIncomplete = steps.findIndex((done) => !done);
  const allDone = firstIncomplete === -1;
  const currentStep = allDone ? TOTAL_STEPS - 1 : firstIncomplete;
  const progress = Math.round((completedCount / TOTAL_STEPS) * 100);
  const message = getMessage(currentStep, allDone);
  // suppressActions exists so "/" and "/dashboard" (which already have their
  // own address-entry/upload widget built into the page — see JourneyTracker's
  // own comment on suppressActions) don't show a second, redundant "Enter
  // Address"/"Upload Notice" right next to it. It was being applied to EVERY
  // action on those pages, though, which also hid actions nothing on the
  // page duplicates — "Protest My Property"/"File BPP Rendition" at Choose
  // Service, "Review Document", "View My Cases" — leaving a real actionable
  // step with no way to actually act on it. Only filter out the two action
  // kinds that are genuinely duplicated; everything else stays visible.
  const visibleActions =
    message?.actions?.filter((a) => !suppressActions || (!a.upload && a.to !== "/intake")) ?? [];

  return (
    <div className="mt-3">
      <div className="flex items-start justify-between flex-wrap gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="font-serif text-xl font-semibold">
            {allDone
              ? "All steps complete"
              : `Step ${currentStep + 1} of ${TOTAL_STEPS}: ${STEP_LABELS[currentStep]}`}
          </h2>
          {title && <p className="text-sm text-muted-foreground">{title}</p>}
        </div>
        <div className="text-right shrink-0">
          <div className="text-xs text-muted-foreground">Progress</div>
          <div className="text-lg font-semibold text-success">{progress}%</div>
        </div>
      </div>

      <ol className="mt-5 flex items-start overflow-x-auto pb-1">
        {STEP_LABELS.flatMap((label, i) => {
          const done = steps[i];
          const skipped = !!skippedSteps?.[i];
          const active = i === currentStep && !allDone;
          const circle = (
            <li key={label} className="flex items-center shrink-0">
              <div className="relative flex flex-col items-center gap-1 w-[72px]">
                {/* Points at whichever step is actually current — moves on
                    its own as `active` shifts to a later step, since it's
                    just this same per-step render checking the same
                    `active` flag the circle's own color already uses. */}
                {active && (
                  <ChevronDown
                    aria-hidden="true"
                    strokeWidth={3}
                    className="absolute -top-4 h-4 w-4 text-primary motion-safe:animate-bounce"
                  />
                )}
                <span
                  className={`h-8 w-8 rounded-full grid place-items-center text-xs font-semibold ${
                    skipped
                      ? "bg-secondary text-muted-foreground"
                      : done
                        ? "bg-success text-success-foreground"
                        : active
                          ? "bg-primary text-primary-foreground"
                          : "bg-secondary text-muted-foreground"
                  }`}
                >
                  {i + 1}
                </span>
                <span
                  className={`text-[11px] text-center leading-tight ${
                    active ? "text-foreground font-medium" : "text-muted-foreground"
                  }`}
                >
                  {label}
                  {skipped && " (skipped)"}
                </span>
              </div>
            </li>
          );
          if (i === TOTAL_STEPS - 1) return [circle];
          // A separate, flex-growing list item rather than a fixed-width
          // span nested inside the circle's own li — on a wide card
          // (matching the property list's width, see SignedInJourney in
          // __root.tsx) a fixed w-4 connector left a big empty gap between
          // the last step and the card's right edge instead of spreading
          // the 11 steps across the full width. min-w-[8px] plus the row's
          // own overflow-x-auto keeps this from crushing to nothing on a
          // narrow/mobile card instead — it scrolls there, same as before.
          // Colored (not flat gray) for any stretch the user has actually
          // completed — the track itself now reads as a filling progress
          // bar rather than a plain divider between circles. Not colored
          // for a skipped step, same reasoning as its own circle above.
          const connector = (
            <li
              key={`${label}-connector`}
              aria-hidden="true"
              className="flex flex-1 min-w-[8px] items-center"
            >
              <span
                className={`mt-4 h-px w-full ${done && !skipped ? "bg-success" : "bg-border"}`}
              />
            </li>
          );
          return [circle, connector];
        })}
      </ol>

      {message && (
        <div className="mt-5 rounded-lg border border-accent/30 bg-accent/5 p-4">
          <p className="text-sm font-medium">{message.title}</p>
          {visibleActions.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {visibleActions.map((a) =>
                a.protestLaunch && onProtestClick ? (
                  <button
                    key={a.label}
                    type="button"
                    onClick={onProtestClick}
                    className="btn-outline text-sm py-2"
                  >
                    {a.label}
                  </button>
                ) : a.upload ? (
                  <label
                    key={a.label}
                    className={`btn-primary btn-primary-hover text-sm py-2 cursor-pointer ${
                      isDragging ? "ring-2 ring-accent" : ""
                    }`}
                    {...dropHandlers}
                  >
                    <input
                      type="file"
                      className="hidden"
                      accept=".pdf,image/*"
                      disabled={uploading}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) onFile(f);
                      }}
                    />
                    {isDragging ? "Drop to upload" : uploading ? "Reading document…" : a.label}
                  </label>
                ) : (
                  <Link key={a.label} to={a.to!} className="btn-outline text-sm py-2">
                    {a.label}
                  </Link>
                ),
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
