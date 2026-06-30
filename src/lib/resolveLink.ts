import { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "./supabase";
import {
  generateAggregatorLink,
  generateHotelLink,
  googleMapsSearchUrl,
  menuSearchUrl,
  openTableSearchUrl,
} from "./affiliateLinks";
import { resolveProductLive, wrapIfInNetwork } from "./productLive";
import { lookupPlace } from "./placeLookup";
import type { LinkTier, Rec } from "./types";

export type ResolvedLink = {
  url: string | null;
  tier: LinkTier;
  matched_product_id?: string;
  /** Authoritative product fields from the catalog when feed-matched. */
  feed_product?: {
    name: string;
    brand: string | null;
    price: string | null;
    image_url: string | null;
  };
  /**
   * Populated for tier="aggregator" when Serper resolved a live 1:1 product
   * link. The server replaces the model's claimed price + image with these
   * authoritative values; brandMatched indicates the link is on the brand's
   * own canonical domain (vs. a fallback search).
   */
  live_product?: {
    realPrice: string | null;
    realImage: string | null;
    brandMatched: boolean;
    wrapped: boolean; // always false now (the platform no longer wraps off-catalog merchant URLs); kept for back-compat with consumers
    source: string;
  };
  /**
   * Populated for tier="place" — secondary actions on the card. The primary
   * action lives on `url` (Reserve if reservable, otherwise Directions).
   */
  place_links?: {
    directions: string;
    menu: string;
    reservable: boolean;
  };
  /**
   * Set for tier="place" when the OSM Nominatim lookup found a real
   * neighborhood/city. The chat route overrides the model-provided
   * rec.location with this so the card displays the authoritative
   * address rather than the model's guess.
   */
  resolved_location?: string;
};

const FEED_BACKED_CATEGORIES = new Set([
  "fashion",
  "beauty",
  "accessories",
  "lifestyle",
]);

const RESTAURANT_KEYWORDS = ["restaurant", "dining", "bar", "cafe"];

type OwnedBrand = {
  name: string;
  aliases?: string[];
  store_url: string;
  category?: string;
  /**
   * "app" → link straight to store_url (no /search?q= path; the store
   * isn't a Shopify product catalog).
   * undefined → default Shopify product-search behavior.
   */
  type?: "app" | "shopify" | string;
};

function findOwnedBrandMatch(
  recBrand: string | undefined,
  taste: unknown
): OwnedBrand | null {
  if (!recBrand || !taste || typeof taste !== "object") return null;
  const identity = (taste as Record<string, unknown>).identity;
  if (!identity || typeof identity !== "object") return null;
  const brands = (identity as Record<string, unknown>).owned_brands;
  if (!Array.isArray(brands)) return null;
  const lower = recBrand.trim().toLowerCase();
  for (const b of brands as OwnedBrand[]) {
    if (!b || typeof b !== "object" || !b.store_url || !b.name) continue;
    const candidates = [b.name, ...(b.aliases ?? [])]
      .map((s) => (s ?? "").trim().toLowerCase())
      .filter(Boolean);
    if (candidates.some((c) => c === lower || lower.startsWith(c + " ") || lower.endsWith(" " + c))) {
      return b;
    }
  }
  return null;
}

/**
 * For owned brands whose store IS a Shopify catalog (e.g. WeWoreWhat),
 * try to match the model's paraphrased product name against the creator's
 * actual catalog before falling back to the store's /search?q=. The model
 * often writes "Strapless Foldover Midi Dress in ivory" instead of the
 * exact catalog name "Strapless Foldover Midi Dress - Ivory/Beige"; this
 * function token-matches within the SAME brand so we always land on the
 * real product page when one exists.
 */
async function findOwnedCatalogMatch(
  sb: SupabaseClient,
  creatorId: string,
  brand: OwnedBrand,
  productName: string
): Promise<{
  id: string;
  name: string;
  brand: string | null;
  price: number | null;
  affiliate_url: string;
  image_url: string | null;
  network: string | null;
} | null> {
  const target = (productName ?? "")
    .toLowerCase()
    .split(/[\s\-/_,]+/)
    .filter((t) => t.length > 2);
  if (target.length === 0) return null;

  const { data } = await sb
    .from("products")
    .select("id, name, brand, price, affiliate_url, image_url, network")
    .eq("creator_id", creatorId)
    .eq("network", "shopify_owned");
  if (!data || data.length === 0) return null;

  let best: typeof data[number] | null = null;
  let bestScore = 0;
  for (const row of data) {
    if (!row.affiliate_url) continue;
    const candTokens = (row.name ?? "")
      .toLowerCase()
      .split(/[\s\-/_,]+/)
      .filter(Boolean);
    if (candTokens.length === 0) continue;
    const candSet = new Set(candTokens);
    let overlap = 0;
    for (const t of target) if (candSet.has(t)) overlap++;
    if (overlap > bestScore) {
      bestScore = overlap;
      best = row;
    }
  }
  // Require enough overlap that we're confident — at least 3 tokens AND
  // half of the target tokens hit.
  const minRequired = Math.max(3, Math.ceil(target.length * 0.5));
  if (bestScore < minRequired || !best) return null;
  return best as {
    id: string;
    name: string;
    brand: string | null;
    price: number | null;
    affiliate_url: string;
    image_url: string | null;
    network: string | null;
  };
}

function ownedStoreLink(brand: OwnedBrand, productName: string): string {
  // App-type owned brands (e.g. Tezza photo editing app at shoptezza.com)
  // are single-product stores; a /search?q= path would 404. Link straight
  // to the homepage.
  if (brand.type === "app") return brand.store_url;
  // Shopify storefronts universally support /search?q= for product-name lookup.
  const trimmed = (productName ?? "").trim();
  if (!trimmed) return brand.store_url;
  const base = brand.store_url.replace(/\/+$/, "");
  return `${base}/search?q=${encodeURIComponent(trimmed)}`;
}

/**
 * Resolves a recommendation to one of four tiers:
 *
 *   feed       — rec.product_id exists in this creator's products table
 *   aggregator — fashion/beauty/accessories with no catalog match (bare merchant URL)
 *   hotel      — travel category
 *   none       — dining / non-monetizable
 *
 * Feed matching is EXACT-ID ONLY. The model is given the catalog in the
 * system prompt and must reference picks by id. We never fuzzy-match.
 *
 * Every call logs a 'recommendation' event with the tier.
 */
export async function resolveLink(
  rec: Rec,
  creator: { id: string; slug: string; taste_profile?: unknown },
  meta: Record<string, unknown> = {}
): Promise<ResolvedLink> {
  const creatorId = creator.id;
  const sb = supabaseAdmin();

  // Tier 0 (highest priority): creator-owned brand. ALWAYS card, never
  // wrap with an affiliate network — it's her own store, full margin.
  const owned = findOwnedBrandMatch(rec.brand, creator.taste_profile);
  if (owned) {
    // shopify_catalog brands: try to land on the actual product page in
    // the creator's catalog. The model often paraphrases names; we
    // token-match within the same brand to find the right product.
    if (owned.type === "shopify_catalog") {
      const match = await findOwnedCatalogMatch(
        sb,
        creatorId,
        owned,
        rec.name
      );
      if (match) {
        await logEvent(sb, creatorId, "owned_feed", {
          ...meta,
          rec_name: match.name,
          product_id: match.id,
          resolved_url: match.affiliate_url,
        });
        return {
          url: match.affiliate_url,
          tier: "owned_feed",
          matched_product_id: match.id,
          feed_product: {
            name: match.name,
            brand: match.brand,
            price: match.price != null ? `$${match.price}` : null,
            image_url: match.image_url,
          },
        };
      }
    }
    const url = ownedStoreLink(owned, rec.name);
    await logEvent(sb, creatorId, "owned", {
      ...meta,
      rec_name: rec.name,
      brand: rec.brand,
      store_url: owned.store_url,
      resolved_url: url,
    });
    return { url, tier: "owned" };
  }

  // Tier 1: feed (or owned_feed) — exact ID match only.
  if (rec.product_id) {
    const matched = await findFeedById(sb, creatorId, rec.product_id);
    if (matched) {
      // network === "shopify_owned" means this is the creator's OWN line
      // (e.g. WeWoreWhat is Danielle's Shopify catalog). Direct URL, never
      // wrapped — full margin, her own store.
      const isOwnedFeed = matched.network === "shopify_owned";
      const tier: LinkTier = isOwnedFeed ? "owned_feed" : "feed";
      await logEvent(sb, creatorId, tier, {
        ...meta,
        rec_name: matched.name,
        product_id: matched.id,
        resolved_url: matched.affiliate_url,
        network: matched.network,
      });
      return {
        url: matched.affiliate_url,
        tier,
        matched_product_id: matched.id,
        feed_product: {
          name: matched.name,
          brand: matched.brand,
          price: matched.price != null ? `$${matched.price}` : null,
          image_url: matched.image_url,
        },
      };
    }
  }

  const category = (rec.category ?? "").toLowerCase();

  // Tier 3: travel/hotel
  if (category === "travel") {
    const url = generateHotelLink(rec.name, rec.location);
    const tier: LinkTier = url ? "hotel" : "none";
    await logEvent(sb, creatorId, tier, {
      ...meta,
      rec_name: rec.name,
      resolved_url: url,
    });
    return { url, tier };
  }

  // Tier 4: place (dining and place-like recs always get at least Directions).
  if (
    category === "dining" ||
    RESTAURANT_KEYWORDS.some((k) => category.includes(k))
  ) {
    // Authoritative place lookup via OSM. The model often mis-guesses the
    // neighborhood (e.g. claiming Wynwood for a Brickell spot); OSM
    // resolves the real address. Falls back to model's hint on miss.
    const osm = await lookupPlace(rec.name, rec.location);
    const effectiveLocation = osm?.location ?? rec.location;
    const directions = googleMapsSearchUrl(rec.name, effectiveLocation);
    const menu = menuSearchUrl(rec.name, effectiveLocation);
    const reservable = rec.reservable === true;
    const primary = reservable
      ? openTableSearchUrl(rec.name, effectiveLocation)
      : directions;
    await logEvent(sb, creatorId, "place", {
      ...meta,
      rec_name: rec.name,
      reservable,
      primary_action: reservable ? "reserve" : "directions",
      resolved_url: primary,
      model_location: rec.location ?? null,
      osm_location: osm?.location ?? null,
    });
    return {
      url: primary,
      tier: "place",
      place_links: { directions, menu, reservable },
      resolved_location: osm?.location,
    };
  }

  // Tier 2: aggregator — live Serper resolution, bare merchant URL.
  if (FEED_BACKED_CATEGORIES.has(category) || !category) {
    const live = await resolveProductLive(rec.brand, rec.name);
    // If Serper returned a real URL, use it bare. Otherwise fall back to
    // the brand-search pipeline. We no longer wrap off-catalog merchant
    // URLs through any affiliate aggregator (creators keep 100% via
    // their own feed-tier URLs; AskMai monetizes via subscriptions).
    let url: string;
    let wrapped = false;
    if (live.realUrl) {
      const wrap = wrapIfInNetwork(live.realUrl, creator.slug);
      url = wrap.url;
      wrapped = wrap.wrapped;
    } else {
      url = generateAggregatorLink({
        merchantUrl: rec.merchant_url,
        product: { name: rec.name, brand: rec.brand, category },
        creatorSlug: creator.slug,
      });
    }
    await logEvent(sb, creatorId, "aggregator", {
      ...meta,
      rec_name: rec.name,
      brand: rec.brand,
      live_source: live.source,
      brand_matched: live.brandMatched,
      wrapped,
      resolved_url: url,
    });
    return {
      url,
      tier: "aggregator",
      live_product: {
        realPrice: live.realPrice,
        realImage: live.realImage,
        brandMatched: live.brandMatched,
        wrapped,
        source: live.source,
      },
    };
  }

  await logEvent(sb, creatorId, "none", {
    ...meta,
    rec_name: rec.name,
    reason: "unknown_category",
  });
  return { url: null, tier: "none" };
}

async function findFeedById(
  sb: SupabaseClient,
  creatorId: string,
  productId: string
): Promise<{
  id: string;
  name: string;
  brand: string | null;
  price: number | null;
  affiliate_url: string;
  image_url: string | null;
  network: string | null;
} | null> {
  const trimmed = productId.trim();
  if (!trimmed) return null;
  // Try the legacy `products` table first (still used by some
  // owned/shopify-tier records), then fall back to `creator_products`
  // — the new chat catalog grounds itself in creator_products, so a
  // product_id emitted by the model can come from either table. The
  // schema differs (product_title vs name, source_network vs network)
  // so the fallback path maps fields. Whichever lookup hits first
  // wins; both return the same shape upward.
  const legacy = await sb
    .from("products")
    .select("id, name, brand, price, affiliate_url, image_url, network")
    .eq("creator_id", creatorId)
    .eq("id", trimmed)
    .limit(1);
  if (legacy.data && legacy.data.length > 0) {
    const row = legacy.data[0] as {
      id: string;
      name: string;
      brand: string | null;
      price: number | null;
      affiliate_url: string | null;
      image_url: string | null;
      network: string | null;
    };
    if (row.affiliate_url) return { ...row, affiliate_url: row.affiliate_url };
  }
  const cp = await sb
    .from("creator_products")
    .select(
      "id, product_title, brand, price, affiliate_url, image_url, source_network"
    )
    .eq("creator_id", creatorId)
    .eq("id", trimmed)
    .limit(1);
  if (!cp.data || cp.data.length === 0) return null;
  const row = cp.data[0] as {
    id: string;
    product_title: string;
    brand: string | null;
    price: number | null;
    affiliate_url: string | null;
    image_url: string | null;
    source_network: string | null;
  };
  if (!row.affiliate_url) return null;
  return {
    id: row.id,
    name: row.product_title,
    brand: row.brand,
    price: row.price,
    affiliate_url: row.affiliate_url,
    image_url: row.image_url,
    network: row.source_network,
  };
}

async function logEvent(
  sb: SupabaseClient,
  creatorId: string,
  tier: LinkTier,
  meta: Record<string, unknown>
) {
  try {
    await sb.from("events").insert({
      creator_id: creatorId,
      type: "recommendation",
      product_id: meta.product_id ?? null,
      meta: { tier, ...meta },
    });
  } catch {
    // never let logging kill a recommendation
  }
}
