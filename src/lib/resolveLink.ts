import { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "./supabase";
import {
  generateAggregatorLink,
  generateHotelLink,
} from "./affiliateLinks";
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
};

const FEED_BACKED_CATEGORIES = new Set([
  "fashion",
  "beauty",
  "accessories",
  "lifestyle",
]);

const RESTAURANT_KEYWORDS = ["restaurant", "dining", "bar", "cafe"];

/**
 * Resolves a recommendation to one of four tiers:
 *
 *   feed       — rec.product_id exists in this creator's products table
 *   aggregator — fashion/beauty/accessories with no catalog match
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
  creatorId: string,
  meta: Record<string, unknown> = {}
): Promise<ResolvedLink> {
  const sb = supabaseAdmin();

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

  // Tier 4: dining / no-link
  if (
    category === "dining" ||
    RESTAURANT_KEYWORDS.some((k) => category.includes(k))
  ) {
    await logEvent(sb, creatorId, "none", {
      ...meta,
      rec_name: rec.name,
      reason: "dining",
    });
    return { url: null, tier: "none" };
  }

  // Tier 2: aggregator fallback
  if (FEED_BACKED_CATEGORIES.has(category) || !category) {
    const url = generateAggregatorLink({
      name: rec.name,
      brand: rec.brand,
      category,
    });
    await logEvent(sb, creatorId, "aggregator", {
      ...meta,
      rec_name: rec.name,
      resolved_url: url,
    });
    return { url, tier: "aggregator" };
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
