import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { SignaturePad, type SignatureValue } from "@/components/SignaturePad";
import { requestProtest, type ProtestRecord } from "@/lib/protests";
import { createAuthorization } from "@/lib/protest-authorizations";
import { getMyProfile } from "@/lib/profile";
import type { PropertyRecord } from "@/lib/properties";
import { getErrorMessage } from "@/lib/error-message";

// The TDLR regulatory line is intentionally omitted until registration is
// confirmed. Fee (25%) and service scope were explicitly confirmed as
// CorvusPT's real terms.
export const AGREEMENT = {
  address: "18740 Wainsborough Ln, Dallas, TX",
  phone: "(469) 501-9362",
  email: "properties@srclandbuilding.com",
  venue: "Dallas County, Texas",
};

type Step = "owner" | "purchase" | "review";
const ENTITY_TYPES = ["LLC", "Corporation", "Partnership", "Estate", "Trust", "Other"] as const;

// The owner-identity fields carried from one property to the next when this
// flow is driven in sequence by BulkProtestAuthorizationFlow, so someone
// authorizing several properties in one sitting only has to type their own
// name/contact/entity details once — everything else (purchase timing,
// signature) still happens fresh per property below, since those are
// genuinely property-specific and each is its own real, independently
// executed "Appointment of Agent," not one document covering many
// properties.
export type CarriedOwnerInfo = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  isEntity: boolean;
  entityName: string;
  entityRelationship: string;
  entityType: (typeof ENTITY_TYPES)[number] | "";
};

