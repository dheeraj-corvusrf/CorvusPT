import { invokeEdgeFunction } from "./edge-functions";

export type SiteGisResult = {
  floodZone: { zone: string; label: string; inSFHA: boolean } | null;
  elevationFt: number | null;
  // Real distance (miles) to the nearest major highway / rail line, via
  // OpenStreetMap's Overpass API — null whenever nothing real was found
  // within the search radius, or the (free, best-effort, sometimes slow)
  // lookup didn't come back in time. Never a fabricated/estimated distance.
  nearestHighwayMi: number | null;
  nearestRailMi: number | null;
};

// Real point-in-place site facts (FEMA flood zone + USGS elevation +
// OSM highway/rail proximity) for a property's exact lat/lng — see
// supabase/functions/site-gis/index.ts for the upstream sources and why
// this proxies through an edge function instead of calling them directly
// from the browser. Only ever called once a real lat/lng exists (see
// loadSiteGis() in ai-report.tsx) — there is no fallback geocoding here,
// matching getComps()'s same honest-gap posture.
export async function getSiteGis(input: { lat: number; lng: number }): Promise<SiteGisResult> {
  return invokeEdgeFunction<SiteGisResult>("site-gis", input);
}
