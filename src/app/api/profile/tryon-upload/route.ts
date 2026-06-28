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
 *   5. storage upload
 *   6. users row update: tryon_photo_path -> <path>
 *
 * Note: this route used to run a blocking SegFormer normalization
 * pass after upload (mid-gray canvas, garment neutralization, anchor
 * ladder) to make gpt-image-1's output usable. That whole pipeline
 * was removed when we switched to VTON (FASHN tryon-v1.6) in
 * Phase 3, because the VTON model uses the photo as the literal
 * canvas; normalization would actively hurt the result. The user's
 * original upload now goes straight into the bucket and is read by
 * runRender as-is.
 *
 * Returns:
 *   200 { ok: true, path: "<userId>/<uuid>.<ext>" }
 *   400 { error: "invalid_form_data" | "missing_file" | "invalid_file_type" }
 *   401 { error: "not_signed_in" }
 *   403 { error: "age_not_verified" }
 *   404 { error: "user_not_found" }
 *   413 { error: "file_too_large", max: <bytes> }
 *   500 { error: "upload_failed" | "store_failed" }
 */

import { getServerSession } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// No more SegFormer call; this route is just multipart -> bucket ->
// row update. The Vercel default 60s is plenty.
export const maxDuration = 30;

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

  const uuid = crypto.randomUUID();
  const photoPath = `${session.userId}/${uuid}.${extForMime(contentType)}`;

  const up = await admin.storage
    .from("tryon-photos")
    .upload(photoPath, file, { contentType, upsert: false });
  if (up.error) {
    console.error("[tryon-upload] upload failed:", up.error.message);
    return Response.json({ error: "upload_failed" }, { status: 500 });
  }

  // Row update. tryon_photo_path is what runRender reads on every
  // render. The legacy tryon_original_path and tryon_geometry columns
  // (used by the pre-VTON normalization pipeline) are now unused; we
  // null them on upload to keep state consistent across schema
  // versions. Dropping the columns themselves is a future migration.
  const upd = await admin
    .from("users")
    .update({
      tryon_photo_path: photoPath,
      tryon_original_path: null,
      tryon_geometry: null,
    })
    .eq("id", session.userId);
  if (upd.error) {
    console.error("[tryon-upload] users update failed:", upd.error.message);
    await admin.storage
      .from("tryon-photos")
      .remove([photoPath])
      .catch(() => {});
    return Response.json({ error: "store_failed" }, { status: 500 });
  }

  console.log(
    `[tryon-upload] ok user=${session.userId} path=${photoPath} bytes=${file.size}`
  );
  return Response.json({ ok: true, path: photoPath });
}
