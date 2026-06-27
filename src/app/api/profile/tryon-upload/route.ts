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
 *   6. users.tryon_photo_path update
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

  // Path layout: {userId}/{uuid}.{ext}. The userId prefix lets us add
  // a row level storage policy later without rebuilding paths.
  const uuid = crypto.randomUUID();
  const path = `${session.userId}/${uuid}.${extForMime(contentType)}`;

  const upload = await admin.storage
    .from("tryon-photos")
    .upload(path, file, {
      contentType,
      upsert: false,
    });
  if (upload.error) {
    console.error(
      "[tryon-upload] storage upload failed:",
      upload.error.message
    );
    return Response.json({ error: "upload_failed" }, { status: 500 });
  }

  // Replace the existing path on the user row. If the user previously
  // uploaded a photo, we leave the old object in storage for now (a
  // separate retention pass can sweep orphans). The row points at
  // the new path so renders use the latest photo.
  const upd = await admin
    .from("users")
    .update({ tryon_photo_path: path })
    .eq("id", session.userId);
  if (upd.error) {
    console.error("[tryon-upload] users update failed:", upd.error.message);
    // Roll back the storage upload so we do not leave an orphan that
    // no user row points at.
    await admin.storage
      .from("tryon-photos")
      .remove([path])
      .catch(() => {
        // Best effort cleanup; do not mask the original failure.
      });
    return Response.json({ error: "store_failed" }, { status: 500 });
  }

  return Response.json({ ok: true, path });
}
