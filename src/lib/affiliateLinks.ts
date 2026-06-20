/**
 * Per-tier affiliate link generators.
 *
 *   1. feed       creator's own products table row (real affiliate URL)
 *   2. aggregator Skimlinks deep link wrapping a merchant URL
 *   3. hotel      hotel affiliate (stub today)
 *   4. none       no link (restaurants, etc.)
 */

const PROVIDERS = {
  aggregator: process.env.MAVELY_API_KEY
    ? "mavely"
    : process.env.SKIMLINKS_PUBLISHER_ID
    ? "skimlinks"
    : "stub",
  hotel: process.env.BOOKING_AFFILIATE_ID
    ? "booking"
    : process.env.EXPEDIA_AFFILIATE_ID
    ? "expedia"
    : process.env.TRAVELPAYOUTS_MARKER
    ? "travelpayouts"
    : "stub",
} as const;

const CATEGORY_FALLBACK_SEARCH: Record<string, (q: string) => string> = {
  beauty: (q) => `https://www.sephora.com/search?keyword=${q}`,
  fashion: (q) => `https://www.mytheresa.com/us/en/search?q=${q}`,
  accessories: (q) => `https://www.mytheresa.com/us/en/search?q=${q}`,
  lifestyle: (q) => `https://www.saksfifthavenue.com/search?q=${q}`,
};

/** Skimlinks deep-link format: go.skimresources.com/?id=…&xs=1&url=…&xcust=… */
export function generateAggregatorLink(args: {
  merchantUrl?: string;
  product: { name: string; brand?: string; category?: string };
  creatorSlug: string;
}): string {
  const merchantUrl =
    sanitizeMerchantUrl(args.merchantUrl) ??
    fallbackMerchantUrl(args.product);

  if (PROVIDERS.aggregator === "skimlinks" && process.env.SKIMLINKS_PUBLISHER_ID) {
    const id = encodeURIComponent(process.env.SKIMLINKS_PUBLISHER_ID);
    const url = encodeURIComponent(merchantUrl);
    const xcust = encodeURIComponent(args.creatorSlug);
    return `https://go.skimresources.com/?id=${id}&xs=1&url=${url}&xcust=${xcust}`;
  }

  if (PROVIDERS.aggregator === "mavely" && process.env.MAVELY_PARTNER_ID) {
    // TODO: real Mavely Deep Link API.
    const url = encodeURIComponent(merchantUrl);
    return `https://link.mavely.com/d?partner=${encodeURIComponent(
      process.env.MAVELY_PARTNER_ID
    )}&url=${url}&xcust=${encodeURIComponent(args.creatorSlug)}&provider=mavely`;
  }

  return `https://askmai.example.com/out/aggregator?url=${encodeURIComponent(
    merchantUrl
  )}&xcust=${encodeURIComponent(args.creatorSlug)}&provider=stub`;
}

function sanitizeMerchantUrl(u: string | undefined): string | null {
  if (!u) return null;
  const trimmed = u.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  // Don't allow already-affiliated links to be re-wrapped.
  if (/click\.linksynergy\.com|go\.skimresources\.com|skimresources\.com|rakuten\.com|impact\.com|mavely\.com|shopstyle\.it/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function fallbackMerchantUrl(p: {
  name: string;
  brand?: string;
  category?: string;
}): string {
  const q = encodeURIComponent(
    [p.brand, p.name].filter(Boolean).join(" ")
  );
  const cat = (p.category ?? "").toLowerCase();
  const builder = CATEGORY_FALLBACK_SEARCH[cat];
  return builder
    ? builder(q)
    : `https://www.google.com/search?tbm=shop&q=${q}`;
}

export function generateHotelLink(
  hotelName: string,
  location?: string
): string | null {
  const name = hotelName?.trim();
  if (!name) return null;
  const q = encodeURIComponent(name);
  const loc = location ? encodeURIComponent(location) : "";

  if (PROVIDERS.hotel === "booking" && process.env.BOOKING_AFFILIATE_ID) {
    return `https://www.booking.com/searchresults.html?ss=${q}${
      loc ? `+${loc}` : ""
    }&aid=${encodeURIComponent(process.env.BOOKING_AFFILIATE_ID)}&provider=booking`;
  }

  if (PROVIDERS.hotel === "expedia" && process.env.EXPEDIA_AFFILIATE_ID) {
    return `https://www.expedia.com/Hotel-Search?destination=${q}${
      loc ? `,+${loc}` : ""
    }&affcid=${encodeURIComponent(process.env.EXPEDIA_AFFILIATE_ID)}&provider=expedia`;
  }

  if (PROVIDERS.hotel === "travelpayouts" && process.env.TRAVELPAYOUTS_MARKER) {
    return `https://search.hotellook.com/hotels?destination=${q}${
      loc ? `+${loc}` : ""
    }&marker=${encodeURIComponent(process.env.TRAVELPAYOUTS_MARKER)}&provider=travelpayouts`;
  }

  return `https://askmai.example.com/out/hotel?name=${q}${
    loc ? `&loc=${loc}` : ""
  }&provider=stub`;
}

export function activeProviders() {
  return PROVIDERS;
}
