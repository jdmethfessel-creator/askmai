/**
 * GET /api/tryon-grid/[slug]/categories
 *
 * Returns the set of product_subcategory buckets that actually have
 * products for this creator, with counts. The grid renders one pill
 * per returned bucket; an empty bucket disappears automatically (the
 * rule is "show a category only if it has products"). An implicit
 * "All" pill is rendered by the client with the sum.
 *
 * Read-only, no auth.
 *
 * Returns:
 *   200 {
 *     categories: Array<{ key: string, label: string, count: number }>,
 *     total: number,
 *   }
 *   404 { error: 'creator_not_found' }
 */

import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Display order — the bar reads left-to-right in this order, then any
// unrecognized bucket at the end. Keep in sync with SUBCATEGORY_LABELS
// in scripts/ingest-creator-products/categorize.mjs.
const ORDER = [
  "dresses",
  "tops",
  "bottoms",
  "outerwear",
  "shoes",
  "bags",
  "jewelry",
  "accessories",
  "swim",
  "beauty",
  "home",
  "other",
];

const LABELS: Record<string, string> = {
  dresses: "Dresses",
  tops: "Tops",
  bottoms: "Bottoms",
  outerwear: "Outerwear",
  shoes: "Shoes",
  bags: "Bags",
  jewelry: "Jewelry",
  accessories: "Accessories",
  swim: "Swim",
  beauty: "Beauty",
  home: "Home",
  other: "Other",
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const admin = supabaseAdmin();

  const { data: creator } = await admin
    .from("creators")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (!creator) {
    return Response.json({ error: "creator_not_found" }, { status: 404 });
  }

  // PostgREST doesn't expose GROUP BY directly; pull the column and
  // count in memory. Lift the default 1000-row response cap so a
  // creator with 1k+ products is counted accurately (Cass landed at
  // 1043; the default would silently undercount by 43).
  const { data, error } = await admin
    .from("creator_products")
    .select("product_subcategory")
    .eq("creator_id", creator.id)
    .range(0, 9999);
  if (error) {
    console.error("[tryon-grid/categories]", error);
    return Response.json({ error: "query_failed" }, { status: 500 });
  }

  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const k = (row.product_subcategory as string | null) || "other";
    counts.set(k, (counts.get(k) || 0) + 1);
  }

  const seen = new Set<string>();
  const categories: Array<{ key: string; label: string; count: number }> = [];

  for (const key of ORDER) {
    const n = counts.get(key);
    if (n && n > 0) {
      seen.add(key);
      categories.push({ key, label: LABELS[key] || titleize(key), count: n });
    }
  }
  for (const [key, n] of counts.entries()) {
    if (seen.has(key)) continue;
    categories.push({ key, label: LABELS[key] || titleize(key), count: n });
  }

  const total = (data ?? []).length;
  return Response.json({ categories, total });
}

function titleize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
