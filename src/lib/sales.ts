/**
 * Sale-alerts helpers. Every function here degrades gracefully when
 * the sale-alerts tables haven't been migrated yet: catch missing-
 * table / missing-column errors and return empty results so a fresh
 * environment doesn't throw.
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "./supabase";

export type SaleDropRule = {
  minDropFraction: number;
  minDropUsd: number;
  windowDays: number;
};

export const SALE_RULE: SaleDropRule = {
  minDropFraction: 0.15,
  minDropUsd: 10,
  windowDays: 30,
};

/**
 * Insert a price snapshot for a product. Throttled at the call site:
 * we look up the most recent snapshot and skip if it's within 12h.
 * Silent on missing-table errors so this is a safe no-op in a fresh
 * environment.
 */
export async function snapshotPrice(
  sb: SupabaseClient,
  productId: string,
  price: number
): Promise<void> {
  try {
    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const { data } = await sb
      .from("price_snapshots")
      .select("id, captured_at")
      .eq("product_id", productId)
      .gte("captured_at", twelveHoursAgo)
      .limit(1);
    if (Array.isArray(data) && data.length > 0) return;
    await sb.from("price_snapshots").insert({ product_id: productId, price });
  } catch {
    /* silent when table absent or RLS blocks */
  }
}

export function isSaleDrop(
  currentPrice: number | null | undefined,
  historicalMax: number | null | undefined
): boolean {
  if (currentPrice == null || historicalMax == null) return false;
  if (historicalMax <= 0) return false;
  const drop = historicalMax - currentPrice;
  if (drop < SALE_RULE.minDropUsd) return false;
  const fraction = drop / historicalMax;
  return fraction >= SALE_RULE.minDropFraction;
}

/**
 * Ensure a watch row exists for (product, viewer). Viewer is either a
 * signed-in userId or a raw email. Idempotent on the unique index.
 * Returns the watch row or null on missing-table.
 */
export async function ensureWatch(
  productId: string,
  viewer: { userId?: string | null; email?: string | null }
): Promise<{ id: string; token: string } | null> {
  const sb = supabaseAdmin();
  try {
    const existing = await sb
      .from("product_watches")
      .select("id, token")
      .eq("product_id", productId)
      .or(
        viewer.userId
          ? `user_id.eq.${viewer.userId}`
          : `email.eq.${(viewer.email ?? "").toLowerCase()}`
      )
      .maybeSingle();
    if (existing.data) return existing.data as { id: string; token: string };
    const insert = await sb
      .from("product_watches")
      .insert({
        product_id: productId,
        user_id: viewer.userId ?? null,
        email: viewer.userId ? null : (viewer.email ?? "").toLowerCase() || null,
      })
      .select("id, token")
      .maybeSingle();
    if (insert.error || !insert.data) return null;
    return insert.data as { id: string; token: string };
  } catch {
    return null;
  }
}

export async function removeWatchByToken(token: string): Promise<boolean> {
  const sb = supabaseAdmin();
  try {
    const { error } = await sb.from("product_watches").delete().eq("token", token);
    return !error;
  } catch {
    return false;
  }
}

/**
 * Return the max price seen in the last N days for a product.
 * Null when there's no history (or the table isn't there).
 */
export async function maxRecentPrice(
  sb: SupabaseClient,
  productId: string,
  windowDays: number = SALE_RULE.windowDays
): Promise<number | null> {
  try {
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await sb
      .from("price_snapshots")
      .select("price")
      .eq("product_id", productId)
      .gte("captured_at", since)
      .order("price", { ascending: false })
      .limit(1);
    if (!Array.isArray(data) || data.length === 0) return null;
    return Number(data[0].price);
  } catch {
    return null;
  }
}
