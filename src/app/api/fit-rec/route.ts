/**
 * GET /api/fit-rec?product_ids=id1,id2,...
 *
 * Returns per-product fit recommendations for the current caller.
 * The engine is a pure function (src/lib/fitRec.ts); this route
 * loads the caller's fit profile once and the products' fit facts
 * in a single batched query, then maps each to a rec.
 *
 * Callers:
 *   - DressingRoom result modal (a): fetches for the items that
 *     were just rendered so the "Your size in this: M" line has
 *     material.
 *   - TryOnGrid product cards (b): fetches for the item a follower
 *     opens the try-on modal for.
 *   - Mai chat (c): fetches for a specific product id in scope
 *     when a follower asks "what size should I get".
 *
 * Response:
 *   200 { ok: true, recs: { [product_id]: FitRec } }
 *   400 { error: "invalid_request" }
 */

import { getServerSession } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";
import { loadUserFitProfile } from "@/lib/fit";
import { recommendFit, type ProductFitFacts } from "@/lib/fitRec";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_IDS = 32;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const raw = url.searchParams.get("product_ids") ?? "";
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[0-9a-fA-F-]{8,}$/.test(s))
    .slice(0, MAX_IDS);
  if (ids.length === 0) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  // Session is optional. Unauthenticated callers still get tier-2
  // rationale ("Model is X wearing Y") because the model reference
  // is public retailer info; only the personalized rec requires a
  // profile.
  const session = await getServerSession();
  const profile = session ? await loadUserFitProfile(session.userId) : null;

  const admin = supabaseAdmin();
  const productRows = await admin
    .from("creator_products")
    .select("id, product_subcategory")
    .in("id", ids);
  const products =
    (productRows.data as
      | Array<{ id: string; product_subcategory: string | null }>
      | null) ?? [];

  const fitRows = await admin
    .from("product_fit")
    .select(
      "product_id, model_height_cm, model_size, model_size_scale, fit_note, fit_run, fit_consensus"
    )
    .in("product_id", ids);
  const fitById = new Map<string, ProductFitFacts>();
  for (const row of (fitRows.data as
    | Array<{
        product_id: string;
        model_height_cm: number | null;
        model_size: string | null;
        model_size_scale: string | null;
        fit_note: string | null;
        fit_run: string | null;
        fit_consensus: unknown;
      }>
    | null) ?? []) {
    fitById.set(row.product_id, {
      subcategory: null, // filled from products row below
      model_height_cm: row.model_height_cm,
      model_size: row.model_size,
      model_size_scale: row.model_size_scale,
      fit_note: row.fit_note,
      fit_run:
        row.fit_run === "small" ||
        row.fit_run === "true" ||
        row.fit_run === "large"
          ? row.fit_run
          : null,
      fit_consensus: (row.fit_consensus as ProductFitFacts["fit_consensus"]) ?? null,
    });
  }

  const recs: Record<string, unknown> = {};
  for (const p of products) {
    const facts: ProductFitFacts = fitById.get(p.id) ?? {
      subcategory: p.product_subcategory,
      model_height_cm: null,
      model_size: null,
      model_size_scale: null,
      fit_note: null,
      fit_run: null,
      fit_consensus: null,
    };
    // Overlay subcategory from the product row so the engine can
    // gate non-sizeable categories.
    facts.subcategory = p.product_subcategory;
    recs[p.id] = recommendFit(profile, facts);
  }

  return Response.json({ ok: true, recs });
}
