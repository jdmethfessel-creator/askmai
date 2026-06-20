/**
 * Per-tier link generators.
 *
 * Tier order (handled by resolveLink):
 *   1. feed       creator's own products table row (real affiliate URL)
 *   2. aggregator universal fashion/beauty aggregator (Mavely or Skimlinks)
 *   3. hotel      hotel affiliate (Booking / Expedia / Travelpayouts)
 *   4. none       no link (restaurants, general lifestyle, etc.)
 *
 * Today the aggregator/hotel functions are STUBS that return a clearly-marked
 * placeholder URL, structured so real credentials can be dropped in via env
 * vars without changing call sites.
 */

const PROVIDERS = {
  aggregator: process.env.MAVELY_API_KEY
    ? "mavely"
    : process.env.SKIMLINKS_API_KEY
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

/**
 * Universal aggregator link for off-feed fashion/beauty products.
 * Today: returns a stub URL marked with provider=stub.
 * Later: implement Mavely Deep Link API or Skimlinks SkimLink API.
 */
export function generateAggregatorLink(product: {
  name: string;
  brand?: string;
  category?: string;
}): string {
  const q = encodeURIComponent(
    [product.brand, product.name].filter(Boolean).join(" ")
  );

  if (PROVIDERS.aggregator === "mavely" && process.env.MAVELY_PARTNER_ID) {
    // TODO: replace with real Mavely Deep Link call:
    // POST https://api.mavely.com/v1/deeplinks { partner_id, query }
    return `https://link.mavely.com/d?partner=${encodeURIComponent(
      process.env.MAVELY_PARTNER_ID
    )}&q=${q}&provider=mavely`;
  }

  if (
    PROVIDERS.aggregator === "skimlinks" &&
    process.env.SKIMLINKS_PUBLISHER_ID
  ) {
    // TODO: replace with Skimlinks SkimLink API.
    return `https://go.skimresources.com/?xs=1&id=${encodeURIComponent(
      process.env.SKIMLINKS_PUBLISHER_ID
    )}&xcust=askmai&url=${q}&provider=skimlinks`;
  }

  return `https://askmai.example.com/out/aggregator?q=${q}&provider=stub`;
}

/**
 * Hotel affiliate link. Returns null when the property isn't booking-ready
 * (no name match, vague vibe-only recommendation, etc.).
 *
 * Today: returns a stub URL marked with provider=stub when both args are
 * present; null otherwise.
 * Later: implement Booking.com / Expedia / Travelpayouts deep links.
 */
export function generateHotelLink(
  hotelName: string,
  location?: string
): string | null {
  const name = hotelName?.trim();
  if (!name) return null;
  const q = encodeURIComponent(name);
  const loc = location ? encodeURIComponent(location) : "";

  if (PROVIDERS.hotel === "booking" && process.env.BOOKING_AFFILIATE_ID) {
    // TODO: real Booking.com partner deep link.
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
