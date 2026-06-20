/**
 * Per-tier affiliate link generators.
 *
 *   1. feed       creator's own products table row (real affiliate URL)
 *   2. aggregator live Serper-resolved real product URL (Skimlinks-wrapped
 *                 when host is in our affiliate network); falls back to a
 *                 brand-own-site search URL or Google Shopping
 *   3. hotel      hotel affiliate (Booking / Expedia / Travelpayouts) or
 *                 plain Booking search when no creds are configured
 *   4. place      restaurant / cafe — Reserve / Directions / Menu search URLs
 *   5. none       no link (fallback only)
 */

import {
  BRAND_DOMAINS,
  LUXURY_BRANDS as MYTHERESA_BRANDS,
  fallbackSearchUrl,
  normalizeBrand,
} from "./affiliateBrands";

const FAKE_URL_PATTERN =
  /example\.com|example\.org|\/out\/aggregator|\/out\/hotel|provider=stub/i;

function ensureRealUrl(url: string, realFallback: string): string {
  if (!url || FAKE_URL_PATTERN.test(url)) return realFallback;
  return url;
}

function sanitizeMerchantUrl(u: string | undefined): string | null {
  if (!u) return null;
  const trimmed = u.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  if (
    /click\.linksynergy\.com|go\.skimresources\.com|skimresources\.com|rakuten\.com|impact\.com|mavely\.com|shopstyle\.it/i.test(
      trimmed
    )
  ) {
    return null;
  }
  if (FAKE_URL_PATTERN.test(trimmed)) return null;
  return trimmed;
}

function fallbackMerchantUrl(p: {
  name: string;
  brand?: string;
  category?: string;
}): string {
  // Category-aware safe fallbacks (beauty → Sephora, lifestyle → Saks)
  // happen first because beauty often has no brand or unmapped brand.
  const cat = (p.category ?? "").toLowerCase();
  const brand = normalizeBrand(p.brand);
  const fullQuery =
    [p.brand, p.name].filter(Boolean).join(" ").trim() || "shopping";

  if (brand && BRAND_DOMAINS[brand]) {
    return BRAND_DOMAINS[brand]((p.name ?? "").trim() || "shopping");
  }
  if (brand && MYTHERESA_BRANDS.has(brand)) {
    return `https://www.mytheresa.com/en-us/search?q=${encodeURIComponent(
      fullQuery
    )}`;
  }
  if (cat === "beauty") {
    return `https://www.sephora.com/search?keyword=${encodeURIComponent(
      fullQuery
    )}`;
  }
  if (cat === "lifestyle" || cat === "home") {
    return `https://www.saks.com/search?q=${encodeURIComponent(fullQuery)}`;
  }
  return fallbackSearchUrl(p.brand, p.name);
}

/**
 * Legacy entry point — used by the dining/travel paths and as a final
 * fallback when Serper isn't applicable. The Serper-backed live resolution
 * for aggregator-tier products goes through resolveLink.ts directly, not
 * this helper.
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
    resolved = merchant;
  } else {
    resolved = merchant;
  }

  return ensureRealUrl(resolved, realFallback);
}

/**
 * Hotel link generator. Always returns a real, resolvable URL.
 */
export function generateHotelLink(
  hotelName: string,
  location?: string
): string | null {
  const name = hotelName?.trim();
  if (!name) return null;
  const q = encodeURIComponent(name);
  const loc = location ? encodeURIComponent(location.trim()) : "";

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

export function openTableSearchUrl(name: string, location?: string): string {
  const term = [name?.trim(), location?.trim()].filter(Boolean).join(" ");
  return `https://www.opentable.com/s?term=${encodeURIComponent(
    term || name || ""
  )}`;
}

export function googleMapsSearchUrl(
  name: string,
  location?: string
): string {
  const q = [name?.trim(), location?.trim()].filter(Boolean).join(" ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    q || name || ""
  )}`;
}

export function menuSearchUrl(name: string, location?: string): string {
  const q = [name?.trim(), location?.trim(), "menu"]
    .filter(Boolean)
    .join(" ");
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

export function activeProviders() {
  return {
    aggregator: process.env.SERPER_API_KEY
      ? "serper+skimlinks"
      : process.env.SKIMLINKS_PUBLISHER_ID
      ? "skimlinks"
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