export function ProtestAuthorizationFlow({
  userId,
  property,
  userEmail,
  open,
  initialOwnerInfo,
  batchProgress,
  isPaid,
  onOpenChange,
  onDone,
}: {
  userId: string;
  property: PropertyRecord;
  userEmail?: string | null;
  open: boolean;
  // Pre-fills the owner-identity step from a prior property in the same
  // batch (see CarriedOwnerInfo above) instead of the usual empty/profile-
  // autofill start state. Absent for a normal single-property flow.
  initialOwnerInfo?: CarriedOwnerInfo;
  // "Property 2 of 5" — purely a progress label for the batch orchestrator;
  // has no effect on this flow's own step logic.
  batchProgress?: { index: number; total: number };
  // Real payment gate, enforced here rather than trusted to whichever
  // caller happens to render the button that opens this modal — a hidden/
  // disabled button elsewhere is just a hint; this is where filing an
  // actual protest is prevented outright for an unpaid property. Callers
  // compute this themselves (beta bypasses unconditionally; every other
  // plan reads the property's own real subscriptionStatus — see isPaid in
  // _layout.properties.tsx/hasFullAccess in ai-report.tsx) since this
  // component has no independent way to know about account-level plans.
  isPaid: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (protest: ProtestRecord, ownerInfo: CarriedOwnerInfo) => void;
}) {
  const [step, setStep] = useState<Step>("owner");
  const [firstName, setFirstName] = useState(initialOwnerInfo?.firstName ?? "");
  const [lastName, setLastName] = useState(initialOwnerInfo?.lastName ?? "");
  const [email, setEmail] = useState(initialOwnerInfo?.email ?? userEmail ?? "");
  const [phone, setPhone] = useState(initialOwnerInfo?.phone ?? "");
  const [isEntity, setIsEntity] = useState(initialOwnerInfo?.isEntity ?? false);
  const [entityName, setEntityName] = useState(initialOwnerInfo?.entityName ?? "");
  const [entityRelationship, setEntityRelationship] = useState(
    initialOwnerInfo?.entityRelationship ?? "",
  );
  const [entityType, setEntityType] = useState<(typeof ENTITY_TYPES)[number] | "">(
    initialOwnerInfo?.entityType ?? "",
  );
  const [purchasedRecently, setPurchasedRecently] = useState<boolean | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [signature, setSignature] = useState<SignatureValue | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Real account info, not guessed — fetched fresh each time the modal opens
  // rather than passed in as a prop, so every call site gets this for free.
  // Only fills fields still empty, so it can never clobber something the
  // user already typed if this resolves late.
  useEffect(() => {
    if (!open) return;
    getMyProfile(userId)
      .then((profile) => {
        setFirstName((prev) => prev || (profile.firstName ?? ""));
        setLastName((prev) => prev || (profile.lastName ?? ""));
        setPhone((prev) => prev || (profile.phone ?? ""));
      })
      .catch((err) => console.error("Could not load profile for autofill:", err));
  }, [open, userId]);

  function reset() {
    setStep("owner");
    setFirstName(initialOwnerInfo?.firstName ?? "");
    setLastName(initialOwnerInfo?.lastName ?? "");
    setEmail(initialOwnerInfo?.email ?? userEmail ?? "");
    setPhone(initialOwnerInfo?.phone ?? "");
    setIsEntity(initialOwnerInfo?.isEntity ?? false);
    setEntityName(initialOwnerInfo?.entityName ?? "");
    setEntityRelationship(initialOwnerInfo?.entityRelationship ?? "");
    setEntityType(initialOwnerInfo?.entityType ?? "");
    setPurchasedRecently(null);
    setAgreed(false);
    setSignature(null);
    setError(null);
    setSubmitting(false);
  }

  function close() {
    onOpenChange(false);
    reset();
  }

  const ownerValid =
    firstName.trim() &&
    lastName.trim() &&
    email.trim() &&
    phone.trim() &&
    (!isEntity || (entityName.trim() && entityRelationship.trim() && entityType));

  async function handleSubmit() {
    if (!signature) return;
    if (!isPaid) {
      setError("This property isn't covered by an active subscription — subscribe before filing.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const protest = await requestProtest(userId, property.id, {
        address: property.address,
        userEmail: email,
        originalValue: property.totalValue,
        taxYear: property.taxYear,
      });
      await createAuthorization(userId, {
        protestId: protest.id,
        propertyId: property.id,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
        phone: phone.trim(),
        isEntity,
        entityName: entityName.trim(),
        entityRelationship: entityRelationship.trim(),
        entityType,
        purchasedRecently: purchasedRecently ?? false,
        signature,
      });
      toast.success("Authorization signed. CorvusPT staff will follow up.");
      onDone(protest, {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
        phone: phone.trim(),
        isEntity,
        entityName: entityName.trim(),
        entityRelationship: entityRelationship.trim(),
        entityType,
      });
      close();
    } catch (err) {
      const message = getErrorMessage(err, "Could not submit your authorization.");
      setError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {step === "owner" && "Property Owner Details"}
            {step === "purchase" && "One More Question"}
            {step === "review" && "Review & Sign"}
          </DialogTitle>
          <DialogDescription>
            {property.address}
            {batchProgress && ` — Property ${batchProgress.index} of ${batchProgress.total}`}
          </DialogDescription>
        </DialogHeader>

        {step === "owner" && (
          <div className="grid gap-4">
            <p className="text-sm text-muted-foreground">
              Provide your full legal name, including any suffix (Jr., Sr., II), to ensure it
              matches the county's records.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1 text-sm">
                <span className="text-xs font-medium text-muted-foreground">
                  First Name<span className="text-destructive"> *</span>
                </span>
                <input
                  required
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  className="rounded-md border border-input bg-background px-3 py-2"
                />
              </label>
              <label className="grid gap-1 text-sm">
                <span className="text-xs font-medium text-muted-foreground">
                  Last Name<span className="text-destructive"> *</span>
                </span>
                <input
                  required
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  className="rounded-md border border-input bg-background px-3 py-2"
                />
              </label>
              <label className="grid gap-1 text-sm">
                <span className="text-xs font-medium text-muted-foreground">
                  Email Address<span className="text-destructive"> *</span>
                </span>
                <input
                  required
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="rounded-md border border-input bg-background px-3 py-2"
                />
              </label>
              <label className="grid gap-1 text-sm">
                <span className="text-xs font-medium text-muted-foreground">
                  Phone Number<span className="text-destructive"> *</span>
                </span>
                <input
                  required
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="rounded-md border border-input bg-background px-3 py-2"
                />
              </label>
            </div>
            <div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm">
                  Is this property owned by a trust, LLC, or other entity?
                </span>
                <div className="flex gap-3 text-sm">
                  <label className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      checked={isEntity}
                      onChange={() => {
                        setIsEntity(true);
                        // The county's own owner-of-record — only offered once the
                        // user has confirmed entity ownership themselves; never
                        // auto-selects Yes/No on its own.
                        if (!entityName.trim() && property.ownerName)
                          setEntityName(property.ownerName);
                      }}
                    />{" "}
                    Yes
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input type="radio" checked={!isEntity} onChange={() => setIsEntity(false)} />{" "}
                    No
                  </label>
                </div>
              </div>
              {property.ownerName && (
                <p className="mt-1 text-xs text-muted-foreground">
                  County record shows owner:{" "}
                  <span className="font-medium">{property.ownerName}</span>
                </p>
              )}
            </div>
            {isEntity && (
              <div className="grid gap-4 rounded-lg bg-secondary/40 p-4">
                <h3 className="font-semibold">Representative of Entity Details</h3>
                <p className="text-xs text-muted-foreground">
                  If your name does not match an authorized representative of the entity, CorvusPT
                  may be unable to proceed with your protest.
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="grid gap-1 text-sm">
                    <span className="text-xs font-medium text-muted-foreground">Entity Name</span>
                    <input
                      value={entityName}
                      onChange={(e) => setEntityName(e.target.value)}
                      placeholder="Entity Name"
                      className="rounded-md border border-input bg-background px-3 py-2"
                    />
                  </label>
                  <label className="grid gap-1 text-sm">
                    <span className="text-xs font-medium text-muted-foreground">
                      Relationship to Entity
                    </span>
                    <input
                      value={entityRelationship}
                      onChange={(e) => setEntityRelationship(e.target.value)}
                      placeholder="Owner, Agent, Trustee, etc."
                      className="rounded-md border border-input bg-background px-3 py-2"
                    />
                  </label>
                </div>
                <div>
                  <span className="text-xs font-medium text-muted-foreground">Type of Entity</span>
                  <div className="mt-1 grid gap-1.5">
                    {ENTITY_TYPES.map((t) => (
                      <label key={t} className="flex items-center gap-2 text-sm">
                        <input
                          type="radio"
                          checked={entityType === t}
                          onChange={() => setEntityType(t)}
                        />
                        {t}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            )}
            <button
              disabled={!ownerValid}
              onClick={() => setStep("purchase")}
              className="btn-primary btn-primary-hover w-fit disabled:opacity-50"
            >
              Next
            </button>
          </div>
        )}

        {step === "purchase" && (
          <div className="grid gap-4">
            <div className="flex items-center justify-between gap-2 rounded-lg bg-secondary/40 p-4">
              <span className="text-sm">
                Did you purchase this property within the last 18 months?
              </span>
              <div className="flex gap-3 text-sm shrink-0">
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    checked={purchasedRecently === true}
                    onChange={() => setPurchasedRecently(true)}
                  />
                  Yes
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    checked={purchasedRecently === false}
                    onChange={() => setPurchasedRecently(false)}
                  />
                  No
                </label>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setStep("owner")} className="btn-outline">
                Back
              </button>
              <button
                disabled={purchasedRecently === null}
                onClick={() => setStep("review")}
                className="btn-primary btn-primary-hover disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        )}

        {step === "review" && (
          <div className="grid gap-4">
            {!isPaid && (
              <div className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
                This property isn't covered by an active subscription yet — you can review this
                agreement, but signing is disabled until you subscribe.
              </div>
            )}
            <div className="rounded-lg border border-border p-4 text-sm max-h-56 overflow-y-auto">
              <h3 className="font-semibold">CorvusPT Service Agreement</h3>
              <p className="mt-2">
                <strong>Service:</strong> During the term of this agreement, CorvusPT will evaluate
                your current property tax assessment for errors and available exemptions and perform
                a comparative market analysis. If CorvusPT determines your property assessment is
                incorrect, CorvusPT will prepare and file evidence supporting a reduction with your
                county tax assessor and/or review board, and will represent you at hearings and
                negotiate an assessment reduction on your behalf.
              </p>
              <p className="mt-2">
                <strong>Fee:</strong> There is no fee unless CorvusPT successfully obtains a
                reduction in your property's assessed value. If successful, CorvusPT's fee is 25% of
                the property tax savings obtained for the year in which the appeal is filed, plus
                any recovered tax overpayments (refunds) from previous years.
              </p>
              <p className="mt-2">
                <strong>Scope of Authorization:</strong> you authorize CorvusPT to execute and
                submit an Appointment of Agent for Property Tax Matters (or similar form) with your
                county appraisal district; obtain property, owner, and tax information on your
                behalf; represent and negotiate on your behalf with the appraisal district and
                review board; and present evidence at hearings.
              </p>
              <p className="mt-2">
                <strong>Termination:</strong> you may terminate this agreement at any time up to two
                months before the appeal filing deadline. You remain responsible for fees arising
                from services already provided before termination.
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                CorvusPT, {AGREEMENT.address} · {AGREEMENT.phone} · {AGREEMENT.email}. Governed by
                the laws of the State of Texas; venue in {AGREEMENT.venue}.
              </p>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                className="mt-0.5"
              />
              I have read and agree to the CorvusPT Service Agreement above, and authorize CorvusPT
              to act as my agent for this property's tax matters.
            </label>
            <div>
              <SignaturePad expectedName={property.ownerName} onChange={setSignature} />
            </div>
            <div className="rounded-lg bg-secondary/40 p-4 text-sm grid gap-1">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Parcel Number</span>
                <span>{property.accountNumber ?? "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Full Name</span>
                <span>
                  {firstName} {lastName}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Email</span>
                <span>{email}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Phone</span>
                <span>{phone}</span>
              </div>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex gap-2">
              <button onClick={() => setStep("purchase")} className="btn-outline">
                Back
              </button>
              <button
                disabled={!agreed || !signature || submitting || !isPaid}
                onClick={handleSubmit}
                className="btn-primary btn-primary-hover disabled:opacity-50"
              >
                {submitting ? "Submitting…" : "Sign & Submit"}
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
