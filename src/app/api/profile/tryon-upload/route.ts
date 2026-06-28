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
 *   5. storage upload (original)
 *   6. input-normalization (Phase A: SegFormer -> mid-gray canvas ->
 *      1024x1536 PNG anchored to a canonical layout). Hard-reject on
 *      no-person / multiple-people.
 *   7. storage upload (normalized)
 *   8. users row update: tryon_photo_path -> normalized,
 *      tryon_original_path -> original, tryon_geometry -> blob
 *
 * Normalization is BLOCKING by design (~5-15 s). Backgrounding it
 * would mean the user's first try-on runs on the un-normalized photo,
 * the exact failure mode normalization is killing. The upload
 * surface shows an "optimizing your photo" state during the wait.
 *
 * Returns:
 *   200 { ok: true, path: "<userId>/<uuid>.normalized.png", geometry: {...} }
 *   400 { error: "invalid_form_data" | "missing_file" | "invalid_file_type" }
 *   401 { error: "not_signed_in" }
 *   403 { error: "age_not_verified" }
 *   404 { error: "user_not_found" }
 *   413 { error: "file_too_large", max: <bytes> }
 *   422 { error: "no_person" | "multiple_people", detail: <string> }
 *   500 { error: "upload_failed" | "normalize_failed" | "store_failed" }
 */

import { getServerSession } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";
import { normalizeTryonPhoto } from "@/lib/normalizeTryonPhoto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// SegFormer-B2 inference + sharp composite typically lands in 5-15 s
// per upload; bumping maxDuration past the Vercel default (60 s) so a
// slow HF response doesn't truncate the route.
export const maxDuration = 120;

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

  // Path layout: {userId}/{uuid}.original.{ext} for the raw upload,
  // {userId}/{uuid}.normalized.png for the 1024x1536 canvas we feed
  // to every render. Shared uuid pairs them so a retention sweep
  // can find both halves of a single upload.
  const uuid = crypto.randomUUID();
  const originalPath = `${session.userId}/${uuid}.original.${extForMime(contentType)}`;
  const normalizedPath = `${session.userId}/${uuid}.normalized.png`;

  // Step 5: upload the original first. If anything downstream
  // (normalization, normalized upload, row update) fails, we roll
  // back this object so the bucket isn't left with an orphan.
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

  // Read the original bytes once for the normalizer. Doing it here
  // keeps the file Blob below from being consumed twice; sharp/SegFormer
  // need Buffer, the upload above needed Blob.
  const photoBuffer = Buffer.from(await file.arrayBuffer());

  // Step 6: normalize. Blocking on purpose. Hard-reject inputs that
  // segmentation can't handle (no person / multi-person) so the user
  // finds out at upload time instead of wasting render credits.
  let result;
  try {
    result = await normalizeTryonPhoto(photoBuffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[tryon-upload] normalization threw:", msg);
    await admin.storage
      .from("tryon-photos")
      .remove([originalPath])
      .catch(() => {});
    return Response.json(
      { error: "normalize_failed", detail: msg.slice(0, 200) },
      { status: 500 }
    );
  }
  if (!result.ok) {
    console.warn(
      `[tryon-upload] normalization rejected: ${result.rejectReason} (${result.detail})`
    );
    await admin.storage
      .from("tryon-photos")
      .remove([originalPath])
      .catch(() => {});
    return Response.json(
      { error: result.rejectReason, detail: result.detail },
      { status: 422 }
    );
  }

  // Step 7: upload the normalized PNG.
  const upNorm = await admin.storage
    .from("tryon-photos")
    .upload(normalizedPath, result.pngBuffer, {
      contentType: "image/png",
      upsert: false,
    });
  if (upNorm.error) {
    console.error(
      "[tryon-upload] normalized upload failed:",
      upNorm.error.message
    );
    await admin.storage
      .from("tryon-photos")
      .remove([originalPath])
      .catch(() => {});
    return Response.json({ error: "upload_failed" }, { status: 500 });
  }

  // Step 8: row update. tryon_photo_path -> normalized (what render
  // reads), tryon_original_path -> raw (for future re-normalization),
  // tryon_geometry -> the JSONB blob the render-time face composite
  // will read in Phase C.
  const upd = await admin
    .from("users")
    .update({
      tryon_photo_path: normalizedPath,
      tryon_original_path: originalPath,
      tryon_geometry: result.geometry,
    })
    .eq("id", session.userId);
  if (upd.error) {
    console.error("[tryon-upload] users update failed:", upd.error.message);
    // Roll back BOTH storage uploads so no orphan rows in the bucket
    // and no half-state on the user (path still pointing at the prior
    // upload; new files in storage with nothing referencing them).
    await admin.storage
      .from("tryon-photos")
      .remove([originalPath, normalizedPath])
      .catch(() => {});
    return Response.json({ error: "store_failed" }, { status: 500 });
  }

  console.log(
    `[tryon-upload] ok user=${session.userId} anchor=${result.geometry.anchor_used} scale=${result.geometry.scale} partial_body=${result.geometry.partial_body}`
  );
  return Response.json({
    ok: true,
    path: normalizedPath,
    geometry: result.geometry,
  });
}
