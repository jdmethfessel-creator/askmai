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

/**
 * Brand-specific search URLs for mass/contemporary brands that don't sell
 * on Mytheresa. A brand's OWN site always carries its own products, so
 * these searches never dead-end. The product name (without brand) is the
 * search query, since we're already on the brand's domain.
 */
const BRAND_DOMAINS: Record<string, (productName: string) => string> = {
  zara: (q) =>
    `https://www.zara.com/us/en/search?searchTerm=${encodeURIComponent(q)}`,
  "& other stories": (q) =>
    `https://www.stories.com/en_usd/search.html?q=${encodeURIComponent(q)}`,
  "and other stories": (q) =>
    `https://www.stories.com/en_usd/search.html?q=${encodeURIComponent(q)}`,
  "other stories": (q) =>
    `https://www.stories.com/en_usd/search.html?q=${encodeURIComponent(q)}`,
  // Mango deliberately omitted — their site drops the query string on geo
  // redirect, so a search URL dead-ends to a homepage. Google Shopping
  // fallback handles Mango products live.
  cos: (q) =>
    `https://www.cos.com/en_usd/search-result.html?q=${encodeURIComponent(q)}`,
  "h&m": (q) =>
    `https://www2.hm.com/en_us/search-results.html?q=${encodeURIComponent(q)}`,
  hm: (q) =>
    `https://www2.hm.com/en_us/search-results.html?q=${encodeURIComponent(q)}`,
  reformation: (q) =>
    `https://www.thereformation.com/search?q=${encodeURIComponent(q)}`,
  aritzia: (q) =>
    `https://www.aritzia.com/us/en/search?q=${encodeURIComponent(q)}`,
  sezane: (q) =>
    `https://www.sezane.com/en/search?q=${encodeURIComponent(q)}`,
  "sézane": (q) =>
    `https://www.sezane.com/en/search?q=${encodeURIComponent(q)}`,
  madewell: (q) =>
    `https://www.madewell.com/search?q=${encodeURIComponent(q)}`,
  everlane: (q) =>
    `https://www.everlane.com/search?q=${encodeURIComponent(q)}`,
  abercrombie: (q) =>
    `https://www.abercrombie.com/shop/us/search?searchPhrase=${encodeURIComponent(
      q
    )}`,
  "free people": (q) =>
    `https://www.freepeople.com/search?q=${encodeURIComponent(q)}`,
};

/**
 * Luxury and contemporary brands Mytheresa actually stocks. Only these can
 * safely fall back to a Mytheresa search. Anything not on this list does
 * NOT get the Mytheresa fallback (that was the dead-link bug).
 */
const MYTHERESA_BRANDS = new Set(
  [
    "the row",
    "khaite",
    "toteme",
    "totême",
    "lemaire",
    "loewe",
    "saint laurent",
    "ysl",
    "alaia",
    "alaïa",
    "isabel marant",
    "acne studios",
    "dion lee",
    "the frankie shop",
    "frankie shop",
    "by far",
    "paris texas",
    "gianvito rossi",
    "victoria beckham",
    "balenciaga",
    "bottega veneta",
    "celine",
    "céline",
    "fendi",
    "givenchy",
    "prada",
    "miu miu",
    "valentino",
    "chloe",
    "chloé",
    "wardrobe.nyc",
    "phoebe philo",
    "sandy liang",
    "ganni",
    "dries van noten",
    "rick owens",
    "jacquemus",
    "stella mccartney",
    "tom ford",
    "ferragamo",
    "salvatore ferragamo",
    "marc jacobs",
    "rachel gilbert",
    "mugler",
    "nour hammour",
    "khaite",
    "mytheresa",
  ].map((b) => b.toLowerCase())
);

function normalizeBrand(b: string | undefined): string {
  return (b ?? "").trim().toLowerCase();
}

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
  const brand = normalizeBrand(p.brand);
  const productName = (p.name ?? "").trim() || "shopping";
  const fullQuery = [p.brand, p.name].filter(Boolean).join(" ").trim() ||
    "shopping";

  // 1. Brand owns its own searchable domain — always live for its products.
  if (brand && BRAND_DOMAINS[brand]) {
    return BRAND_DOMAINS[brand](productName);
  }

  // 2. Confirmed luxury brand Mytheresa stocks — search there.
  if (brand && MYTHERESA_BRANDS.has(brand)) {
    return `https://www.mytheresa.com/en-us/search?q=${encodeURIComponent(
      fullQuery
    )}`;
  }

  // 3. Category-aware safe fallbacks for known broad merchants.
  const cat = (p.category ?? "").toLowerCase();
  if (cat === "beauty") {
    // Sephora stocks most beauty brands and is in the Skimlinks network.
    return `https://www.sephora.com/search?keyword=${encodeURIComponent(
      fullQuery
    )}`;
  }
  if (cat === "lifestyle" || cat === "home") {
    return `https://www.saks.com/search?q=${encodeURIComponent(fullQuery)}`;
  }

  // 4. Unknown brand / fashion category we can't confirm — Google Shopping
  //    never dead-ends for a real product name. Mytheresa is intentionally
  //    NOT the catch-all anymore.
  return `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(
    fullQuery
  )}`;
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

/**
 * Pure search URLs for place actions. All resolve to a real page — they're
 * just search results, not guessed direct restaurant slugs.
 */
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
