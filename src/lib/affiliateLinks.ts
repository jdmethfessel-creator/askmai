/**
 * Per-tier affiliate link generators.
 *
 *   1. feed       creator's own products table row (real affiliate URL)
 *   2. aggregator Skimlinks deep link wrapping a real merchant URL
 *   3. hotel      hotel affiliate (Booking / Expedia / Travelpayouts) or
 *                 plain Booking search when no creds are configured
 *   4. none       no link (restaurants, etc.)
 *
 * Hard rule: every link returned from this module must resolve to a real
 * merchant page. No fake hostnames, no placeholder paths.
 */

const CATEGORY_FALLBACK_SEARCH: Record<string, (q: string) => string> = {
  beauty: (q) => `https://www.sephora.com/search?keyword=${q}`,
  fashion: (q) => `https://www.mytheresa.com/en-us/search?q=${q}`,
  accessories: (q) => `https://www.mytheresa.com/en-us/search?q=${q}`,
  lifestyle: (q) => `https://www.saks.com/search?q=${q}`,
  home: (q) => `https://www.saks.com/search?q=${q}`,
};

const FAKE_URL_PATTERN =
  /example\.com|example\.org|\/out\/aggregator|\/out\/hotel|provider=stub/i;

/**
 * Final-stage guard. Any URL we hand back to a client must NEVER contain
 * fake hostnames or placeholder paths. If we somehow constructed one,
 * substitute the real-merchant fallback.
 */
function ensureRealUrl(url: string, realFallback: string): string {
  if (!url || FAKE_URL_PATTERN.test(url)) return realFallback;
  return url;
}

function sanitizeMerchantUrl(u: string | undefined): string | null {
  if (!u) return null;
  const trimmed = u.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  // Refuse already-affiliated URLs so we don't double-wrap.
  if (
    /click\.linksynergy\.com|go\.skimresources\.com|skimresources\.com|rakuten\.com|impact\.com|mavely\.com|shopstyle\.it/i.test(
      trimmed
    )
  ) {
    return null;
  }
  // Refuse fake/placeholder URLs even if the model emitted one.
  if (FAKE_URL_PATTERN.test(trimmed)) return null;
  return trimmed;
}

function fallbackMerchantUrl(p: {
  name: string;
  brand?: string;
  category?: string;
}): string {
  const q = encodeURIComponent(
    [p.brand, p.name].filter(Boolean).join(" ").trim() || "shopping"
  );
  const cat = (p.category ?? "").toLowerCase();
  const builder = CATEGORY_FALLBACK_SEARCH[cat];
  return builder
    ? builder(q)
    : `https://www.google.com/search?tbm=shop&q=${q}`;
}

/**
 * Build an outbound link for an off-catalog product.
 *
 * Behavior matrix:
 *   SKIMLINKS_PUBLISHER_ID  | model merchant_url | result
 *   ----------------------- | ------------------ | --------------------------------
 *   set                     | valid              | go.skimresources.com wrapping it
 *   set                     | missing/invalid    | go.skimresources.com wrapping a real merchant search URL
 *   not set                 | valid              | the merchant URL itself (real page)
 *   not set                 | missing/invalid    | a real merchant search URL
 */
export function generateAggregatorLink(args: {
  merchantUrl?: string;
  product: { name: string; brand?: string; category?: string };
  creatorSlug: string;
}): string {
  const realFallback = fallbackMerchantUrl(args.product);
  const merchant = sanitizeMerchantUrl(args.merchantUrl) ?? realFallback;

  let resolved: string;
  if (process.env.SKIMLINKS_PUBLISHER_ID) {
    const id = encodeURIComponent(process.env.SKIMLINKS_PUBLISHER_ID);
    const url = encodeURIComponent(merchant);
    const xcust = encodeURIComponent(args.creatorSlug);
    resolved = `https://go.skimresources.com/?id=${id}&xs=1&url=${url}&xcust=${xcust}`;
  } else if (
    process.env.MAVELY_API_KEY &&
    process.env.MAVELY_PARTNER_ID
  ) {
    // Real Mavely Deep Link API call goes here once we have it. Until then,
    // skip the network call and hand back the merchant URL directly so
    // clicks always land on a real page.
    resolved = merchant;
  } else {
    // No aggregator configured — link straight to the real merchant page.
    resolved = merchant;
  }

  return ensureRealUrl(resolved, realFallback);
}

/**
 * Hotel link generator. Always returns a real, resolvable URL.
 * Returns null only when there's no name to search on.
 */
export function generateHotelLink(
  hotelName: string,
  location?: string
): string | null {
  const name = hotelName?.trim();
  if (!name) return null;
  const q = encodeURIComponent(name);
  const loc = location ? encodeURIComponent(location.trim()) : "";

  // Real Booking.com search — works without affiliate ID, just unmonetized.
  const realFallback = `https://www.booking.com/searchresults.html?ss=${q}${
    loc ? `%20${loc}` : ""
  }`;

  let resolved: string;
  if (process.env.BOOKING_AFFILIATE_ID) {
    resolved = `${realFallback}&aid=${encodeURIComponent(
      process.env.BOOKING_AFFILIATE_ID
    )}`;
  } else if (process.env.EXPEDIA_AFFILIATE_ID) {
    resolved = `https://www.expedia.com/Hotel-Search?destination=${q}${
      loc ? `%2C%20${loc}` : ""
    }&affcid=${encodeURIComponent(process.env.EXPEDIA_AFFILIATE_ID)}`;
  } else if (process.env.TRAVELPAYOUTS_MARKER) {
    resolved = `https://search.hotellook.com/hotels?destination=${q}${
      loc ? `%20${loc}` : ""
    }&marker=${encodeURIComponent(process.env.TRAVELPAYOUTS_MARKER)}`;
  } else {
    resolved = realFallback;
  }

  return ensureRealUrl(resolved, realFallback);
}

export function activeProviders() {
  return {
    aggregator: process.env.SKIMLINKS_PUBLISHER_ID
      ? "skimlinks"
      : process.env.MAVELY_API_KEY
      ? "mavely"
      : "direct",
    hotel: process.env.BOOKING_AFFILIATE_ID
      ? "booking"
      : process.env.EXPEDIA_AFFILIATE_ID
      ? "expedia"
      : process.env.TRAVELPAYOUTS_MARKER
      ? "travelpayouts"
      : "direct-booking",
  } as const;
}
