/**
 * POST /api/admin/feature-product
 *
 * Tap-to-feature toggle for the Shop default-edit set. Sets
 * creator_products.featured = true|false for a single product id.
 *
 * Auth (Phase 1, per JD's spec):
 *   Bearer header equal to env.ADMIN_EDIT_KEY. This is a single
 *   shared secret JD controls, intentionally simpler than full
 *   creator auth. The same key activates edit-mode on the Shop
 *   page via ?edit=<key> (see src/app/janesmith/page.tsx).
 *
 *   The key gets carried in the request body's `editKey` field
 *   too, because the client renders edit-mode based on a cookie
 *   the server sets when the URL key is valid. We accept the key
 *   from either the Authorization header (curl flow) or the
 *   cookie (browser tap flow).
 *
 * Phase 2 (NOT built yet; spec only in code comments below) will
 * replace this with a creator-login + ownership check (the
 * creator's own user_id must match a creator_id she owns via a
 * creators.user_id FK that doesn't exist today).
 *
 * Body:
 *   { productId: string, featured: boolean }
 *
 * Returns:
 *   200 { ok: true, productId, featured, creator_id }
 *   400 invalid body
 *   401 unauthorized
 *   404 product not found
 *   500 db error
 */

import { cookies } from "next/headers";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

const EDIT_COOKIE_NAME = "askmai_edit";

type IncomingBody = {
  productId?: string;
  featured?: boolean;
};

function extractKey(request: Request, cookieKey: string | null): string | null {
  const auth = request.headers.get("authorization") || "";
  if (auth.startsWith("Bearer ")) {
    const v = auth.slice(7).trim();
    if (v) return v;
  }
  return cookieKey;
}

export async function POST(request: Request) {
  const expected = process.env.ADMIN_EDIT_KEY;
  if (!expected) {
    return Response.json(
      { error: "admin edit key not configured" },
      { status: 500 }
    );
  }
  const cookieStore = await cookies();
  const cookieKey = cookieStore.get(EDIT_COOKIE_NAME)?.value ?? null;
  const presented = extractKey(request, cookieKey);
  if (!presented || presented !== expected) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: IncomingBody;
  try {
    body = (await request.json()) as IncomingBody;
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }
  const productId =
    typeof body.productId === "string" && body.productId.length > 0
      ? body.productId
      : null;
  const featured = typeof body.featured === "boolean" ? body.featured : null;
  if (!productId || featured === null) {
    return Response.json(
      { error: "productId and featured are required" },
      { status: 400 }
    );
  }

  const sb = supabaseAdmin();
  const upd = await sb
    .from("creator_products")
    .update({ featured })
    .eq("id", productId)
    .select("id, creator_id, featured, product_title")
    .maybeSingle();
  if (upd.error) {
    return Response.json(
      { error: `update failed: ${upd.error.message}` },
      { status: 500 }
    );
  }
  if (!upd.data) {
    return Response.json({ error: "product not found" }, { status: 404 });
  }

  return Response.json({
    ok: true,
    productId: upd.data.id,
    featured: upd.data.featured,
    creator_id: upd.data.creator_id,
    product_title: upd.data.product_title,
  });
}
