/**
 * POST /api/render
 *
 * Try-on render endpoint. Click-gated: this is the ONLY place that
 * fires the VTON provider (FASHN tryon-v1.6, falling back to
 * Replicate IDM-VTON). The chat route does not render automatically;
 * the per-card "Show This Item" and per-response "Try This Outfit"
 * buttons hit here on explicit click.
 *
 * Gate order (mirrors the photo-upload route's strict ordering so a
 * failed gate never spends any provider credit):
 *
 *   1. session                  -> 401 not_signed_in
 *   2. body parse + shape       -> 400 invalid_request / no_items
 *   3. age_verified_at present  -> 403 age_not_verified
 *   4. tryon_photo_path present -> 412 no_photo
 *   5. render quota available   -> 402 no_quota
 *
 * If any gate fails the client surfaces the matched prompt (sign in,
 * upload a photo, buy a pack). Only after step 5 do we touch the
 * VTON provider.
 *
 * On a successful render:
 *   - composite the askmai branding overlay
 *   - upload to the private renders bucket
 *   - atomically consume one credit (consume_render RPC)
 *   - append-only log into public.renders
 *   - return a short-lived signed URL the user can view/share
 *
 * If consume_render returns charged=false after the upstream succeeded
 * (rare race against another concurrent render the same user fired),
 * we still return the image since the provider credit is already
 * spent, and log a 'leak' line for spend reconciliation.
 *
 * Request body:
 *   {
 *     kind: "single" | "outfit",
 *     creatorSlug: string,
 *     items: Array<{ image_url: string, name?: string, brand?: string }>
 *   }
 *
 * Response:
 *   200 { ok: true, signed_url, kind, source, included_remaining, pack_balance }
 *   400 { error: "invalid_request" | "no_items" | "too_many_items" }
 *   401 { error: "not_signed_in" }
 *   402 { error: "no_quota", included_remaining, pack_balance }
 *   403 { error: "age_not_verified" }
 *   412 { error: "no_photo" }
 *   422 { error: "moderation_blocked" | "pose_error" | "image_load_error" }
 *   500 { error: "render_failed" | "upload_failed" }
 */

import { getServerSession } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";
import {
  consumeRender,
  fetchPersonPhoto,
  getRenderQuota,
  logRender,
  runRender,
  uploadRender,
} from "@/lib/render";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// VTON timing: FASHN tryon-v1.6 quality mode is ~12-17s per garment;
// outfit chains run that latency per item. An 8-item outfit can land
// near the 300s ceiling. Single-item renders (the common path) land
// in 15-25s end-to-end including overlay + upload.
export const maxDuration = 300;

// Matches the full outfit-slot taxonomy in src/lib/outfitSlots.ts:
//   dress | top | bottom | outerwear | shoes | bag |
//   jewelry | sunglasses | accessory
// dress excludes top+bottom, so the realistic max is 8 items
// (top + bottom + 6 other slots) or (dress + 7 other slots).
// We never REJECT when items exceed this; we trim and log, so a
// model-side over-emit can't surface as a user-facing render
// failure.
const MAX_ITEMS_PER_RENDER = 8;

type IncomingItem = {
  image_url?: string;
  name?: string;
  brand?: string;
};

type IncomingBody = {
  kind?: string;
  creatorSlug?: string;
  items?: IncomingItem[];
};

