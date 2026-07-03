/**
 * GET /api/search/[slug]?q=blue jeans under 150
 *
 * Runs parseQuery + hard-filtered searchProducts on the creator's
 * catalog. Returns the parsed intent, the filters actually applied
 * to the returned rows (which may differ from parsed when the
 * relaxed pass dropped color), exact hits, and nearest fallback.
 *
 * When attributes column isn't present in the catalog and the query
 * carries structured intent, the response returns exact = [] and
 * nearest = [] with attributes_available: false so the client can
 * render the honest "no true X in this closet" copy.
 */

import { parseQuery, searchProducts } from "@/lib/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { slug: string };

export async function GET(request: Request, ctx: { params: Promise<Params> }) {
  const { slug } = await ctx.params;
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const parsed = parseQuery(q);
  const res = await searchProducts({
    creatorSlug: slug,
    category: parsed.category,
    colors: parsed.colors,
    priceMax: parsed.priceMax,
    freeText: parsed.freeText,
  });
  return Response.json({
    ok: true,
    query: q.trim(),
    parsed: {
      category: parsed.category,
      colors: parsed.colors,
      priceMax: parsed.priceMax,
      freeText: parsed.freeText,
    },
    applied: res.applied,
    exact: res.exact,
    nearest: res.nearest,
    is_relaxed: res.is_relaxed,
    attributes_available: res.attributes_available,
  });
}
