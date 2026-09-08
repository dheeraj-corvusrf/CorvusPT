import { useEffect, useState } from "react";
import "leaflet/dist/leaflet.css";
import { currency } from "@/lib/intake-store";

export type CompProperty = {
  pid: number;
  address: string;
  latitude: number;
  longitude: number;
  marketValue: number | null;
  ownerName: string | null;
  // Optional — only present when the caller passes ai-report.tsx's own
  // already-ranked RankedComp[] (see computeComparableStats in
  // comps-analysis.ts) instead of the raw comps array. Real numbers either
  // way, never computed inside this component — this file stays a plain
  // presentational map.
  distanceMi?: number;
  similarity?: number;
  // Marker styling for Module 3: an assessed-value CAD comp, a user-added
  // comp with a verified sale (from an uploaded document), or a user-added
  // comp whose sale price is unverified. Defaults to "assessed".
  kind?: CompMarkerKind;
  excluded?: boolean;
};

export type CompMarkerKind = "assessed" | "sale-verified" | "sale-unverified";

// Leaflet touches `window` as soon as its module is evaluated (confirmed live via
// a prerender crash: "ReferenceError: window is not defined" inside
// leaflet-src.js, thrown at import time, not at map-instantiation time) — this app
// prerenders every route server-side at build time, so a plain top-level
// `import "leaflet"` breaks /ai-report's prerendered HTML even though the map JSX
// itself only ever renders after a real browser mounts it. Loading both packages
// via a dynamic import() inside useEffect (which never runs during SSR) keeps
// leaflet's module code out of the server bundle entirely.
export type LeafletMods = {
  L: typeof import("leaflet");
  MapContainer: typeof import("react-leaflet").MapContainer;
  TileLayer: typeof import("react-leaflet").TileLayer;
  Marker: typeof import("react-leaflet").Marker;
  Popup: typeof import("react-leaflet").Popup;
  useMap: typeof import("react-leaflet").useMap;
};

let cachedMods: LeafletMods | null = null;

// Exported so other components needing a small Leaflet map (e.g. ai-report.tsx's
// Site Condition thumbnail) share the same dynamic-import/caching logic instead
// of re-solving the SSR-window-at-import-time problem explained above a second time.
export function useLeaflet(): LeafletMods | null {
  const [mods, setMods] = useState<LeafletMods | null>(cachedMods);
  useEffect(() => {
    if (cachedMods) return;
    let cancelled = false;
    Promise.all([import("leaflet"), import("react-leaflet")]).then(([leaflet, rl]) => {
      if (cancelled) return;
      cachedMods = {
        L: leaflet.default,
        MapContainer: rl.MapContainer,
        TileLayer: rl.TileLayer,
        Marker: rl.Marker,
        Popup: rl.Popup,
        useMap: rl.useMap,
      };
      setMods(cachedMods);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return mods;
}

export function CompsMap({ subject, comps }: { subject: CompProperty; comps: CompProperty[] }) {
  const mods = useLeaflet();

  if (!mods) {
    return (
      <div className="mt-3 h-[280px] animate-pulse rounded-lg border border-border bg-secondary/40" />
    );
  }
  return <CompsMapInner subject={subject} comps={comps} mods={mods} />;
}

// Plain colored dots instead of Leaflet's default pin images — sidesteps the
// well-known bundler issue where Leaflet's default marker icon URLs (relative
// paths baked into the package) 404 once Vite rehashes asset filenames, and lets
// the subject property read as visually distinct (bigger, accent-colored) from
// the comps (smaller, neutral) without needing any external icon assets at all.
function dotIcon(L: typeof import("leaflet"), color: string, size: number) {
  return L.divIcon({
    className: "",
    html: `<div style="width:${size}px;height:${size}px;border-radius:9999px;background:${color};border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.45);"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function CompsMapInner({
  subject,
  comps,
  mods,
}: {
  subject: CompProperty;
  comps: CompProperty[];
  mods: LeafletMods;
}) {
  const { L, MapContainer, TileLayer, Marker, Popup, useMap } = mods;
  const subjectIcon = dotIcon(L, "var(--accent)", 20);
  // assessed = CAD value comp (neutral), sale-verified = real uploaded sale
  // (success green), sale-unverified = user-added, price not confirmed (amber).
  const MARKER_COLOR: Record<CompMarkerKind, string> = {
    assessed: "var(--muted-foreground)",
    "sale-verified": "var(--success)",
    "sale-unverified": "var(--warning)",
  };
  const iconFor = (kind: CompMarkerKind | undefined, excluded: boolean | undefined) =>
    dotIcon(L, excluded ? "var(--border)" : MARKER_COLOR[kind ?? "assessed"], excluded ? 9 : 12);
  const hasSaleData = comps.some((c) => c.kind === "sale-verified" || c.kind === "sale-unverified");

  function FitBounds({ points }: { points: Array<[number, number]> }) {
    const map = useMap();
    useEffect(() => {
      if (points.length > 1) map.fitBounds(points, { padding: [28, 28] });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [map]);
    return null;
  }

  const center: [number, number] = [subject.latitude, subject.longitude];
  const allPoints: Array<[number, number]> = [
    center,
    ...comps.map((c): [number, number] => [c.latitude, c.longitude]),
  ];

  return (
    <div className="mt-3">
      <div className="overflow-hidden rounded-lg border border-border" style={{ height: 280 }}>
        <MapContainer
          center={center}
          zoom={16}
          scrollWheelZoom={false}
          style={{ height: "100%", width: "100%" }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <FitBounds points={allPoints} />
          <Marker position={center} icon={subjectIcon}>
            <Popup>
              <strong>Subject Property</strong>
              <br />
              {subject.address}
              {subject.marketValue != null && (
                <>
                  <br />
                  {currency(subject.marketValue)}
                </>
              )}
            </Popup>
          </Marker>
          {comps.map((c, i) => (
            <Marker
              key={c.pid || `comp-${i}`}
              position={[c.latitude, c.longitude]}
              icon={iconFor(c.kind, c.excluded)}
            >
              <Popup>
                {c.address}
                {c.kind === "sale-unverified" && (
                  <>
                    <br />
                    <span className="text-xs text-muted-foreground">Sale Price Not Verified</span>
                  </>
                )}
                {c.marketValue != null && (
                  <>
                    <br />
                    {currency(c.marketValue)}
                    {c.kind === "assessed" && (
                      <span className="text-xs text-muted-foreground"> assessed</span>
                    )}
                  </>
                )}
                {(c.distanceMi != null || c.similarity != null) && (
                  <>
                    <br />
                    <span className="text-xs text-muted-foreground">
                      {c.distanceMi != null && `${c.distanceMi.toFixed(2)} mi`}
                      {c.distanceMi != null && c.similarity != null && " · "}
                      {c.similarity != null && `${c.similarity}/100 relevance`}
                    </span>
                  </>
                )}
                {c.ownerName && (
                  <>
                    <br />
                    <span className="text-xs text-muted-foreground">{c.ownerName}</span>
                  </>
                )}
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        <LegendDot color="var(--accent)" /> Subject
        {hasSaleData ? (
          <>
            <LegendDot color="var(--success)" /> Verified sale
            <LegendDot color="var(--warning)" /> Sale not verified
            <LegendDot color="var(--muted-foreground)" /> Assessed value
          </>
        ) : (
          <>
            <LegendDot color="var(--muted-foreground)" /> Comparable (assessed value)
          </>
        )}
      </div>
    </div>
  );
}

function LegendDot({ color }: { color: string }) {
  return (
    <span
      className="inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ backgroundColor: color, border: "1px solid white" }}
    />
  );
}
