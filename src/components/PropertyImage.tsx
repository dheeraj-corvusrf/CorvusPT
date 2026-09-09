import { useEffect, useState, type ReactNode } from "react";
import { streetViewAvailable, streetViewImageUrl } from "@/lib/property-image";

// Shows a real Street View photo of `address` when Google has outdoor
// imagery there; otherwise renders `fallback` (a building illustration). The
// fallback is also what shows while the (fast, free) availability check is in
// flight, so there's no flash of empty space.
export function PropertyImage({
  address,
  className,
  fallback,
  width = 400,
  height = 220,
}: {
  address: string | null | undefined;
  className?: string;
  fallback: ReactNode;
  width?: number;
  height?: number;
}) {
  const [status, setStatus] = useState<"checking" | "ok" | "none">("checking");

  useEffect(() => {
    let live = true;
    setStatus("checking");
    if (!address) {
      setStatus("none");
      return;
    }
    streetViewAvailable(address)
      .then((ok) => {
        if (live) setStatus(ok ? "ok" : "none");
      })
      .catch(() => {
        if (live) setStatus("none");
      });
    return () => {
      live = false;
    };
  }, [address]);

  const url = status === "ok" && address ? streetViewImageUrl(address, width, height) : null;
  if (url) {
    return (
      <img
        src={url}
        alt={`Street view of ${address}`}
        className={className}
        loading="lazy"
        // A "no imagery" location returns a 200 placeholder, not an error —
        // the availability check above is the real guard — but keep this so a
        // genuine load failure (network, quota) still degrades gracefully.
        onError={() => setStatus("none")}
      />
    );
  }
  return <>{fallback}</>;
}
