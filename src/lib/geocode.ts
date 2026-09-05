// Forward-geocodes a Texas property address to real coordinates — the
// fallback for every county getComps() has no comps platform for (see its
// own comment: only Denton/Montgomery/Tarrant/Travis have a real CAD
// subject/lat-lng today). Without this, Module 4 (Site Condition)'s map
// thumbnail and its FEMA-flood/USGS-elevation/highway-rail lookups (see
// site-gis.ts) have no coordinates to run on at all for every other county,
// even though those lookups themselves don't care where the lat/lng came
// from.
//
// Google's Geocoding REST API first (the same VITE_GOOGLE_MAPS_API_KEY
// AddressAutocomplete already uses for Places — a plain fetch, not the full
// Maps JS SDK, since this only ever needs one address-to-lat/lng answer, not
// a map to render), falling back to free, keyless Nominatim — the same
// dual-source pattern AddressAutocomplete already relies on for
// suggestions. Never fabricates a location: returns null, not a guess, if
// both sources fail (no key, API not enabled on this Google Cloud project,
// network error, or genuinely no match).
export type GeocodedPoint = { lat: number; lng: number };

const GOOGLE_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;

async function geocodeWithGoogle(address: string): Promise<GeocodedPoint | null> {
  if (!GOOGLE_API_KEY) return null;
  const params = new URLSearchParams({
    address,
    // Same Texas-only scope as AddressAutocomplete's own TEXAS_RECTANGLE —
    // this app has no data for anything outside Texas anyway.
    components: "administrative_area:TX|country:US",
    key: GOOGLE_API_KEY,
  });
  const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params}`);
  if (!res.ok) return null;
  const data = (await res.json()) as {
    status: string;
    results?: Array<{ geometry?: { location?: { lat: number; lng: number } } }>;
  };
  const location = data.status === "OK" ? data.results?.[0]?.geometry?.location : null;
  return location ? { lat: location.lat, lng: location.lng } : null;
}

async function geocodeWithNominatim(address: string): Promise<GeocodedPoint | null> {
  const params = new URLSearchParams({
    format: "jsonv2",
    countrycodes: "us",
    limit: "1",
    q: address,
  });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
  if (!res.ok) return null;
  const data = (await res.json()) as Array<{ lat: string; lon: string }>;
  const first = data[0];
  return first ? { lat: Number(first.lat), lng: Number(first.lon) } : null;
}

export async function geocodeAddress(address: string): Promise<GeocodedPoint | null> {
  try {
    const fromGoogle = await geocodeWithGoogle(address);
    if (fromGoogle) return fromGoogle;
  } catch {
    // Falls through to Nominatim below — same "expected, recoverable"
    // treatment AddressAutocomplete gives a blocked/failed Google call.
  }
  try {
    return await geocodeWithNominatim(address);
  } catch {
    return null;
  }
}
