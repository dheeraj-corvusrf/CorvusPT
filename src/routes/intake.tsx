import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, Check, MapPin, ExternalLink } from "lucide-react";
import { AnimatedSteps } from "@/components/AnimatedSteps";
import { CircularSearchLoader } from "@/components/CircularSearchLoader";
import { ValueHistorySection } from "@/components/ValueHistorySection";
import { MapPinPicker } from "@/components/MapPinPicker";
import {
  getCadRecordUrl,
  isDirectCadRecordUrl,
  SUPPORTED_COUNTY_NAMES,
  CAD_SEARCH_HOMEPAGE,
} from "@/lib/cad-record-url";
import { Modal } from "@/components/Modal";
import {
  readIntake,
  updateIntake,
  classifyAndStoreDocument,
  currency,
  UPLOAD_LIMITS,
  type IntakeState,
  type PropertyKind,
} from "@/lib/intake-store";
import { cadLookup, cadLookupByAccount, type CadRecord } from "@/lib/cad-lookup";
import { classifyPropertyCategory } from "@/lib/texas-tax-rates";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import { useAuth } from "@/lib/auth";
import { addProperty, findExistingProperty, type PropertyRecord } from "@/lib/properties";
import { estimateSavings, type SavingsEstimate } from "@/lib/savings-estimate";
import { SampleNoticeDialog } from "@/components/SampleNoticeDialog";
import { HouseIllustration } from "@/assets/illustrations/house";
import { useFileDrop } from "@/hooks/use-file-drop";

export const Route = createFileRoute("/intake")({
  head: () => ({
    meta: [
      { title: "Property Intake — CorvusPT" },
      {
        name: "description",
        content:
          "Validate your Texas commercial or residential property and start your free AI review.",
      },
      { property: "og:title", content: "Property Intake" },
      { property: "og:description", content: "Address, notice, and CAD validation." },
    ],
  }),
  component: Intake,
});

type Step =
  | "address"
  | "validating"
  | "notice"
  | "savings"
  | "confirm"
  | "notfound"
  | "multiple"
  | "classifying"
  | "residential-blocked";

// Only called after cadLookup() itself already returned matched:false —
// cadLookup has no way to say WHY (a genuinely unsupported county vs. a
// supported county with no record for this exact address look identical to
// it, since it just tries all 12 supported counties' data and finds
// nothing). This is a separate, independent check: reverse-geocode the
// typed address via Nominatim (same public API AddressAutocomplete.tsx
// already calls) to find its real county, then compare that against
// SUPPORTED_COUNTY_NAMES. Best-effort only — a network failure or an
// address Nominatim can't resolve just means no popup, not an error the
// user sees; the existing "notfound" card is the honest fallback either way.
async function resolveCountyName(address: string): Promise<string | null> {
  try {
    const params = new URLSearchParams({
      format: "jsonv2",
      addressdetails: "1",
      countrycodes: "us",
      q: address,
      limit: "1",
    });
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{ address?: { county?: string } }>;
    const county = data[0]?.address?.county;
    return county ? county.replace(/\s*County$/i, "").trim() : null;
  } catch {
    return null;
  }
}

