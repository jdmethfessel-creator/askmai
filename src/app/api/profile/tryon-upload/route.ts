/**
 * POST /api/profile/tryon-upload
 *
 * Try-on photo upload, gated by the age verification stamp. Multipart
 * form with a single "file" field.
 *
 * CRITICAL: the age gate is re-checked here INDEPENDENTLY before any
 * byte of the multipart body is read. Conflating the gate with the
 * upload route (e.g. parsing the file first then checking the row)
 * would mean a leaked tmp file on the server even for an unverified
 * caller. Order is non-negotiable:
 *
 *   1. session
 *   2. age_verified_at IS NOT NULL  <-- this guard, before formData()
 *   3. formData() parse
 *   4. MIME + size validation
 *   5. storage upload (original; this is what the profile thumbnail
 *      shows)
 *   6. canvas normalization: two FASHN passes (apply neutral tank,
 *      then apply neutral bike shorts) to produce a coherent
 *      separates canvas. Optional; skipped when env vars are missing.
 *      Failure here is non-fatal: we fall back to the original photo
 *      as the canvas (preserves working renders, but the partial-
 *      outfit-coherence bug is intact for that user).
 *   7. storage upload (canvas, if normalization ran)
 *   8. users row update:
 *        tryon_photo_path     -> canvas (used by /api/render)
 *        tryon_original_path  -> original (used by profile thumbnail)
 *
 * Why normalize: when the uploaded photo shows the user in a dress
 * and they try on a top, FASHN's localized swap leaves the dress
 * skirt visible below the new top. The neutral-basics canvas
 * guarantees the upper region has a tank and the lower region has
 * shorts, so any subsequent VTON pass replaces a coherent piece.
 *
 * Returns:
 *   200 { ok: true, path: "<userId>/<uuid>.<ext>", canvas_normalized: boolean }
 *   400 { error: "invalid_form_data" | "missing_file" | "invalid_file_type" }
 *   401 { error: "not_signed_in" }
 *   403 { error: "age_not_verified" }
 *   404 { error: "user_not_found" }
 *   413 { error: "file_too_large", max: <bytes> }
 *   500 { error: "upload_failed" | "store_failed" }
 */

import { getServerSession } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";
import { normalizeCanvas } from "@/lib/vton";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Two FASHN balanced passes at ~8s each = ~16-20s normalization,
// plus multipart read + storage upload = ~25-30s typical. 90s leaves
// room for a slow pass or a retry.
export const maxDuration = 90;

const MAX_BYTES = 8 * 1024 * 1024; // 8 MiB, matches the bucket file_size_limit
const ALLOWED_MIME = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
]);

function extForMime(mime: string): string {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/heic":
      return "heic";
    default:
      return "bin";
  }
}

