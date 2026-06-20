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
    wrapped: boolean; // true when Skimlinks-wrapped (host in network)
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

function ownedStoreLink(brand: OwnedBrand, productName: string): string {
  // Shopify storefronts universally support /search?q= for product-name lookup.
  // If we don't have a usable product name, link straight to the homepage.
  const trimmed = (productName ?? "").trim();
  if (!trimmed) return brand.store_url;
  const base = brand.store_url.replace(/\/+$/, "");
  return `${base}/search?q=${encodeURIComponent(trimmed)}`;
}

/**
 * Resolves a recommendation to one of four tiers:
 *
 *   feed       — rec.product_id exists in this creator's products table
 *   aggregator — fashion/beauty/accessories with no catalog match (Skimlinks)
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

  // Tier 1: feed — exact ID match only.
  if (rec.product_id) {
    const matched = await findFeedById(sb, creatorId, rec.product_id);
    if (matched) {
      await logEvent(sb, creatorId, "feed", {
        ...meta,
        rec_name: matched.name,
        product_id: matched.id,
        resolved_url: matched.affiliate_url,
        network: matched.network,
      });
      return {
        url: matched.affiliate_url,
        tier: "feed",
        matched_product_id: matched.id,
        feed_product: {
          name: matched.name,
          brand: matched.brand,
          price: matched.price != null ? `$${matched.price}` : null,
          image_url: matched.image_url,
        },
      };
    }
    // product_id provided but didn't resolve — fall through to non-feed tiers.
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
    const directions = googleMapsSearchUrl(rec.name, rec.location);
    const menu = menuSearchUrl(rec.name, rec.location);
    const reservable = rec.reservable === true;
    const primary = reservable
      ? openTableSearchUrl(rec.name, rec.location)
      : directions;
    await logEvent(sb, creatorId, "place", {
      ...meta,
      rec_name: rec.name,
      reservable,
      primary_action: reservable ? "reserve" : "directions",
      resolved_url: primary,
    });
    return {
      url: primary,
      tier: "place",
      place_links: { directions, menu, reservable },
    };
  }

  // Tier 2: aggregator — live Serper resolution + Skimlinks wrap if in network.
  if (FEED_BACKED_CATEGORIES.has(category) || !category) {
    const live = await resolveProductLive(rec.brand, rec.name);
    // If Serper returned a real URL, use it (wrap conditionally). Otherwise
    // fall back to the existing brand-search → Skimlinks pipeline.
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
  const { data } = await sb
    .from("products")
    .select("id, name, brand, price, affiliate_url, image_url, network")
    .eq("creator_id", creatorId)
    .eq("id", trimmed)
    .limit(1);
  if (!data || data.length === 0) return null;
  const row = data[0] as {
    id: string;
    name: string;
    brand: string | null;
    price: number | null;
    affiliate_url: string | null;
    image_url: string | null;
    network: string | null;
  };
  if (!row.affiliate_url) return null;
  return { ...row, affiliate_url: row.affiliate_url };
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
