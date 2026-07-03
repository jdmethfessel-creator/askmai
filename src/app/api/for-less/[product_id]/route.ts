/**
 * GET /api/for-less/[product_id]
 *
 * Returns up to N same-creator alternatives at <= 65% of the anchor
 * price. Only reads creator_products; every affiliate URL comes back
 * byte-for-byte from the row.
 *
 * Response:
 *   200 { ok: true, qualifies: boolean, anchor_price, candidates: [...] }
 *   404 { error: "not_found" }
 */

import { getForLess, isForLessAnchor, loadAnchor, logForLessEvent } from "@/lib/forLess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { product_id: string };

export async function GET(_request: Request, ctx: { params: Promise<Params> }) {
  const { product_id } = await ctx.params;
  const anchor = await loadAnchor(product_id);
  if (!anchor) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const [qualifies, candidates] = await Promise.all([
    isForLessAnchor(anchor),
    getForLess(product_id),
  ]);
  if (qualifies && candidates.length > 0) {
    await logForLessEvent("forless_viewed", {
      creatorId: anchor.creator_id,
      productId: anchor.id,
      price: anchor.price,
    });
  }
  return Response.json({
    ok: true,
    qualifies,
    anchor_price: anchor.price,
    candidates,
  });
}