export async function POST(request: Request) {
  const session = await getServerSession();
  if (!session) {
    return Response.json({ error: "not_signed_in" }, { status: 401 });
  }

  const admin = supabaseAdmin();

  // Gate 1: age_verified_at must be set. Read BEFORE touching the
  // multipart body. If null, return 403 without reading a single byte
  // of the upload payload. The independent check (not relying on the
  // age-verify route having been called previously) is what makes
  // this route safe to expose.
  const userRow = await admin
    .from("users")
    .select("age_verified_at")
    .eq("id", session.userId)
    .maybeSingle();
  if (userRow.error) {
    console.error("[tryon-upload] users read failed:", userRow.error.message);
    return Response.json({ error: "store_failed" }, { status: 500 });
  }
  if (!userRow.data) {
    return Response.json({ error: "user_not_found" }, { status: 404 });
  }
  if (!userRow.data.age_verified_at) {
    return Response.json({ error: "age_not_verified" }, { status: 403 });
  }

  // Now safe to parse the multipart body.
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: "invalid_form_data" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof Blob)) {
    return Response.json({ error: "missing_file" }, { status: 400 });
  }

  if (file.size > MAX_BYTES) {
    return Response.json(
      { error: "file_too_large", max: MAX_BYTES },
      { status: 413 }
    );
  }

  const contentType = file.type || "";
  if (!ALLOWED_MIME.has(contentType)) {
    return Response.json({ error: "invalid_file_type" }, { status: 400 });
  }

  // Path layout: <userId>/<uuid>.original.<ext> for the raw upload
  // (thumbnail source), <userId>/<uuid>.canvas.png for the
  // normalized canvas (render input). Shared uuid pairs them so a
  // retention sweep finds both halves of a single upload.
  const uuid = crypto.randomUUID();
  const ext = extForMime(contentType);
  const originalPath = `${session.userId}/${uuid}.original.${ext}`;
  const canvasPath = `${session.userId}/${uuid}.canvas.png`;

  // Step 5: upload the original. This is what the profile page
  // shows as the user's photo. If anything downstream fails, the
  // original stays in the bucket only when the row update succeeds
  // (we roll back on row-update failure to avoid orphans).
  const upOrig = await admin.storage
    .from("tryon-photos")
    .upload(originalPath, file, { contentType, upsert: false });
  if (upOrig.error) {
    console.error(
      "[tryon-upload] original upload failed:",
      upOrig.error.message
    );
    return Response.json({ error: "upload_failed" }, { status: 500 });
  }

  // Read the original bytes once for normalization. Doing it here
  // keeps the Blob from being consumed twice; FASHN needs a Buffer
  // (we encode as data URI), the upload above needed Blob.
  const photoBuffer = Buffer.from(await file.arrayBuffer());

  // Step 6: canvas normalization. Two FASHN passes (tank then
  // shorts) to produce a neutral basics canvas. The basics URLs
  // are hardcoded defaults in vton.ts (DEFAULT_CANVAS_TOP_URL /
  // DEFAULT_CANVAS_BOTTOM_URL); env-var overrides exist but are
  // never required, so normalization always attempts.
  //
  // On runtime failure (FASHN error, timeout, image_load_error),
  // we still fall back to using the original photo as the canvas
  // so the upload succeeds and the user has SOMETHING to render
  // with. The admin route /api/admin/regenerate-canvas can retry
  // normalization for any user whose canvas is the raw photo
  // (detect via path: real canvases end in ".canvas.png").
  let finalCanvasPath = originalPath;
  let canvasNormalized = false;
  const norm = await normalizeCanvas({
    personBuffer: photoBuffer,
    personMime: contentType,
  });
  if (norm.ok) {
    // Step 7: store the normalized canvas.
    const upCanvas = await admin.storage
      .from("tryon-photos")
      .upload(canvasPath, norm.pngBuffer, {
        contentType: "image/png",
        upsert: false,
      });
    if (upCanvas.error) {
      console.error(
        "[tryon-upload] canvas upload failed (falling back to original):",
        upCanvas.error.message
      );
    } else {
      finalCanvasPath = canvasPath;
      canvasNormalized = true;
      console.log(
        `[tryon-upload] canvas normalized user=${session.userId} credits=${norm.totalCreditsUsed} runtime=${norm.runtimeMs}ms`
      );
    }
  } else {
    // Defaults are always set so the no_basics_configured branch
    // is dead in practice; everything else is a real failure worth
    // logging in detail. The render path will still work (using
    // the raw photo as canvas), it'll just have the original
    // outfit visible under partial swaps.
    console.warn(
      `[tryon-upload] canvas normalization failed step=${norm.step ?? "?"} reason=${norm.reason} detail=${norm.detail} (falling back to original as canvas; user can re-trigger via /api/admin/regenerate-canvas)`
    );
  }

  // Step 8: row update. tryon_photo_path = canvas (or original if
  // normalization didn't run); tryon_original_path = original
  // always. The profile thumbnail reads tryon_original_path; the
  // render route reads tryon_photo_path.
  const upd = await admin
    .from("users")
    .update({
      tryon_photo_path: finalCanvasPath,
      tryon_original_path: originalPath,
      tryon_geometry: null,
    })
    .eq("id", session.userId);
  if (upd.error) {
    console.error("[tryon-upload] users update failed:", upd.error.message);
    // Roll back BOTH storage objects (original + canvas) so we don't
    // leave orphans in the bucket.
    const pathsToRemove = [originalPath];
    if (canvasNormalized) pathsToRemove.push(canvasPath);
    await admin.storage
      .from("tryon-photos")
      .remove(pathsToRemove)
      .catch(() => {});
    return Response.json({ error: "store_failed" }, { status: 500 });
  }

  console.log(
    `[tryon-upload] ok user=${session.userId} original=${originalPath} canvas=${finalCanvasPath} normalized=${canvasNormalized} bytes=${file.size}`
  );
  return Response.json({
    ok: true,
    path: finalCanvasPath,
    canvas_normalized: canvasNormalized,
  });
}
