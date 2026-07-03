/**
 * GET /api/search/[slug]?q=blue jeans under 150
 *
 * Runs the deterministic parseQuery + hard-filtered searchProducts
 * over the given creator's catalog. Returns the parsed filters, the
 * matching rows, and, when strict filters returned fewer than 3
 * results, the "nearest" fallback rows explicitly flagged.
 *
 * Response:
 *   200 {
 *     ok: true,
 *     parsed: { category, colors, priceMax, freeText },
 *     exact: [SearchResult],
 *     nearest: [SearchResult],
 *     is_relaxed: boolean
 *   }
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
  const rows = await searchProducts({
    creatorSlug: slug,
    category: parsed.category,
    colors: parsed.colors,
    priceMax: parsed.priceMax,
    freeText: parsed.freeText,
  });
  const exact = rows.filter((r) => !r.nearest);
  const nearest = rows.filter((r) => r.nearest);
  return Response.json({
    ok: true,
    parsed: {
      category: parsed.category,
      colors: parsed.colors,
      priceMax: parsed.priceMax,
      freeText: parsed.freeText,
    },
    exact,
    nearest,
    is_relaxed: nearest.length > 0 && exact.length < 3,
  });
}
