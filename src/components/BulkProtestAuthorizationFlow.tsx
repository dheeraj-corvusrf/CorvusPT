import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  ProtestAuthorizationFlow,
  type CarriedOwnerInfo,
} from "@/components/ProtestAuthorizationFlow";
import type { ProtestRecord } from "@/lib/protests";
import type { PropertyRecord } from "@/lib/properties";

// Drives ProtestAuthorizationFlow once per property in sequence, rather than
// merging multiple properties into one signature — each property's
// "Appointment of Agent" is a real, separate legal document scoped to that
// one CAD account, so batching still means N real authorizations, just
// walked through back-to-back in one sitting instead of the user having to
// re-open this flow from the properties list N separate times. Owner-
// identity fields (name/contact/entity info) carry forward automatically
// between properties via CarriedOwnerInfo; purchase-timing and the
// signature itself are asked fresh per property since those are genuinely
// property-specific. `key={current.id}` below forces a full remount of
// ProtestAuthorizationFlow for each property so its internal form state
// never leaks between them.
export function BulkProtestAuthorizationFlow({
  userId,
  properties,
  userEmail,
  isBeta,
  open,
  onOpenChange,
  onAllDone,
}: {
  userId: string;
  properties: PropertyRecord[];
  userEmail?: string | null;
  // Beta bypasses the per-property payment gate unconditionally, same
  // convention as isPaid in _layout.properties.tsx/hasFullAccess in
  // ai-report.tsx — every other plan reads each property's own real
  // subscriptionStatus directly (see the skip effect below).
  isBeta: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAllDone: (completed: ProtestRecord[]) => void;
}) {
  const [index, setIndex] = useState(0);
  const [carriedOwnerInfo, setCarriedOwnerInfo] = useState<CarriedOwnerInfo | undefined>(undefined);
  const [completed, setCompleted] = useState<ProtestRecord[]>([]);

  // Fresh start whenever this is opened for a new batch.
  useEffect(() => {
    if (!open) return;
    setIndex(0);
    setCarriedOwnerInfo(undefined);
    setCompleted([]);
  }, [open]);

  const current = open ? (properties[index] ?? null) : null;
  const isPaid = isBeta || current?.subscriptionStatus === "active";

  // Real payment gate — skips straight past any property with no active
  // subscription instead of walking it through a real legal "Appointment of
  // Agent" it wouldn't be allowed to actually sign anyway (see
  // ProtestAuthorizationFlow's own isPaid gate, which blocks Sign & Submit
  // regardless). Newly bulk-imported properties (AddOwnershipsModal) are
  // almost always unpaid — this is the common case, not an edge case.
  useEffect(() => {
    if (!open || !current || isPaid) return;
    toast.error(`${current.address} isn't paid — subscribe to it first, then request its protest.`);
    if (index >= properties.length - 1) {
      onOpenChange(false);
      onAllDone(completed);
    } else {
      setIndex((i) => i + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, current, isPaid, index]);

  if (!open || !current || !isPaid) return null;
  const isLast = index === properties.length - 1;

  return (
    <ProtestAuthorizationFlow
      key={current.id}
      userId={userId}
      property={current}
      userEmail={userEmail}
      isPaid={isPaid}
      open={open}
      initialOwnerInfo={carriedOwnerInfo}
      batchProgress={{ index: index + 1, total: properties.length }}
      onOpenChange={(o) => {
        // Cancelling mid-batch stops the whole batch here rather than
        // silently skipping to the next property — whatever was already
        // signed stays signed (those requests are already submitted), the
        // rest is simply not started.
        if (!o) {
          onOpenChange(false);
          onAllDone(completed);
        }
      }}
      onDone={(protest, ownerInfo) => {
        const updated = [...completed, protest];
        setCompleted(updated);
        setCarriedOwnerInfo(ownerInfo);
        if (isLast) {
          onOpenChange(false);
          onAllDone(updated);
        } else {
          setIndex((i) => i + 1);
        }
      }}
    />
  );
}
