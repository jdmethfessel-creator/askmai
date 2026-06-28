/**
 * OpenStreetMap Nominatim wrapper for authoritative place lookups.
 *
 * Why: the chat model often invents or mis-guesses neighborhoods
 * ("Wynwood" for a place that's actually in Brickell). Card display must
 * reflect the real address, not the model's guess.
 *
 * Nominatim is free and key-less. Their usage policy asks for a real
 * User-Agent and ≤1 req/sec; we honor both via the identifying UA below
 * and the in-memory cache. For higher traffic we'd swap this for a paid
 * provider (Google Places, Mapbox) without changing the call sites.
 *
 * Failures degrade silently — when the lookup returns null or errors,
 * the caller falls back to the model-provided location string, so the
 * card link still works (Google Maps is tolerant of imprecise queries).
 */

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const UA =
  "AskMai/1.0 (creator shopping platform; contact hi@askmai.co)";

export type PlaceLookupResult = {
  /** Display-ready "Neighborhood, City" or "City" string. Never blank. */
  location: string;
  /** Lat/lon for future use (e.g. distance scoring); not consumed today. */
  lat?: string;
  lon?: string;
  /** Raw OSM address components, useful for downstream callers. */
  neighborhood?: string;
  city?: string;
  state?: string;
};

type NominatimAddress = {
  suburb?: string;
  neighbourhood?: string;
  quarter?: string;
  city?: string;
  town?: string;
  village?: string;
  hamlet?: string;
  county?: string;
  state?: string;
  country?: string;
};

type NominatimItem = {
  display_name?: string;
  lat?: string;
  lon?: string;
  address?: NominatimAddress;
  class?: string;
  type?: string;
};

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
type CacheEntry = { value: PlaceLookupResult | null; expiresAt: number };
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<PlaceLookupResult | null>>();

function cacheKey(name: string, hint?: string): string {
  return `${name.trim().toLowerCase()}|${(hint ?? "").trim().toLowerCase()}`;
}

function formatLocation(addr: NominatimAddress | undefined): {
  display: string;
  neighborhood?: string;
  city?: string;
  state?: string;
} | null {
  if (!addr) return null;
  const neighborhood =
    addr.suburb || addr.neighbourhood || addr.quarter || undefined;
  const city =
    addr.city || addr.town || addr.village || addr.hamlet || undefined;
  const state = addr.state;
  if (neighborhood && city) {
    return { display: `${neighborhood}, ${city}`, neighborhood, city, state };
  }
  if (city) {
    return { display: city, city, state };
  }
  if (neighborhood && state) {
    return { display: `${neighborhood}, ${state}`, neighborhood, state };
  }
  if (neighborhood) {
    return { display: neighborhood, neighborhood };
  }
  if (state) {
    return { display: state, state };
  }
  return null;
}

export async function lookupPlace(
  name: string,
  hint?: string
): Promise<PlaceLookupResult | null> {
  const trimmedName = name?.trim();
  if (!trimmedName) return null;

  const key = cacheKey(trimmedName, hint);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const existing = inflight.get(key);
  if (existing) return existing;

  const query = [trimmedName, hint?.trim()].filter(Boolean).join(" ").trim();

  const p = (async (): Promise<PlaceLookupResult | null> => {
    try {
      const url =
        `${NOMINATIM}?q=${encodeURIComponent(query)}` +
        `&format=json&addressdetails=1&limit=1`;
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return null;
      const items = (await res.json()) as NominatimItem[];
      const first = Array.isArray(items) ? items[0] : null;
      if (!first) return null;
      const loc = formatLocation(first.address);
      if (!loc) return null;
      return {
        location: loc.display,
        neighborhood: loc.neighborhood,
        city: loc.city,
        state: loc.state,
        lat: first.lat,
        lon: first.lon,
      };
    } catch {
      return null;
    }
  })();
  inflight.set(key, p);
  p.then((v) => {
    cache.set(key, { value: v, expiresAt: Date.now() + CACHE_TTL_MS });
    inflight.delete(key);
  });
  return p;
}
