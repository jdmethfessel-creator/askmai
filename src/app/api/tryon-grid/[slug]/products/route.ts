/**
 * GET /api/tryon-grid/[slug]/products
 *
 * Paginated, filterable product list for the new try-on grid surface.
 * Read-only; no auth required (the grid is browseable by anyone — the
 * gated action is the "Try This On" button, which hits POST /api/render
 * with its own session check).
 *
 * Query params:
 *   limit       (default 40, max 100) — page size
 *   cursor      ISO string from a previous response's nextCursor;
 *               results have created_at < cursor. Omit on first page.
 *   subcategory exact match against creator_products.product_subcategory
 *               (e.g. 'dresses', 'tops', 'shoes'). Special value 'all'
 *               or absent = no filter.
 *   q           free-text search across product_title + brand. Case-
 *               insensitive ILIKE.
 *
 * Returns:
 *   200 {
 *     products: Array<{
 *       id, source_network, product_title, brand, price, price_display,
 *       image_url, affiliate_url, product_category, product_subcategory,
 *     }>,
 *     nextCursor: string | null,   // pass back as ?cursor= for next page
 *   }
 *   404 { error: 'creator_not_found' }
 */

import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const url = new URL(request.url);
  const rawLimit = Number(url.searchParams.get("limit") || DEFAULT_LIMIT);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : DEFAULT_LIMIT)
  );
  const cursor = url.searchParams.get("cursor");
  const subcategory = url.searchParams.get("subcategory");
  const q = (url.searchParams.get("q") || "").trim();

  const admin = supabaseAdmin();

  const { data: creator } = await admin
    .from("creators")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (!creator) {
    return Response.json({ error: "creator_not_found" }, { status: 404 });
  }

  // Pull (limit + 1) rows so we can decide whether a next page exists
  // without a separate count query.
  let query = admin
    .from("creator_products")
    .select(
      "id, source_network, product_title, brand, price, price_display, image_url, affiliate_url, product_category, product_subcategory, created_at"
    )
    .eq("creator_id", creator.id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (cursor) {
    query = query.lt("created_at", cursor);
  }
  if (subcategory && subcategory !== "all") {
    query = query.eq("product_subcategory", subcategory);
  }
  if (q) {
    // Sanitize for the OR filter syntax — strip the few characters the
    // PostgREST parser uses as separators so a search like "foo,bar"
    // doesn't break the filter shape.
    const safe = q.replace(/[,()*]/g, " ").slice(0, 120);
    query = query.or(`product_title.ilike.%${safe}%,brand.ilike.%${safe}%`);
  }

  const { data, error } = await query;
  if (error) {
    console.error("[tryon-grid/products]", error);
    return Response.json({ error: "query_failed" }, { status: 500 });
  }

  const rows = data ?? [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? page[page.length - 1].created_at : null;

  // Strip created_at from the public payload — it's only the cursor
  // shape, not user-relevant data.
  const products = page.map(({ created_at: _c, ...rest }) => rest);

  return Response.json({ products, nextCursor });
}