function Intake() {
  const nav = useNavigate();
  const { user } = useAuth();
  const [state, setState] = useState<IntakeState>({ previewsUsed: [] });
  const [step, setStep] = useState<Step>("address");
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  // True for the ~1-2s window after picking a Google suggestion, while its
  // Place Details follow-up call is upgrading the provisional (sometimes
  // mid-word-abbreviated, e.g. "Market Pl Blvd" vs the real "Market Place
  // Boulevard") value to the real address CAD lookup needs. Blocks
  // "Validate address" during that window — without it, a fast click-through
  // right after selecting submits the still-provisional text and produces
  // the same false "couldn't locate this property" as the abbreviation bug
  // itself, just reachable through timing instead of every time.
  const [resolvingAddress, setResolvingAddress] = useState(false);
  const [pickingOnMap, setPickingOnMap] = useState(false);
  const [propertyKind, setPropertyKind] = useState<PropertyKind>("commercial");
  const [noticeName, setNoticeName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [alreadySaved, setAlreadySaved] = useState<PropertyRecord | null>(null);
  const [nearby, setNearby] = useState<CadRecord[]>([]);
  // Populated when cad-lookup finds more than one real, distinct CAD account
  // at the exact same address (see cad-lookup.ts's "multiple" result) —
  // e.g. a day care and a strip center on adjacent lots sharing one civic
  // address, each with a completely different legal owner. Never silently
  // guessed; the user picks which one via the "multiple" step below.
  const [multipleOptions, setMultipleOptions] = useState<CadRecord[]>([]);
  // Set only when a "notfound" address independently resolves (via
  // resolveCountyName in runValidation) to a real Texas county that isn't
  // one of the 12 this app covers — pops the modal below on top of the
  // existing "notfound" card, distinguishing "we don't cover this county at
  // all" from "supported county, just no record for this exact address."
  const [unsupportedCounty, setUnsupportedCounty] = useState<string | null>(null);
  // Bumped on every new lookup and by cancelValidation() — an in-flight
  // request checks this before ever touching state, so hitting Cancel (or
  // starting a second search) can't have a stale response silently repaint
  // the screen out from under whatever the user is looking at now.
  const requestIdRef = useRef(0);
  // See estimateSavings() for the comps -> AI -> baseline cascade. null only
  // means we don't even have an assessed value to estimate from yet (the
  // savings step is skipped straight to confirm in that case).
  const [savings, setSavings] = useState<SavingsEstimate>(null);
  // "Didn't find your property?" fallback on the notfound step — a direct
  // account/parcel-number lookup for one named county, bypassing address
  // matching entirely. See queryByAccountNumber's own comment in the edge
  // function for why this exists (a real, common case: a bare-road
  // commercial address with no house number in the county's own data has
  // several unrelated real accounts, none of which may be the right one).
  const [manualLookupOpen, setManualLookupOpen] = useState(false);
  const [manualLookupCad, setManualLookupCad] = useState("");
  const [manualLookupAccount, setManualLookupAccount] = useState("");
  const [manualLookupError, setManualLookupError] = useState<string | null>(null);
  const [manualLookupLoading, setManualLookupLoading] = useState(false);

  useEffect(() => {
    const s = readIntake();
    setState(s);
    if (s.propertyKind) setPropertyKind(s.propertyKind);
    // Only resume straight into validation for an in-progress intake (address
    // set, not yet confirmed). Once a property has already been confirmed and
    // saved, a fresh visit to /intake should start a new search — otherwise the
    // page silently jumps to the old Confirm step on every revisit, hiding the
    // commercial/residential toggle (which only renders on the address step)
    // behind an "Edit Address" click the user has no reason to expect.
    if (s.address && !s.confirmed) {
      setAddress(s.address);
      runValidation(s.address);
    }
  }, []);

  // Shared by a real cadLookup() match and by picking one of the "nearby"
  // suggestions on the notfound step (which already has a full real CadRecord
  // in hand — no reason to make a second network round-trip for the same data).
  async function applyCadRecord(record: CadRecord, requestId: number) {
    // The commercial/residential toggle above is just the user's own guess
    // — the CAD record is authoritative. Block here too (not just at the
    // toggle) since someone can still reach this page with an address that
    // turns out to be a true single-family home the county itself codes as
    // residential (state code "A"/"C1" or descriptive text like "Single
    // Family") — classifyPropertyCategory() already does this exact
    // classification for the savings-estimate formula tier, so reuse it
    // rather than inventing a second, possibly-inconsistent check.
    if (requestIdRef.current !== requestId) return;
    if (classifyPropertyCategory(record.propertyType) === "residential") {
      setState(
        updateIntake({
          address: record.propertyAddress,
          cad: record.cad,
          propertyType: record.propertyType ?? undefined,
        }),
      );
      setStep("residential-blocked");
      return;
    }
    const next = updateIntake({
      address: record.propertyAddress,
      cad: record.cad,
      accountNumber: record.accountNumber ?? undefined,
      ownerName: record.ownerName ?? undefined,
      propertyType: record.propertyType ?? undefined,
      landValue: record.landValue ?? undefined,
      improvementValue: record.improvementValue ?? undefined,
      totalValue: record.totalValue ?? undefined,
      taxYear: record.taxYear ?? undefined,
      legalDescription: record.legalDescription ?? undefined,
      subdivision: record.subdivision ?? undefined,
      geoId: record.geoId ?? undefined,
      mailingAddress: record.mailingAddress ?? undefined,
      ownershipPct: record.ownershipPct ?? undefined,
      protestStatus: record.protestStatus ?? undefined,
      bisPropertyId: record.bisPropertyId ?? undefined,
      valueHistory: record.valueHistory ?? undefined,
      deeds: record.deeds ?? undefined,
    });
    setState(next);

    // See estimateSavings() for the comps -> formula cascade — both tiers are
    // fully deterministic (no AI call), so the same property always produces
    // the same number. Only null (no assessed value at all) skips the
    // savings step straight to confirm.
    //
    // Still cached against this exact property (cad+accountNumber, or
    // address when no account number exists) so refreshing the page or
    // re-validating the same address mid-intake reuses the prior result
    // instead of re-running the comps lookup for nothing — a performance
    // nicety now, not a correctness requirement, since the estimate would
    // come out identical either way.
    const savingsKey =
      next.cad && next.accountNumber ? `${next.cad}::${next.accountNumber}` : next.address;
    let nextSavings: SavingsEstimate;
    if (savingsKey && next.cachedSavingsKey === savingsKey && next.cachedSavings !== undefined) {
      nextSavings = next.cachedSavings;
    } else {
      nextSavings = await estimateSavings({
        cad: next.cad,
        accountNumber: next.accountNumber,
        address: next.address,
        propertyType: next.propertyType,
        landValue: next.landValue,
        improvementValue: next.improvementValue,
        totalValue: next.totalValue,
        taxYear: next.taxYear,
        valueHistory: next.valueHistory,
      });
      updateIntake({ cachedSavings: nextSavings, cachedSavingsKey: savingsKey });
    }
    if (requestIdRef.current !== requestId) return;
    setSavings(nextSavings);
    setStep(nextSavings ? "savings" : "confirm");
    // Check whether this exact CAD record is already on the user's account —
    // shown as a notice on the confirm screen instead of letting them hit
    // "Confirm Property" again for something already saved.
    if (user && next.address) {
      findExistingProperty(user.id, {
        address: next.address,
        cad: next.cad,
        accountNumber: next.accountNumber,
      })
        .then(setAlreadySaved)
        .catch((err) => console.error(err));
    }
  }

  async function runValidation(addr: string) {
    const requestId = ++requestIdRef.current;
    setStep("validating");
    setError(null);
    setAlreadySaved(null);
    setNearby([]);
    setMultipleOptions([]);
    setUnsupportedCounty(null);
    try {
      const res = await cadLookup(addr);
      if (requestIdRef.current !== requestId) return;
      if (res.matched === "multiple") {
        setMultipleOptions(res.options);
        setStep("multiple");
        return;
      }
      if (!res.matched) {
        setNearby(res.nearby);
        setStep("notfound");
        // Fired after the inline "notfound" card is already showing, not
        // awaited before it — this is a genuinely separate question ("was
        // this address even in a county we cover?"), and the existing card
        // is the correct fallback regardless of how this resolves or how
        // long it takes.
        resolveCountyName(addr).then((county) => {
          if (requestIdRef.current !== requestId) return;
          if (county && !SUPPORTED_COUNTY_NAMES.has(county)) setUnsupportedCounty(county);
        });
        return;
      }
      await applyCadRecord(res.record, requestId);
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      console.error(err);
      const message =
        err instanceof Error ? err.message : "Could not look up this property. Please try again.";
      toast.error(message);
      setStep("address");
    }
  }

  // Shared by picking one of the "nearby" suggestions and one of the
  // "multiple accounts at this address" options — both already have a full
  // real CadRecord in hand, so this just applies it directly with no second
  // network round-trip. `fallbackStep` is where a failure sends the user
  // back to (each list only exists within its own step).
  async function selectCadCandidate(record: CadRecord, fallbackStep: "notfound" | "multiple") {
    const requestId = ++requestIdRef.current;
    setStep("validating");
    setError(null);
    setAlreadySaved(null);
    try {
      await applyCadRecord(record, requestId);
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      console.error(err);
      const message =
        err instanceof Error ? err.message : "Could not use this property. Please try again.";
      toast.error(message);
      setStep(fallbackStep);
    }
  }

  // "Didn't find your property?" fallback — a direct account/parcel-number
  // lookup for one named county, entirely separate from the address-search
  // request cad-lookup's queryByAccountNumber handles it with no address
  // parsing at all. The account-number-not-found case stays ON the modal
  // (an error the user can immediately see and correct without losing their
  // place) — but once a real record comes back, applyCadRecord's own
  // failure needs the SAME fallback selectCadCandidate uses (back to
  // "notfound", not an invisible error inside an already-closed modal).
  async function runManualLookup() {
    if (!manualLookupCad || !manualLookupAccount.trim()) return;
    const requestId = ++requestIdRef.current;
    setManualLookupLoading(true);
    setManualLookupError(null);
    let record: CadRecord | null;
    try {
      record = await cadLookupByAccount(manualLookupCad, manualLookupAccount.trim());
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      console.error(err);
      setManualLookupError(
        err instanceof Error ? err.message : "Could not look up that account number right now.",
      );
      setManualLookupLoading(false);
      return;
    }
    if (requestIdRef.current !== requestId) return;
    setManualLookupLoading(false);
    if (!record) {
      setManualLookupError(
        `No property found with that account number at ${manualLookupCad}. Double-check the number and county, then try again.`,
      );
      return;
    }
    setManualLookupOpen(false);
    setManualLookupAccount("");
    setStep("validating");
    try {
      await applyCadRecord(record, requestId);
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      console.error(err);
      const message =
        err instanceof Error ? err.message : "Could not use this property. Please try again.";
      toast.error(message);
      setStep("notfound");
    }
  }

  // Bails out of an in-flight lookup — invalidates it (see requestIdRef
  // above) so its eventual response can never repaint the screen after the
  // user has already left, and returns straight to an editable address field
  // rather than the notfound/residential-blocked dead ends.
  function cancelValidation() {
    requestIdRef.current++;
    setStep("address");
  }

  async function onFile(f: File) {
    setError(null);
    setNoticeName(f.name);
    setStep("classifying");

    try {
      await classifyAndStoreDocument(f);
      nav({ to: "/document-review" });
    } catch (err) {
      console.error(err);
      const message =
        err instanceof Error
          ? err.message
          : "Could not read this document. Please enter the property address above instead.";
      setError(message);
      toast.error(message);
      setStep("address");
    }
  }

  const { isDragging, dropHandlers } = useFileDrop(onFile);

  // Real link to this property's official county record, shown right on the
  // main single-match confirm screen below — previously this was only
  // reachable from the "multiple accounts found" step, so a normal search
  // (the vast majority of them) never surfaced it at all. state.cad is
  // optional (still unset before a real match resolves), unlike
  // CadRecord.cad's required string — guarded here rather than widening
  // that shared type just for this one optional-at-first caller.
  const confirmCadRecordUrl = state.cad
    ? getCadRecordUrl({
        cad: state.cad,
        accountNumber: state.accountNumber ?? null,
        bisPropertyId: state.bisPropertyId,
      })
    : null;

  return (
    <div className={`container-page py-12 ${step === "confirm" ? "max-w-5xl" : "max-w-3xl"}`}>
      <Stepper step={step} />

      {manualLookupOpen && (
        <Modal
          onClose={() => {
            setManualLookupOpen(false);
            setManualLookupError(null);
          }}
        >
          <h2 className="font-serif text-xl font-semibold">Look up by account number</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Enter the account or parcel number from your appraisal notice and pick which county it's
            in — we'll pull that exact record directly, no address needed.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              runManualLookup();
            }}
            className="mt-4 grid gap-3"
          >
            <label className="grid gap-1 text-sm">
              <span className="font-medium">
                County / CAD<span className="text-destructive"> *</span>
              </span>
              <select
                value={manualLookupCad}
                onChange={(e) => setManualLookupCad(e.target.value)}
                required
                className="rounded-md border border-input bg-background px-3 py-2"
              >
                <option value="" disabled>
                  Select a county…
                </option>
                {[...Object.keys(CAD_SEARCH_HOMEPAGE)].sort().map((cad) => (
                  <option key={cad} value={cad}>
                    {cad}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium">
                Account / parcel number<span className="text-destructive"> *</span>
              </span>
              <input
                value={manualLookupAccount}
                onChange={(e) => setManualLookupAccount(e.target.value)}
                placeholder="e.g. 1340123"
                required
                className="rounded-md border border-input bg-background px-3 py-2"
              />
            </label>
            {manualLookupError && <p className="text-sm text-destructive">{manualLookupError}</p>}
            <button
              type="submit"
              disabled={manualLookupLoading}
              className="btn-primary btn-primary-hover mt-1 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {manualLookupLoading ? "Looking up…" : "Find my property"}
            </button>
          </form>
        </Modal>
      )}

      {unsupportedCounty && (
        <Modal onClose={() => setUnsupportedCounty(null)}>
          <h2 className="font-serif text-xl font-semibold">
            We don't cover {unsupportedCounty} County yet
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            CorvusPT currently supports properties in{" "}
            {[...SUPPORTED_COUNTY_NAMES].slice(0, -1).join(", ")}, and{" "}
            {[...SUPPORTED_COUNTY_NAMES].slice(-1)} counties. We're adding more counties over time —
            try a different address, or check back soon.
          </p>
          <button
            onClick={() => setUnsupportedCounty(null)}
            className="btn-primary btn-primary-hover mt-5"
          >
            Got it
          </button>
        </Modal>
      )}

      {step === "address" && (
        <section className="mt-8 card-elev p-6">
          <h1 className="font-serif text-2xl font-semibold capitalize">
            Enter your {propertyKind} property.
          </h1>
          <p className="mt-1 text-muted-foreground">
            Enter an address, or upload your Texas appraisal notice.
          </p>

          <div className="mt-4 inline-flex rounded-full border border-border bg-secondary/40 p-1">
            {(["commercial", "residential"] as const).map((kind) =>
              kind === "residential" ? (
                <button
                  key={kind}
                  type="button"
                  disabled
                  title="Residential — coming soon"
                  className="rounded-full px-3 py-1 text-xs font-medium capitalize text-muted-foreground/40 cursor-not-allowed"
                >
                  {kind}
                </button>
              ) : (
                <button
                  key={kind}
                  type="button"
                  onClick={() => {
                    setPropertyKind(kind);
                    updateIntake({ propertyKind: kind });
                  }}
                  className={`rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors ${
                    propertyKind === kind
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {kind}
                </button>
              ),
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!address.trim() || resolvingAddress) return;
              updateIntake({ address: address.trim(), propertyKind });
              runValidation(address.trim());
            }}
            className="mt-5 grid gap-2 sm:grid-cols-[1fr_auto]"
          >
            <AddressAutocomplete
              value={address}
              onChange={setAddress}
              onResolving={setResolvingAddress}
              // Picking a suggestion directly validates — no separate click on
              // "Validate address" needed. Takes the address as a parameter
              // (not read from `address` state) since onPlaceSelected already
              // hands over the final, fully-resolved value.
              onPlaceSelected={(addr) => {
                updateIntake({ address: addr, propertyKind });
                runValidation(addr);
              }}
              placeholder="e.g. 500 Main St, Houston, TX 77002"
              className="rounded-md border border-input bg-background px-4 py-3"
            />
            <button
              type="submit"
              disabled={resolvingAddress}
              className="btn-primary btn-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              {resolvingAddress ? "Resolving…" : "Validate address"}
            </button>
          </form>

          <div className="mt-3 text-center">
            <button
              type="button"
              onClick={() => setPickingOnMap(true)}
              className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline"
            >
              <MapPin className="h-3.5 w-3.5" />
              Don't know the exact address? Pin it on the map instead.
            </button>
          </div>

          <div
            className={`mt-6 rounded-lg border border-dashed p-5 text-center transition-colors ${
              isDragging ? "border-accent bg-accent/5" : "border-border"
            }`}
            {...dropHandlers}
          >
            <p className="text-sm font-medium">
              {isDragging ? "Drop to upload" : "Have your appraisal notice?"}
            </p>
            <p className="text-xs text-muted-foreground">
              PDF / PNG / JPG, up to {Math.round(UPLOAD_LIMITS.maxFileBytes / (1024 * 1024))} MB, up
              to {UPLOAD_LIMITS.maxPages} pages.
            </p>
            <label className="mt-3 btn-outline cursor-pointer inline-flex">
              <input
                type="file"
                className="hidden"
                accept=".pdf,image/*"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onFile(f);
                }}
              />
              Upload Appraisal Notice
            </label>
            <p className="mt-2 text-xs text-muted-foreground">
              <SampleNoticeDialog />
            </p>
            {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
            {noticeName && (
              <p className="mt-2 text-xs text-muted-foreground">Selected: {noticeName}</p>
            )}
          </div>
        </section>
      )}

      {step === "validating" && (
        <section className="mt-8 card-elev p-10 text-center relative">
          <button
            type="button"
            onClick={cancelValidation}
            className="btn-outline absolute left-4 top-4 gap-1.5 text-xs py-1.5"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Cancel
          </button>
          <CircularSearchLoader className="h-48 w-48 mx-auto" />
          <h2 className="mt-6 font-serif text-2xl font-semibold">Searching for your property…</h2>
          {address && <p className="mt-2 text-muted-foreground">{address}</p>}
        </section>
      )}

      {step === "classifying" && (
        <section className="mt-8 card-elev p-6">
          <h2 className="font-serif text-xl font-semibold">AI is reading your document…</h2>
          <AnimatedSteps
            steps={[
              { label: "OCR & text extraction", status: "done" },
              { label: "Classifying document type", status: "active" },
              { label: "Extracting owner, values, and deadlines", status: "active" },
            ]}
          />
          <p className="mt-4 text-xs text-muted-foreground">
            This usually takes a few seconds. Do not close this tab.
          </p>
        </section>
      )}

      {step === "notfound" && (
        <section className="mt-8 card-elev p-6">
          <h2 className="font-serif text-xl font-semibold capitalize">
            We couldn't locate this {propertyKind} property.
          </h2>
          <p className="mt-1 text-muted-foreground">
            Please enter a valid property address, or upload your appraisal notice instead.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button onClick={() => setStep("address")} className="btn-outline">
              Edit Address
            </button>
            <button onClick={() => setStep("address")} className="btn-primary btn-primary-hover">
              Search Again
            </button>
            <button type="button" onClick={() => setManualLookupOpen(true)} className="btn-outline">
              Didn't find your property? Enter account number
            </button>
          </div>

          {nearby.length > 0 && (
            <div className="mt-6 border-t border-border pt-5">
              <h3 className="text-sm font-semibold">
                We didn't find that exact address, but found these nearby:
              </h3>
              <div className="mt-3 grid gap-2">
                {nearby.map((r, i) => {
                  // The county's own record is authoritative, same check
                  // applyCadRecord() itself makes — this app only serves
                  // commercial properties, so a residential one is shown but
                  // disabled rather than left clickable into a dead end.
                  const category = classifyPropertyCategory(r.propertyType);
                  const isResidential = category === "residential";
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => !isResidential && selectCadCandidate(r, "notfound")}
                      disabled={isResidential}
                      title={
                        isResidential
                          ? "Residential — CorvusPT currently serves commercial properties only"
                          : undefined
                      }
                      className={`row-hover flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-left ${
                        isResidential ? "opacity-50 grayscale cursor-not-allowed" : ""
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">{r.propertyAddress}</div>
                        <div className="text-xs text-muted-foreground">
                          {r.cad}
                          {r.accountNumber && <> · Acct {r.accountNumber}</>}
                          {r.totalValue != null && <> · Assessed {currency(r.totalValue)}</>}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${
                            isResidential
                              ? "bg-secondary text-muted-foreground"
                              : category === "commercial"
                                ? "badge-soft"
                                : "bg-secondary text-muted-foreground"
                          }`}
                        >
                          {category === "unknown" ? "Type unknown" : category}
                        </span>
                        {!isResidential && (
                          <span className="text-sm font-semibold text-accent">Check this →</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      )}

      {step === "multiple" && (
        <section className="mt-8 card-elev p-6">
          <h2 className="font-serif text-xl font-semibold">
            We found more than one property at this address.
          </h2>
          <p className="mt-1 text-muted-foreground">
            This address covers multiple separate CAD accounts, each with its own owner. Pick the
            one you want to protest.
          </p>
          <div className="mt-4">
            <button onClick={() => setStep("address")} className="btn-outline">
              Edit Address
            </button>
          </div>

          <div className="mt-6 grid gap-3 border-t border-border pt-5">
            {multipleOptions.map((r, i) => {
              // Same commercial-only gate as the "nearby" list — the county
              // record is authoritative, so a residential account is shown
              // (for transparency: the user should still see it exists) but
              // disabled rather than left clickable into a dead end.
              const category = classifyPropertyCategory(r.propertyType);
              const isResidential = category === "residential";
              const recordUrl = getCadRecordUrl(r);
              return (
                <div
                  key={i}
                  className={`rounded-lg border border-border p-4 ${isResidential ? "opacity-50 grayscale" : ""}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      {/* Owner name first and bold — it's the actual
                          disambiguator a user needs (e.g. "PINNACLE
                          MONTESSORI..." vs. "AVIGHNA HOLDINGS...", two real
                          different owners at one shared civic address). */}
                      <div className="text-sm font-semibold">{r.ownerName ?? "Owner unknown"}</div>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">
                        {r.propertyAddress}
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        {r.accountNumber && <span>Account #{r.accountNumber}</span>}
                        {r.propertyType && <span className="capitalize">{r.propertyType}</span>}
                        {r.totalValue != null && <span>Assessed {currency(r.totalValue)}</span>}
                      </div>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${
                        isResidential
                          ? "bg-secondary text-muted-foreground"
                          : category === "commercial"
                            ? "badge-soft"
                            : "bg-secondary text-muted-foreground"
                      }`}
                    >
                      {category === "unknown" ? "Type unknown" : category}
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => !isResidential && selectCadCandidate(r, "multiple")}
                      disabled={isResidential}
                      title={
                        isResidential
                          ? "Residential — CorvusPT currently serves commercial properties only"
                          : undefined
                      }
                      className="btn-primary btn-primary-hover text-sm py-1.5 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Select This Property
                    </button>
                    {recordUrl && (
                      <a
                        href={recordUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn-outline inline-flex items-center gap-1.5 text-sm py-1.5"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        {isDirectCadRecordUrl(r.cad)
                          ? "View Official CAD Record"
                          : `Search on ${r.cad}`}
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {step === "residential-blocked" && (
        <section className="mt-8 card-elev p-6">
          <h2 className="font-serif text-xl font-semibold">This is a residential property.</h2>
          <p className="mt-1 text-muted-foreground">
            The county's own records classify {state.address ?? "this address"} as residential
            {state.propertyType ? ` (${state.propertyType})` : ""}. CorvusPT currently serves
            commercial properties only.
          </p>
          <div className="mt-4 flex gap-2">
            <button onClick={() => setStep("address")} className="btn-outline">
              Search a Different Address
            </button>
          </div>
        </section>
      )}

      {step === "savings" && state.address && savings && (
        <section className="mt-8 card-elev overflow-hidden">
          <div className="bg-accent/10 px-6 pt-10 pb-8 text-center">
            {/* >= 1, not > 0 — currency() rounds to whole dollars, so a
                positive-but-sub-$1 amount would otherwise slip past this
                check and still render as a bare "$0" under "Potential
                Protest Savings," the exact confusing state this branch
                exists to avoid. In practice that only happens when
                totalValue itself is far too small to be a real commercial
                assessed value (a live example: a county's own ArcGIS feed
                briefly reading $0 for a genuinely ~$2.4M property before
                its current-year values synced — see queryWilliamson's
                enrichWilliamson fallback in cad-lookup for the real fix on
                that source), so this is a display-side safety net, not the
                actual fix for a broken source. */}
            {savings.amount >= 1 ? (
              <>
                <p className="text-sm font-medium text-muted-foreground">
                  Potential Protest Savings*
                </p>
                <p className="mt-1 font-serif text-5xl font-bold text-accent">
                  {currency(savings.amount)}
                </p>
              </>
            ) : (
              // A real analysis that lands on $0 isn't a failure — it means
              // this property's own assessed value already looks in line
              // with real comps/protest-outcome data for its county and
              // category. Framed as the finding it actually is, not shown
              // as a bare "$0" that reads like something broke.
              <>
                <p className="font-serif text-2xl font-bold text-success">Good news!</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  Your property appears to be fairly assessed. We found little or no opportunity for
                  additional tax savings this year.
                </p>
              </>
            )}
            <p className="mt-2 text-sm text-muted-foreground">{state.address}</p>
            {state.accountNumber && (
              <p className="text-xs font-medium text-muted-foreground">
                PARCEL: {state.accountNumber}
              </p>
            )}

            {/* The savings figure alone doesn't answer "how much do I actually
                pay" — these two ground it in real dollars: what the county's
                current assessed value implies you owe this year, and what
                that would drop to if the protest succeeds. Same effective tax
                rate savings.amount was computed with, just applied to the
                full assessed value instead of only the contested portion. */}
            <div className="mx-auto mt-6 grid max-w-sm grid-cols-2 gap-4 border-t border-accent/20 pt-6">
              <div>
                <div className="text-xs text-muted-foreground">Est. Tax Bill This Year</div>
                <div className="mt-0.5 font-serif text-xl font-semibold">
                  {currency((state.totalValue ?? 0) * (savings.effectiveTaxRatePct / 100))}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Est. Bill After Protest</div>
                <div className="mt-0.5 font-serif text-xl font-semibold text-success">
                  {currency(
                    (state.totalValue ?? 0) * (savings.effectiveTaxRatePct / 100) - savings.amount,
                  )}
                </div>
              </div>
            </div>

            <HouseIllustration className="mx-auto mt-6 h-32 w-auto" />
          </div>
          <div className="p-6">
            {savings.basis === "comps" && (
              <div className="mb-5 grid gap-3 sm:grid-cols-2 text-sm">
                <Field label="Comparable Properties Used" value={savings.compsCount.toString()} />
                <Field label="Comps Median Value" value={currency(savings.compsMedian)} />
                <Field label="Your Assessed Value" value={currency(state.totalValue)} bold />
                <Field
                  label="Value Above Median"
                  value={currency((state.totalValue ?? 0) - savings.compsMedian)}
                  bold
                />
                <Field label="Effective Tax Rate Used" value={`${savings.effectiveTaxRatePct}%`} />
              </div>
            )}
            {savings.basis === "formula" && (
              <div className="mb-5 grid gap-3 sm:grid-cols-2 text-sm">
                <span className="badge-soft sm:col-span-2 w-fit">
                  Modeled from real Texas protest data — no direct comps available
                </span>
                <Field
                  label="Typical Reduction for This Property"
                  value={`${savings.reductionPct}%`}
                />
                <Field label="Effective Tax Rate Used" value={`${savings.effectiveTaxRatePct}%`} />
                <Field label="Your Assessed Value" value={currency(state.totalValue)} bold />
                <div className="sm:col-span-2">
                  <Field label="Basis" value={savings.rationale} />
                </div>
              </div>
            )}
            {alreadySaved && (
              <div className="mb-4 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/10 px-4 py-3 text-sm">
                <Check className="h-4 w-4 shrink-0 text-accent" />
                <span>
                  You&apos;ve already added this property to your account — no need to add it again.
                </span>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {alreadySaved ? (
                <button
                  onClick={() => {
                    updateIntake({ confirmed: true });
                    nav({ to: "/ai-report" });
                  }}
                  className="btn-primary btn-primary-hover"
                >
                  View AI Report
                </button>
              ) : (
                <button
                  onClick={() => setStep("confirm")}
                  className="btn-primary btn-primary-hover"
                >
                  Continue
                </button>
              )}
              <button onClick={() => setStep("address")} className="btn-outline">
                Search a Different Address
              </button>
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              {savings.basis === "comps"
                ? `*Estimated from ${savings.compsCount} real comparable properties in your subdivision, at your county's ~${savings.effectiveTaxRatePct}% effective tax rate. Your actual result depends on the hearing outcome and county-specific factors.`
                : "*Modeled from real, published Texas protest-outcome data for this property's county and category — no directly comparable properties were available for this address, so this isn't a specific analysis of your property. Your actual result depends on the hearing outcome and county-specific factors."}{" "}
              Tax bill figures use your county's estimated effective tax rate applied to the CAD's
              assessed value — not a bill pulled from the county, and before any exemptions (e.g.
              homestead) you may qualify for.
            </p>
          </div>
        </section>
      )}

      {step === "confirm" && state.address && (
        <section className="mt-8 card-elev p-6">
          <div className="flex items-center gap-2">
            <span className="badge-soft">Official CAD Record</span>
            <span className="text-xs text-muted-foreground">Source: County Appraisal District</span>
          </div>
          <h2 className="mt-3 font-serif text-2xl font-semibold">Confirm your property</h2>
          <dl className="mt-5 grid gap-3 sm:grid-cols-2 text-sm">
            <Field label="Owner Name" value={state.ownerName} />
            <Field label="Property Address" value={state.address} />
            <Field label="County / CAD" value={state.cad} />
            <Field label="CAD Account Number" value={state.accountNumber} />
            <Field label="Property Type" value={state.propertyType} />
            <Field label="Tax Year" value={state.taxYear?.toString()} />
            <Field label="Land Value" value={currency(state.landValue)} />
            <Field label="Improvement Value" value={currency(state.improvementValue)} />
            <Field label="Total Appraised Value" value={currency(state.totalValue)} bold />
            {state.legalDescription && (
              <Field label="Legal Description" value={state.legalDescription} />
            )}
            {state.subdivision && <Field label="Subdivision" value={state.subdivision} />}
            {state.geoId && <Field label="Geographic ID" value={state.geoId} />}
            {state.mailingAddress && (
              <Field label="Owner Mailing Address" value={state.mailingAddress} />
            )}
            {state.ownershipPct != null && (
              <Field label="% Ownership" value={`${state.ownershipPct}%`} />
            )}
            {state.protestStatus && <Field label="Protest Status" value={state.protestStatus} />}
          </dl>
          {state.totalValue == null && (
            <p className="mt-3 text-xs text-muted-foreground">
              Value data is not published in this county's public records.
            </p>
          )}

          <ValueHistorySection history={state.valueHistory ?? []} />

          {state.deeds && state.deeds.length > 0 && (
            <div className="mt-6">
              <h3 className="text-sm font-semibold">Deed History</h3>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="py-1 pr-4">Date</th>
                      <th className="py-1 pr-4">Type</th>
                      <th className="py-1 pr-4">Seller</th>
                      <th className="py-1 pr-4">Buyer</th>
                      <th className="py-1 pr-4">Instrument #</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.deeds.map((d, i) => (
                      <tr key={i} className="border-t border-border">
                        <td className="py-1 pr-4">{d.date?.slice(0, 10) ?? "—"}</td>
                        <td className="py-1 pr-4">{d.description ?? d.type ?? "—"}</td>
                        <td className="py-1 pr-4">{d.seller ?? "—"}</td>
                        <td className="py-1 pr-4">{d.buyer ?? "—"}</td>
                        <td className="py-1 pr-4">{d.instrumentNum ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {alreadySaved && (
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/10 px-4 py-3 text-sm">
              <Check className="h-4 w-4 shrink-0 text-accent" />
              <span>This property is already in your account — no need to confirm it again.</span>
            </div>
          )}
          {saveError && <p className="mt-4 text-sm text-destructive">{saveError}</p>}
          <div className="mt-6 flex flex-wrap gap-2">
            <button
              disabled={saving}
              onClick={async () => {
                setSaveError(null);
                if (user && !alreadySaved) {
                  setSaving(true);
                  try {
                    await addProperty(user.id, {
                      address: state.address!,
                      cad: state.cad,
                      accountNumber: state.accountNumber,
                      ownerName: state.ownerName,
                      propertyType: state.propertyType,
                      landValue: state.landValue,
                      improvementValue: state.improvementValue,
                      totalValue: state.totalValue,
                      taxYear: state.taxYear,
                      estimatedSavings: savings?.amount,
                      savingsBasis: savings?.basis,
                      valueHistory: state.valueHistory,
                    });
                  } catch (err) {
                    setSaving(false);
                    const message =
                      err instanceof Error
                        ? err.message
                        : "Could not save this property. Please try again.";
                    setSaveError(message);
                    toast.error(message);
                    return;
                  }
                  setSaving(false);
                  toast.success("Property saved.");
                }
                updateIntake({ confirmed: true });
                nav({ to: "/ai-report" });
              }}
              className="btn-primary btn-primary-hover disabled:opacity-60"
            >
              {saving ? "Saving…" : alreadySaved ? "View AI Report" : "Confirm Property"}
            </button>
            <button onClick={() => setStep("address")} className="btn-outline">
              Edit Address
            </button>
            {confirmCadRecordUrl && (
              <a
                href={confirmCadRecordUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-outline inline-flex items-center gap-1.5"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {isDirectCadRecordUrl(state.cad ?? "")
                  ? "View Official CAD Record"
                  : `Search on ${state.cad}`}
              </a>
            )}
            <label
              className={`btn-outline cursor-pointer ${isDragging ? "ring-2 ring-accent" : ""}`}
              {...dropHandlers}
            >
              <input
                type="file"
                className="hidden"
                accept=".pdf,image/*"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onFile(f);
                }}
              />
              {isDragging ? "Drop to upload" : "Upload Another Notice"}
            </label>
          </div>
        </section>
      )}

      {pickingOnMap && (
        <MapPinPicker
          onClose={() => setPickingOnMap(false)}
          onConfirm={(resolvedAddress) => {
            setPickingOnMap(false);
            setAddress(resolvedAddress);
            updateIntake({ address: resolvedAddress, propertyKind });
            runValidation(resolvedAddress);
          }}
        />
      )}
    </div>
  );
}

function Stepper({ step }: { step: Step }) {
  const items = [
    ["Address", ["address"]],
    ["Validate", ["validating", "notfound", "multiple", "residential-blocked"]],
    ["Savings", ["savings"]],
    ["Confirm", ["confirm"]],
  ] as const;
  return (
    <ol className="flex w-full items-center text-xs font-medium">
      {items.map(([label, keys], i) => {
        const active = (keys as readonly string[]).includes(step);
        const isLast = i === items.length - 1;
        return (
          <li
            key={label}
            className={`flex items-center gap-1.5 sm:gap-2 ${isLast ? "" : "flex-1"}`}
          >
            <span
              className={`h-6 w-6 shrink-0 rounded-full grid place-items-center ${
                active ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"
              }`}
            >
              {i + 1}
            </span>
            {/* Full labels once there's room (sm+); numbers-only on narrow
                phones so 4 steps fit without pushing the page into
                horizontal scroll. */}
            <span
              className={`hidden sm:inline ${active ? "text-foreground" : "text-muted-foreground"}`}
            >
              {label}
            </span>
            {/* Connector grows to fill the gap to the next step, so the whole
                stepper spans the same width as the card below it instead of
                sitting in a compact cluster with dead space to the right. */}
            {!isLast && <span className="h-px flex-1 shrink-0 bg-border mx-1" />}
          </li>
        );
      })}
    </ol>
  );
}

function Field({ label, value, bold }: { label: string; value?: string; bold?: boolean }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={`mt-1 ${bold ? "text-lg font-semibold" : ""}`}>{value ?? "—"}</dd>
    </div>
  );
}
