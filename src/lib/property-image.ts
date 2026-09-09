// A real photo of the subject property from Google Street View, for the
// module cards that currently show a generic building illustration (Module 5
// — Improvement Condition). Uses the same VITE_GOOGLE_MAPS_API_KEY the
// geocoder/Places autocomplete already use.
//
// Two calls:
//  - streetViewAvailable(): the FREE Street View metadata endpoint — tells us
//    whether Google actually has outdoor imagery at this address before we
//    load (and pay for) the image. A location with no imagery still returns a
//    200 "no image" placeholder from the image endpoint, so an <img> onError
//    handler alone can't detect it — the metadata check is what makes the
//    "fall back to an illustration" decision honest.
//  - streetViewImageUrl(): the billed static-image URL, only built once
//    metadata said OK.
//
// Never fabricates: no key, no imagery, or a failed request -> null/false and
// the caller shows its illustration fallback.
const KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;

// Per-session cache of the metadata answer, keyed by normalized address —
// the same card re-mounts on tab focus / re-render, and the answer never
// changes within a session.
const availabilityCache = new Map<string, boolean>();

export function streetViewImageUrl(address: string, width = 400, height = 220): string | null {
  const a = address.trim();
  if (!KEY || !a) return null;
  const params = new URLSearchParams({
    size: `${Math.round(width)}x${Math.round(height)}`,
    location: a,
    fov: "80",
    // Prefer real outdoor photography over user-contributed indoor/360 shots.
    source: "outdoor",
    return_error_code: "true",
    key: KEY,
  });
  return `https://maps.googleapis.com/maps/api/streetview?${params.toString()}`;
}

export async function streetViewAvailable(address: string | null | undefined): Promise<boolean> {
  const a = (address ?? "").trim();
  if (!KEY || !a) return false;
  const cacheKey = a.toLowerCase();
  const cached = availabilityCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const params = new URLSearchParams({ location: a, source: "outdoor", key: KEY });
    const res = await fetch(
      `https://maps.googleapis.com/maps/api/streetview/metadata?${params.toString()}`,
    );
    if (!res.ok) {
      availabilityCache.set(cacheKey, false);
      return false;
    }
    const data = (await res.json()) as { status?: string };
    const ok = data.status === "OK";
    availabilityCache.set(cacheKey, ok);
    return ok;
  } catch {
    return false;
  }
}
