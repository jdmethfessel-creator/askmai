/**
 * Lazy per-card product image lookup.
 *
 * Off-catalog product recs (Zara, & Other Stories, CeraVe, etc.) get
 * suggested live by the model and have no stored image_url. This endpoint
 * does a Bing image search per query, returns the first thumbnail URL on
 * the allowlisted Bing CDN. The frontend then renders that URL through
 * the /api/img proxy so the actual byte fetch is also referer-stripped
 * and cached.
 *
 * The actual Bing parser + cache lives in src/lib/bingImage so the chat
 * route can prefetch the same way for visual-board eligibility.
 *
 * Output: { imageUrl: string | null }.
 */

import { bingLookup } from "@/lib/bingImage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const u = new URL(request.url);
  const brand = u.searchParams.get("brand")?.trim() ?? "";
  const product = u.searchParams.get("product")?.trim() ?? "";
  const qParam = u.searchParams.get("q")?.trim() ?? "";
  const type = u.searchParams.get("type")?.trim().toLowerCase() ?? "";

  let query = qParam || [brand, product].filter(Boolean).join(" ").trim();
  if (!query) {
    return Response.json({ error: "missing query" }, { status: 400 });
  }
  if (type === "place" && !/restaurant|cafe|coffee|bar/i.test(query)) {
    // Bias the search toward the establishment / its food rather than a
    // logo or unrelated person of the same name.
    query = `${query} restaurant`;
  }

  const imageUrl = await bingLookup(query);
  return Response.json(
    { imageUrl },
    {
      headers: {
        "Cache-Control": "public, max-age=86400, s-maxage=86400",
      },
    }
  );
}
