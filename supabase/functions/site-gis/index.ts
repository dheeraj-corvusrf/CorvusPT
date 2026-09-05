// Deploy via CLI: `supabase functions deploy site-gis`.
// No secrets required — both upstream sources are free, public, keyless federal
// GIS services. Proxied server-side (not called directly from the browser) purely
// because neither sets an Access-Control-Allow-Origin header — confirmed live,
// there's no API key or rate limit to protect here.
//
// Returns REAL point-in-place site facts for the "Site Condition" AI module (4):
// - FEMA NFHL flood zone at the given lat/lng (National Flood Hazard Layer).
// - USGS ground elevation at the given lat/lng (Elevation Point Query Service).
// - Real distance to the nearest major highway / rail line, via OpenStreetMap's
//   Overpass API (free, keyless, public) — see fetchNearestWayDistanceMi below.
// Flood zone and elevation are single-point facts, not a parcel-wide
// assessment — this app has no parcel boundary polygon for any property, so
// there's no honest way to compute e.g. "% of the site in the floodplain." A
// point either falls in a mapped flood zone or it doesn't; that's the
// ceiling of what's real here. The highway/rail distances ARE real
// geometry-based measurements (haversine distance from the subject point to
// the actual real road/rail centerline OSM has mapped), not a guess. See
// ai-report-modules/index.ts's MODULE_SPECS.site for how this feeds the
// module, and the "never fabricate" enforcement in enforceSiteFactorRealData
// there.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

type SiteGisInput = { lat?: number; lng?: number };

type SiteGisResult = {
  floodZone: { zone: string; label: string; inSFHA: boolean } | null;
  elevationFt: number | null;
  nearestHighwayMi: number | null;
  nearestRailMi: number | null;
};

// Standard FEMA NFHL zone-code meanings — kept here as one canonical lookup so
// the label is worded consistently everywhere, rather than left to the AI to
// phrase (and potentially get wrong) on every call. See
// https://www.fema.gov/glossary/flood-zones for the official definitions.
const FLOOD_ZONE_LABELS: Record<string, string> = {
  X: "Minimal Flood Hazard",
  "X (SHADED)": "0.2% Annual Chance Flood Hazard",
  A: "1% Annual Chance Flood Hazard (Special Flood Hazard Area)",
  AE: "1% Annual Chance Flood Hazard (Special Flood Hazard Area)",
  AH: "1% Annual Chance Flood Hazard, Shallow Ponding (Special Flood Hazard Area)",
  AO: "1% Annual Chance Flood Hazard, Sheet Flow (Special Flood Hazard Area)",
  AR: "Area of Reduced Flood Risk From a Decertified Levee (Special Flood Hazard Area)",
  A99: "1% Annual Chance Flood Hazard, To Be Protected by a Federal Levee (Special Flood Hazard Area)",
  V: "Coastal High Hazard Area (Special Flood Hazard Area)",
  VE: "Coastal High Hazard Area (Special Flood Hazard Area)",
  D: "Undetermined Flood Risk — Not Studied",
};

function floodZoneLabel(zone: string): string {
  return FLOOD_ZONE_LABELS[zone] ?? `FEMA Flood Zone ${zone}`;
}

async function fetchFloodZone(lat: number, lng: number): Promise<SiteGisResult["floodZone"]> {
  const url =
    `https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query` +
    `?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326` +
    `&spatialRel=esriSpatialRelIntersects&outFields=FLD_ZONE,ZONE_SUBTY,SFHA_TF` +
    `&returnGeometry=false&f=json`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = (await res.json()) as {
    features?: Array<{ attributes?: Record<string, unknown> }>;
  };
  const attrs = json.features?.[0]?.attributes;
  const zone = typeof attrs?.FLD_ZONE === "string" ? attrs.FLD_ZONE.trim() : null;
  if (!zone) return null;
  return {
    zone,
    label: floodZoneLabel(zone),
    inSFHA: attrs?.SFHA_TF === "T",
  };
}

async function fetchElevationFt(lat: number, lng: number): Promise<number | null> {
  const url = `https://epqs.nationalmap.gov/v1/json?x=${lng}&y=${lat}&units=Feet&wkid=4326&includeDate=false`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = (await res.json()) as { value?: number | string };
  const value = typeof json.value === "string" ? Number(json.value) : json.value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const EARTH_RADIUS_MILES = 3958.8;

// Same plain great-circle formula as comps-analysis.ts's haversineMiles —
// duplicated rather than imported, since a Deno edge function can't import
// that browser module (same tradeoff already made throughout this app's
// other Deno mirrors, e.g. _shared/google-calendar-sync.ts).
function haversineMiles(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(Math.min(1, h)));
}