export async function POST(request: Request) {
  const session = await getServerSession();
  if (!session) {
    return Response.json({ error: "not_signed_in" }, { status: 401 });
  }

  let body: IncomingBody;
  try {
    body = (await request.json()) as IncomingBody;
  } catch {
    console.warn("[render] 400 invalid_request: body failed JSON parse");
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const kind = body.kind === "outfit" ? "outfit" : "single";
  const items = Array.isArray(body.items) ? body.items : [];
  // Telemetry for the 400 path: when items arrive but none pass the
  // server's URL validation, log each item's URL shape so the client-
  // side bug is easy to identify (relative URL? proxied URL? missing?).
  const imageUrls: string[] = [];
  const rejectedShapes: string[] = [];
  for (const item of items) {
    const url = typeof item?.image_url === "string" ? item.image_url.trim() : "";
    if (!url) {
      rejectedShapes.push("(empty/missing)");
      continue;
    }
    if (!/^https?:\/\//i.test(url)) {
      // Log enough of the URL to diagnose the bug without leaking
      // arbitrarily long strings; first 40 chars is plenty for
      // distinguishing "/api/img?..." from "data:..." from any
      // mis-shaped value.
      rejectedShapes.push(`(non-http: "${url.slice(0, 40)}")`);
      continue;
    }
    imageUrls.push(url);
  }
  if (imageUrls.length === 0) {
    console.warn(
      `[render] 400 no_items: kind=${kind} items_in=${items.length} rejected=[${rejectedShapes.join(", ")}]`
    );
    return Response.json({ error: "no_items" }, { status: 400 });
  }
  if (kind === "single" && imageUrls.length > 1) {
    imageUrls.splice(1);
  }
  // Trim, never reject: a cap-exceeded outfit should still render,
  // just with the first N (highest-ranked) items. The client's
  // dedupeOutfitRecs has already ensured one-per-slot, so slicing
  // off the tail just drops the least-important slot fills.
  if (imageUrls.length > MAX_ITEMS_PER_RENDER) {
    console.log(
      `[render] trim: kind=${kind} count=${imageUrls.length} -> ${MAX_ITEMS_PER_RENDER}`
    );
    imageUrls.splice(MAX_ITEMS_PER_RENDER);
  }

  const creatorSlug =
    typeof body.creatorSlug === "string"
      ? body.creatorSlug.trim().toLowerCase().slice(0, 64)
      : "";

  const admin = supabaseAdmin();

  const userRow = await admin
    .from("users")
    .select("age_verified_at, tryon_photo_path")
    .eq("id", session.userId)
    .maybeSingle();
  if (userRow.error || !userRow.data) {
    console.error(
      "[render] users read failed:",
      userRow.error?.message ?? "missing row"
    );
    return Response.json({ error: "render_failed" }, { status: 500 });
  }
  if (!userRow.data.age_verified_at) {
    return Response.json({ error: "age_not_verified" }, { status: 403 });
  }
  const photoPath = userRow.data.tryon_photo_path as string | null;
  if (!photoPath) {
    return Response.json({ error: "no_photo" }, { status: 412 });
  }

  // Quota pre-check. The consume_render RPC is the final authority and
  // will refuse to overdraw under any race, but the pre-check spares
  // us a multi-second VTON call we cannot bill for.
  const quota = await getRenderQuota(session.userId);
  if (quota.totalRemaining <= 0) {
    return Response.json(
      {
        error: "no_quota",
        included_remaining: quota.includedRemaining,
        pack_balance: quota.packBalance,
      },
      { status: 402 }
    );
  }

  // Fetch the person photo. Failures here are pre-upstream so the
  // user is not charged and we surface a clear error.
  let person: { buffer: Buffer; mime: string };
  try {
    person = await fetchPersonPhoto(photoPath);
  } catch (err) {
    console.error(
      "[render] person photo fetch failed:",
      err instanceof Error ? err.message : String(err)
    );
    return Response.json({ error: "render_failed" }, { status: 500 });
  }

  // Upstream VTON call. runRender returns a structured result so we
  // can map specific failures (moderation, pose, image load) to user-
  // facing error codes without parsing exception messages. No credit
  // is consumed unless result.ok is true.
  const result = await runRender({
    personBuffer: person.buffer,
    personMime: person.mime,
    itemImageUrls: imageUrls,
  });

  if (!result.ok) {
    // Map runRender's structured failure to an HTTP response. Content
    // issues (the input photo or the garment image is the problem)
    // surface as 422 with a specific reason so the grid client can
    // tell the user what went wrong instead of the generic "render
    // didn't come through" copy. Provider / pipeline issues surface
    // as 500. No credit is consumed in either case.
    const k = result.error.kind;
    if (k === "moderation_blocked") {
      console.warn(`[render] 422 moderation_blocked: ${result.error.message}`);
      return Response.json({ error: "moderation_blocked" }, { status: 422 });
    }
    if (k === "pose_error") {
      console.warn(`[render] 422 pose_error: ${result.error.message}`);
      return Response.json({ error: "pose_error" }, { status: 422 });
    }
    if (k === "image_load_error") {
      console.warn(`[render] 422 image_load_error: ${result.error.message}`);
      return Response.json({ error: "image_load_error" }, { status: 422 });
    }
    if (k === "garment_unsupported") {
      console.warn(`[render] 422 garment_unsupported: ${result.error.message}`);
      return Response.json({ error: "garment_unsupported" }, { status: 422 });
    }
    console.error(`[render] 500 ${k}: ${result.error.message}`);
    return Response.json({ error: "render_failed" }, { status: 500 });
  }

  // Upload + sign before consuming the credit. If the upload fails we
  // still have not charged the user (the VTON call already cost money
  // but that is sunk; consuming a credit on top of that would double-
  // punish them for our infrastructure failing).
  let stored: { path: string; signedUrl: string };
  try {
    stored = await uploadRender({
      userId: session.userId,
      pngBuffer: result.pngBuffer,
    });
  } catch (err) {
    console.error(
      "[render] upload failed:",
      err instanceof Error ? err.message : String(err)
    );
    return Response.json({ error: "upload_failed" }, { status: 500 });
  }

  // Atomic credit decrement. After this returns we have a guaranteed
  // source ('included' | 'pack') if charged, or a leak we log if not.
  const consume = await consumeRender(session.userId);
  const source = consume.charged && consume.source ? consume.source : null;

  // Append-only log. Source defaults to 'included' on a leak so the
  // CHECK constraint accepts the row; the leak shows up as a row
  // logged with no matching charged=true credit consumption from the
  // user's running totals.
  await logRender({
    userId: session.userId,
    creatorSlug: creatorSlug || null,
    kind,
    itemCount: imageUrls.length,
    source: source ?? "included",
    imagePath: stored.path,
  });

  if (!consume.charged) {
    console.warn(
      `[render] LEAK user=${session.userId} kind=${kind} provider=${result.provider} path=${stored.path} render produced after quota race; credit not charged`
    );
  }

  return Response.json({
    ok: true,
    signed_url: stored.signedUrl,
    kind,
    source,
    included_remaining: consume.includedRemaining,
    pack_balance: consume.packBalance,
  });
}
