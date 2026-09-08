import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { useLeaflet } from "@/components/CompsMap";
import { geocodeAddress, type GeocodedPoint } from "@/lib/geocode";
import { getCadRecordUrl, isDirectCadRecordUrl } from "@/lib/cad-record-url";
import { LoadingLine } from "@/components/LoadingLine";

// A street map + an aerial ("CAD-style") map for a property, side by side,
// plus a link out to the county's own record. Geocodes the address itself so
// it works from anywhere an address is known (e.g. the document-review
// confirm page). Silently renders nothing if the address can't be located.
export function PropertyMaps({
  address,
  cad,
  accountNumber,
  height = 200,
}: {
  address: string | null | undefined;
  cad?: string | null;
  accountNumber?: string | null;
  height?: number;
}) {
  const [point, setPoint] = useState<GeocodedPoint | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "done" | "failed">("idle");

  useEffect(() => {
    const a = address?.trim();
    if (!a) {
      setState("idle");
      setPoint(null);
      return;
    }
    let cancelled = false;
    setState("loading");
    geocodeAddress(a)
      .then((p) => {
        if (cancelled) return;
        setPoint(p);
        setState(p ? "done" : "failed");
      })
      .catch(() => {
        if (!cancelled) setState("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  const cadUrl = cad ? getCadRecordUrl({ cad, accountNumber: accountNumber ?? null }) : null;

  if (state === "idle" || state === "failed") return null;

  return (
    <section className="mt-6">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Location
        </h2>
        {cadUrl && (
          <a
            href={cadUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-accent hover:underline"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {isDirectCadRecordUrl(cad ?? "") ? "Open the county's CAD record" : `Search ${cad}`}
          </a>
        )}
      </div>

      {state === "loading" || !point ? (
        <div
          className="grid place-items-center rounded-lg border border-border bg-secondary/40"
          style={{ height }}
        >
          <LoadingLine text="Locating the property…" className="text-sm" />
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <MiniMap
            lat={point.lat}
            lng={point.lng}
            height={height}
            label="Map"
            tileUrl="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution="&copy; OpenStreetMap"
          />
          <MiniMap
            lat={point.lat}
            lng={point.lng}
            height={height}
            label="Aerial / CAD view"
            tileUrl="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            attribution="Tiles &copy; Esri"
          />
        </div>
      )}
    </section>
  );
}

function MiniMap({
  lat,
  lng,
  height,
  label,
  tileUrl,
  attribution,
}: {
  lat: number;
  lng: number;
  height: number;
  label: string;
  tileUrl: string;
  attribution: string;
}) {
  const mods = useLeaflet();
  if (!mods) {
    return (
      <div
        className="animate-pulse rounded-lg border border-border bg-secondary/40"
        style={{ height }}
      />
    );
  }
  const { L, MapContainer, TileLayer, Marker } = mods;
  const icon = L.divIcon({
    className: "",
    html: `<div style="width:14px;height:14px;border-radius:9999px;background:var(--accent);border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.45);"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium text-muted-foreground">{label}</div>
      <div className="relative overflow-hidden rounded-lg border border-border" style={{ height }}>
        <MapContainer
          center={[lat, lng]}
          zoom={17}
          zoomControl={false}
          scrollWheelZoom={false}
          style={{ height: "100%", width: "100%" }}
        >
          <TileLayer attribution={attribution} url={tileUrl} />
          <Marker position={[lat, lng]} icon={icon} />
        </MapContainer>
      </div>
    </div>
  );
}