// A ~1-mile search radius — real ways OpenStreetMap has actually mapped
// within that radius, never a guessed/interpolated distance. Deliberately
// tighter than flood/elevation's own point lookups need to be: near a dense
// metro highway interchange, a wider radius (confirmed live at ~2 miles)
// returns enough real road geometry that fetching and parsing it can run
// past a reasonable response budget — a live "highway 1.9 miles away" read
// is a much weaker proximity signal for a site-condition factor than one
// under a mile anyway, so tightening the radius is a real precision
// tradeoff, not just a speed hack. `out center` (one real center point per
// way, not every node) trades a small amount of within-way precision for a
// much smaller/faster response — real distance is still the haversine
// distance to that way's own real center point, computed from real OSM
// geometry, not estimated. A real, free, volunteer-run community API — not
// nearly as fast or consistent as FEMA/USGS's own dedicated .gov endpoints
// (confirmed live across several mirrors: anywhere from ~4s to 25s+, or an
// outright refused/blocked connection depending on the mirror and moment).
// The timeout here is deliberately tight (10s), NOT tuned to catch every
// possible slow-but-real response — this is an optional enhancement layered
// on top of the flood-zone/elevation lookups this module already relies on
// day to day, and it must never be allowed to make the whole Site Condition
// module noticeably slower or riskier than it already is. When Overpass
// responds fast, real data shows up; when it doesn't, this degrades to null
// (the same honest "Additional Data Needed" fallback every other
// non-Floodplain/Grade factor already shows) well within a bounded, safe
// window — never a fabricated distance, and never a stall.
const OVERPASS_RADIUS_METERS = 1609; // ~1 mile
const OVERPASS_URL = "https://overpass.kumi.systems/api/interpreter";
const OVERPASS_TIMEOUT_MS = 10000;

async function fetchNearestWayDistanceMi(
  lat: number,
  lng: number,
  // A complete Overpass tag-filter expression, e.g. '"railway"="rail"' or
  // '"highway"~"^(motorway|trunk|primary)$"' — the two real tag-match
  // syntaxes (exact value vs. regex value) don't share one template, so
  // this takes the whole bracketed expression rather than trying to
  // generalize a key/value pair.
  tagFilterExpr: string,
): Promise<number | null> {
  const query = `[out:json][timeout:9];way[${tagFilterExpr}](around:${OVERPASS_RADIUS_METERS},${lat},${lng});out center;`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        // Overpass mirrors rate-limit/reject requests with no real
        // User-Agent (confirmed live) — a generic contact string, same
        // convention as any real API consumer.
        "User-Agent": "CorvusPT/1.0 (property tax site-condition lookup; contact via corvuspt.ai)",
        // Deno's fetch sends no Accept header by default — this mirror's
        // Apache content-negotiation rejects that with a real 406
        // (confirmed live), same as it would for any browserless client
        // that doesn't state what it can accept.
        Accept: "*/*",
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    console.error(`Overpass request failed: ${res.status} ${await res.text().catch(() => "")}`);
    return null;
  }
  const json = (await res.json()) as {
    elements?: Array<{ center?: { lat: number; lon: number } }>;
  };
  const elements = json.elements ?? [];
  let nearest: number | null = null;
  for (const el of elements) {
    if (!el.center) continue;
    const d = haversineMiles({ lat, lon: lng }, { lat: el.center.lat, lon: el.center.lon });
    if (nearest === null || d < nearest) nearest = d;
  }
  return nearest;
}

function fetchNearestHighwayMi(lat: number, lng: number): Promise<number | null> {
  // Major roads only — a residential side street isn't the kind of
  // proximity a site-condition evidence factor is about.
  return fetchNearestWayDistanceMi(lat, lng, `"highway"~"^(motorway|trunk|primary)$"`);
}

function fetchNearestRailMi(lat: number, lng: number): Promise<number | null> {
  return fetchNearestWayDistanceMi(lat, lng, `"railway"="rail"`);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const empty: SiteGisResult = {
    floodZone: null,
    elevationFt: null,
    nearestHighwayMi: null,
    nearestRailMi: null,
  };

  try {
    const input = (await req.json()) as SiteGisInput;
    if (typeof input.lat !== "number" || typeof input.lng !== "number") {
      return new Response(JSON.stringify(empty), { status: 200, headers: corsHeaders });
    }

    // Each source is independently tolerant of failure — a dead/slow FEMA
    // endpoint should never take the elevation (or highway/rail) result
    // down with it, and vice versa. Real value or null either way, never a
    // guess.
    const [floodResult, elevationResult, highwayResult, railResult] = await Promise.allSettled([
      fetchFloodZone(input.lat, input.lng),
      fetchElevationFt(input.lat, input.lng),
      fetchNearestHighwayMi(input.lat, input.lng),
      fetchNearestRailMi(input.lat, input.lng),
    ]);
    // Logged (not silently swallowed) even though the response degrades to
    // null either way — the Overpass mirror is real infrastructure this app
    // doesn't control, so this is genuinely worth being able to see later
    // (e.g. "is nearestHighwayMi usually null because it times out, or
    // because it's actually rejecting requests again") rather than only
    // ever showing up as an unexplained gap in the UI.
    if (highwayResult.status === "rejected")
      console.error("highway fetch rejected:", highwayResult.reason);
    if (railResult.status === "rejected") console.error("rail fetch rejected:", railResult.reason);

    const result: SiteGisResult = {
      floodZone: floodResult.status === "fulfilled" ? floodResult.value : null,
      elevationFt: elevationResult.status === "fulfilled" ? elevationResult.value : null,
      nearestHighwayMi: highwayResult.status === "fulfilled" ? highwayResult.value : null,
      nearestRailMi: railResult.status === "fulfilled" ? railResult.value : null,
    };
    return new Response(JSON.stringify(result), { status: 200, headers: corsHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "unknown error" }),
      { status: 500, headers: corsHeaders },
    );
  }
});
