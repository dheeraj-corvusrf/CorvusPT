import { describe, it, expect, vi, beforeEach } from "vitest";
import { geocodeAddress } from "./geocode";

// VITE_GOOGLE_MAPS_API_KEY is unset in the test environment (see
// vitest.config.ts — no VITE_* env is injected), so geocodeWithGoogle always
// short-circuits to null without ever calling fetch, same as it would in a
// real deployment with no key configured. These tests exercise the
// Nominatim fallback path that's actually reachable here.
const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

describe("geocodeAddress", () => {
  it("returns real coordinates from Nominatim's first result", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [{ lat: "30.6333", lon: "-97.6772" }],
    });
    const point = await geocodeAddress("2601 W University Ave, Georgetown, TX 78628");
    expect(point).toEqual({ lat: 30.6333, lng: -97.6772 });
  });

  it("returns null when Nominatim has no match, rather than a guess", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => [] });
    const point = await geocodeAddress("Not a real address");
    expect(point).toBeNull();
  });

  it("returns null when the request fails", async () => {
    mockFetch.mockResolvedValue({ ok: false });
    const point = await geocodeAddress("2601 W University Ave, Georgetown, TX 78628");
    expect(point).toBeNull();
  });

  it("returns null on a network error, never throwing", async () => {
    mockFetch.mockRejectedValue(new Error("network down"));
    await expect(geocodeAddress("2601 W University Ave, Georgetown, TX 78628")).resolves.toBeNull();
  });
});
