/**
 * POST /api/watch  { productId, email? }
 * DELETE /api/watch { productId }
 *
 * Create or remove a product-price watch. Signed-in users skip the
 * email field; anonymous callers supply one. Idempotent on the
 * unique index. No-ops on missing table.
 *
 * Response:
 *   200 { ok: true, watching: boolean }
 *   400 { error: "invalid_request" | "missing_email" }
 *   404 { error: "product_not_found" }
 */

import { getServerSession } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";
import { ensureWatch } from "@/lib/sales";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { productId?: string; email?: string };

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const productId = typeof body.productId === "string" ? body.productId.trim() : "";
  if (!productId) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const session = await getServerSession();
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!session && !email) {
    return Response.json({ error: "missing_email" }, { status: 400 });
  }
  const sb = supabaseAdmin();
  const check = await sb
    .from("creator_products")
    .select("id")
    .eq("id", productId)
    .maybeSingle();
  if (!check.data) {
    return Response.json({ error: "product_not_found" }, { status: 404 });
  }
  const watch = await ensureWatch(productId, {
    userId: session?.userId ?? null,
    email: session ? null : email,
  });
  if (!watch) {
    return Response.json({ error: "store_failed" }, { status: 500 });
  }
  return Response.json({ ok: true, watching: true });
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId") ?? "";
  if (!productId) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const session = await getServerSession();
  if (!session) {
    return Response.json({ error: "not_signed_in" }, { status: 401 });
  }
  const sb = supabaseAdmin();
  try {
    await sb
      .from("product_watches")
      .delete()
      .eq("product_id", productId)
      .eq("user_id", session.userId);
    return Response.json({ ok: true, watching: false });
  } catch {
    return Response.json({ ok: true, watching: false });
  }
}
