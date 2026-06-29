/**
 * POST /api/admin/rename-creator-slug
 *
 * One-off admin route to flip the cosmetic display layer on a real
 * creator row: changes creators.slug from "cass" to "janesmith" and
 * creators.name from "Cass DiMicco" to "Jane Smith". Idempotent and
 * defensive: pre-checks that the destination slug doesn't already
 * exist before any UPDATE, so a re-run after a partial failure is
 * safe.
 *
 * Why server-side: the same pattern as recategorize-cass and
 * regenerate-canvas. JD has the SUPABASE_SERVICE_ROLE_KEY for his
 * project but won't paste it into any local file, so any DB write
 * the rename needs is exposed as a Bearer-authed POST that runs
 * inside the Vercel runtime where the secret already exists.
 *
 * Pre-checks (run in order, fail fast):
 *   1. Destination slug ("janesmith") must NOT already exist.
 *      A separate row colliding on slug would fail the UNIQUE
 *      constraint on UPDATE; better to surface the conflict
 *      explicitly with a 409.
 *   2. Source slug ("cass") must exist. A missing source means
 *      either we already ran the rename (idempotent path: report
 *      "already renamed") or there was never a Cass row, in which
 *      case there's nothing to do.
 *
 * Auth: header `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`,
 * same as the other admin routes.
 *
 * Returns:
 *   200 {ok: true, ...summary}      rename applied
 *   200 {ok: true, already_renamed} target already exists, nothing to do
 *   401 unauthorized
 *   409 slug_collision               destination slug already exists
 *                                    on a different row
 *   500 {error}                      DB error
 */

import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Hardcoded source / destination. The rename is a one-off; making
// this configurable via the request body would invite accidental
// double-renames or unintended targets.
const FROM_SLUG = "cass";
const TO_SLUG = "janesmith";
const NEW_NAME = "Jane Smith";

export async function POST(request: Request) {
  const expected = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!expected) {
    return Response.json(
      { error: "service role key not configured" },
      { status: 500 }
    );
  }
  const auth = request.headers.get("authorization") || "";
  const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!presented || presented !== expected) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = supabaseAdmin();

  // Pre-check 1: does destination slug already exist?
  const destLookup = await admin
    .from("creators")
    .select("id, slug, name")
    .eq("slug", TO_SLUG)
    .maybeSingle();
  if (destLookup.error) {
    return Response.json(
      { error: `dest pre-check failed: ${destLookup.error.message}` },
      { status: 500 }
    );
  }

  // Pre-check 2: does source slug exist?
  const srcLookup = await admin
    .from("creators")
    .select("id, slug, name")
    .eq("slug", FROM_SLUG)
    .maybeSingle();
  if (srcLookup.error) {
    return Response.json(
      { error: `src pre-check failed: ${srcLookup.error.message}` },
      { status: 500 }
    );
  }

  // Idempotent: destination exists and source doesn't -> rename
  // already applied on a prior run.
  if (destLookup.data && !srcLookup.data) {
    return Response.json({
      ok: true,
      already_renamed: true,
      destination_row: destLookup.data,
    });
  }

  // Collision: destination exists and source ALSO exists -> two
  // different rows. Refuse to overwrite.
  if (destLookup.data && srcLookup.data) {
    return Response.json(
      {
        error: "slug_collision",
        detail: `A different row already holds slug='${TO_SLUG}'. Cannot rename without manual intervention.`,
        source_row: srcLookup.data,
        destination_row: destLookup.data,
      },
      { status: 409 }
    );
  }

  // Source missing entirely.
  if (!srcLookup.data) {
    return Response.json(
      {
        error: "source_not_found",
        detail: `No creators row with slug='${FROM_SLUG}'.`,
      },
      { status: 500 }
    );
  }

  // Clean rename. Updates slug + name. Everything else (id, voice
  // prompt, taste profile, hidden state, theme, bio, creator_products
  // via creator_id FK) stays exactly as-is.
  const update = await admin
    .from("creators")
    .update({ slug: TO_SLUG, name: NEW_NAME })
    .eq("slug", FROM_SLUG)
    .select("id, slug, name, hidden")
    .maybeSingle();
  if (update.error) {
    return Response.json(
      { error: `update failed: ${update.error.message}` },
      { status: 500 }
    );
  }

  // Verify the updated row by re-reading.
  const verify = await admin
    .from("creators")
    .select("id, slug, name, hidden")
    .eq("slug", TO_SLUG)
    .maybeSingle();

  // Count attached products to confirm the FK held.
  const { count } = await admin
    .from("creator_products")
    .select("id", { count: "exact", head: true })
    .eq("creator_id", srcLookup.data.id);

  return Response.json({
    ok: true,
    renamed: {
      from: { slug: FROM_SLUG, name: srcLookup.data.name },
      to: { slug: TO_SLUG, name: NEW_NAME },
    },
    updated_row: update.data,
    verify_row: verify.data,
    products_still_attached: count ?? null,
  });
}
