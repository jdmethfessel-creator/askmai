/**
 * For Less retrieval. Given a creator_products id, returns up to N
 * alternatives from the SAME creator's own catalog at <= 65% of the
 * viewed piece's price. All affiliate URLs come back byte-for-byte
 * from creator_products so the creator's attribution stays intact.
 *
 * Ranking:
 *   1. Same subcategory match wins
 *   2. Same brand match ties
 *   3. Ascending price as tiebreak
 *
 * The retrieval never leaves the creator's own creator_products.
 * External catalogs and off-creator inventory are structurally
 * excluded (no cross-creator SELECT).
 */

import { supabaseAdmin } from "./supabase";
import { FOR_LESS } from "./forLessConfig";

export type ForLessAnchor = {
  id: string;
  creator_id: string;
  price: number | null;
  product_subcategory: string | null;
  brand: string | null;
};

export type ForLessRow = {
  id: string;
  source_network: string;
  product_title: string;
  brand: string | null;
  price: number | null;
  price_display: string | null;
  image_url: string;
  affiliate_url: string;
  product_subcategory: string | null;
};

export async function loadAnchor(productId: string): Promise<ForLessAnchor | null> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("creator_products")
    .select("id, creator_id, price, product_subcategory, brand")
    .eq("id", productId)
    .maybeSingle();
  if (error || !data) return null;
  return data as ForLessAnchor;
}

export async function getForLess(
  productId: string,
  limit: number = FOR_LESS.maxCandidates
): Promise<ForLessRow[]> {
  const anchor = await loadAnchor(productId);
  if (!anchor || anchor.price == null || anchor.price <= 0) return [];

  const ceiling = anchor.price * FOR_LESS.maxCandidateFraction;

  const sb = supabaseAdmin();
  let query = sb
    .from("creator_products")
    .select(
      "id, source_network, product_title, brand, price, price_display, image_url, affiliate_url, product_subcategory"
    )
    .eq("creator_id", anchor.creator_id)
    .neq("id", anchor.id)
    .not("price", "is", null)
    .lte("price", ceiling)
    .gt("price", 0)
    .order("price", { ascending: true })
    .limit(40);

  if (anchor.product_subcategory) {
    // Prefer same subcategory, but fall back to whole-catalog scan if
    // the subcategory has nothing in range. Two-pass: first same-cat,
    // then anything else.
    query = query.eq("product_subcategory", anchor.product_subcategory);
  }

  const { data, error } = await query;
  if (error) return [];
  let candidates = (data as ForLessRow[] | null) ?? [];

  // Fallback: scan whole catalog if same-subcategory came up empty.
  if (candidates.length === 0 && anchor.product_subcategory) {
    const fallback = await sb
      .from("creator_products")
      .select(
        "id, source_network, product_title, brand, price, price_display, image_url, affiliate_url, product_subcategory"
      )
      .eq("creator_id", anchor.creator_id)
      .neq("id", anchor.id)
      .not("price", "is", null)
      .lte("price", ceiling)
      .gt("price", 0)
      .order("price", { ascending: true })
      .limit(20);
    candidates = (fallback.data as ForLessRow[] | null) ?? [];
  }

  candidates.sort((a, b) => {
    const aBrand = anchor.brand && a.brand === anchor.brand ? 1 : 0;
    const bBrand = anchor.brand && b.brand === anchor.brand ? 1 : 0;
    if (aBrand !== bBrand) return bBrand - aBrand;
    return (a.price ?? 0) - (b.price ?? 0);
  });

  return candidates.slice(0, limit);
}

/**
 * Does this product qualify for a For Less surface at all? Anchor
 * price threshold OR top-quartile-of-category are the two triggers.
 * The category quartile is computed lazily; if we can't compute it
 * we fall back to the floor per config.
 */
export async function isForLessAnchor(
  anchor: ForLessAnchor
): Promise<boolean> {
  if (anchor.price == null) return false;
  if (anchor.price >= FOR_LESS.minAnchorPriceUsd) return true;

  const sb = supabaseAdmin();
  const { data } = await sb
    .from("creator_products")
    .select("price")
    .eq("creator_id", anchor.creator_id)
    .eq("product_subcategory", anchor.product_subcategory ?? "__none__")
    .not("price", "is", null)
    .gt("price", 0);
  const prices = ((data as { price: number }[] | null) ?? [])
    .map((r) => Number(r.price))
    .sort((a, b) => a - b);
  if (prices.length < 8) {
    return FOR_LESS.fallbackToFloorOnly ? false : anchor.price >= 100;
  }
  const q3Index = Math.floor(prices.length * 0.75);
  const q3 = prices[q3Index];
  return anchor.price >= q3;
}

const CHEAPER_INTENT = /\b(cheaper|for less|dupe|budget|under\s+\$?\d+|can(?:'?t| ?not) afford|less expensive|more affordable|too expensive|price(?:y| tag))\b/i;

export function hasCheaperIntent(text: string): boolean {
  return CHEAPER_INTENT.test(text);
}

/**
 * Best-effort analytics stub. Prefers inserting into the existing
 * `events` table (used by resolveLink); if that fails (table missing,
 * RLS, whatever) we drop the event silently so a logging failure
 * never breaks the surface.
 */
export async function logForLessEvent(
  event: "forless_viewed" | "cheaper_intent_asked",
  args: { creatorId: string; productId: string; price: number | null }
): Promise<void> {
  try {
    const sb = supabaseAdmin();
    await sb.from("events").insert({
      creator_id: args.creatorId,
      type: event,
      product_id: args.productId,
      meta: { price: args.price ?? null },
    });
  } catch {
    /* silent */
  }
}
