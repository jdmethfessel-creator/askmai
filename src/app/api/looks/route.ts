/**
 * POST /api/looks
 *
 * Creates a Look pull-sheet from a set of items. Returns the shareable
 * slug so the client can route to /look/[slug] and copy the URL.
 *
 * Body:
 *   {
 *     creatorSlug: string,
 *     title?: string,
 *     items: [
 *       { id?, name, brand?, price?, price_display?, source_network?, image_url, affiliate_url }
 *     ]
 *   }
 *
 * Response:
 *   200 { ok: true, slug }
 *   400 { error: "invalid_request" | "no_items" }
 *   500 { error: "store_failed" }
 */

import { createLook, type LookItem } from "@/lib/looks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  creatorSlug?: string;
  title?: string;
  items?: unknown[];
};

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const creatorSlug =
    typeof body.creatorSlug === "string"
      ? body.creatorSlug.trim().toLowerCase().slice(0, 64)
      : "";
  if (!creatorSlug) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const raw = Array.isArray(body.items) ? body.items : [];
  const items: LookItem[] = [];
  for (const it of raw) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    if (typeof o.name !== "string" || typeof o.image_url !== "string" || typeof o.affiliate_url !== "string") {
      continue;
    }
    items.push({
      id: typeof o.id === "string" ? o.id : undefined,
      name: o.name,
      brand: typeof o.brand === "string" ? o.brand : null,
      price: typeof o.price === "number" ? o.price : null,
      price_display:
        typeof o.price_display === "string" ? o.price_display : null,
      source_network:
        typeof o.source_network === "string" ? o.source_network : null,
      image_url: o.image_url,
      affiliate_url: o.affiliate_url,
    });
    if (items.length >= 12) break;
  }
  if (items.length === 0) {
    return Response.json({ error: "no_items" }, { status: 400 });
  }

  const title = typeof body.title === "string" ? body.title.trim().slice(0, 120) : null;

  const created = await createLook({ creatorSlug, title, items });
  if (!created) {
    return Response.json({ error: "store_failed" }, { status: 500 });
  }
  return Response.json({ ok: true, slug: created.slug });
}
