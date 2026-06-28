/**
 * POST /api/admin/regenerate-canvas
 *
 * One-off / on-demand admin route to backfill the neutral-basics
 * canvas for users whose stored tryon_photo_path is the raw upload
 * (i.e. they uploaded before canvas normalization shipped, or
 * normalization failed at upload time and fell back to the raw).
 *
 * Detection rule: a stored canvas path always ends in ".canvas.png"
 * (set by the new upload route in src/app/api/profile/tryon-upload).
 * Anything else is the raw upload and needs normalization.
 *
 * Flow per affected user:
 *   1. Read tryon_photo_path (the raw photo for these users).
 *   2. Download the bytes from the tryon-photos bucket.
 *   3. Run normalizeCanvas (two FASHN passes: tank + shorts) using
 *      the hardcoded defaults in vton.ts.
 *   4. Upload result as <userId>/<uuid>.canvas.png.
 *   5. Update row: tryon_photo_path = canvas path,
 *      tryon_original_path = the prior raw path. Future renders
 *      now read the normalized canvas.
 *
 * If normalization fails for a user, log and skip; the user's row
 * is untouched. Re-running the route is idempotent (already-
 * normalized users are detected by the .canvas.png suffix and
 * skipped on subsequent runs).
 *
 * Optional body: { userIds?: string[] } to target a specific set
 * of users. Default: process every user whose canvas path doesn't
 * end with .canvas.png.
 *
 * Auth: header `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`,
 * same pattern as recategorize-cass.
 *
 * Returns:
 *   200 {
 *     ok: true,
 *     scanned: number,
 *     already_normalized: number,
 *     newly_normalized: number,
 *     failed: number,
 *     failures: Array<{ userId, reason, detail }>,
 *     total_credits_used: number,
 *   }
 *   401 { error: "unauthorized" }
 *   500 { error: string }
 */

import { supabaseAdmin } from "@/lib/supabase";
import { normalizeCanvas } from "@/lib/vton";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Each user takes ~16-20s for normalization (two balanced FASHN
// passes). 300s covers a handful of test users; for larger backfills
// the route should be called in batches via the userIds body field.
export const maxDuration = 300;

const CANVAS_SUFFIX = ".canvas.png";

type IncomingBody = {
  userIds?: string[];
};

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

  let body: IncomingBody = {};
  try {
    body = (await request.json()) as IncomingBody;
  } catch {
    // empty body is fine; default to processing all users
  }

  const admin = supabaseAdmin();

  let userIds: string[];
  if (Array.isArray(body.userIds) && body.userIds.length > 0) {
    userIds = body.userIds.filter((s) => typeof s === "string" && s.length > 0);
  } else {
    const { data, error } = await admin
      .from("users")
      .select("id, tryon_photo_path")
      .not("tryon_photo_path", "is", null);
    if (error) {
      return Response.json(
        { error: `users scan failed: ${error.message}` },
        { status: 500 }
      );
    }
    userIds = (data ?? [])
      .filter(
        (r) =>
          typeof r.tryon_photo_path === "string" &&
          !(r.tryon_photo_path as string).endsWith(CANVAS_SUFFIX)
      )
      .map((r) => r.id as string);
  }

  const result = {
    ok: true as const,
    scanned: userIds.length,
    already_normalized: 0,
    newly_normalized: 0,
    failed: 0,
    failures: [] as Array<{
      userId: string;
      reason: string;
      detail: string;
    }>,
    total_credits_used: 0,
  };

  for (const userId of userIds) {
    const userRow = await admin
      .from("users")
      .select("tryon_photo_path, tryon_original_path")
      .eq("id", userId)
      .maybeSingle();
    if (userRow.error || !userRow.data) {
      result.failures.push({
        userId,
        reason: "user_read_failed",
        detail: userRow.error?.message ?? "missing row",
      });
      result.failed++;
      continue;
    }
    const currentPath = userRow.data.tryon_photo_path as string | null;
    if (!currentPath) {
      result.failures.push({
        userId,
        reason: "no_photo_path",
        detail: "user has no tryon_photo_path; nothing to regenerate",
      });
      result.failed++;
      continue;
    }
    if (currentPath.endsWith(CANVAS_SUFFIX)) {
      // Idempotent skip: already normalized.
      result.already_normalized++;
      continue;
    }

    // Download the raw photo bytes from the bucket.
    const dl = await admin.storage.from("tryon-photos").download(currentPath);
    if (dl.error || !dl.data) {
      result.failures.push({
        userId,
        reason: "raw_download_failed",
        detail: dl.error?.message ?? "no data",
      });
      result.failed++;
      continue;
    }
    const rawBuffer = Buffer.from(await dl.data.arrayBuffer());
    const rawMime = dl.data.type || "image/jpeg";

    // Two-pass FASHN normalization via the same helper the upload
    // route uses. Hardcoded defaults in vton.ts.
    const norm = await normalizeCanvas({
      personBuffer: rawBuffer,
      personMime: rawMime,
    });
    if (!norm.ok) {
      result.failures.push({
        userId,
        reason: norm.reason,
        detail: norm.detail.slice(0, 300),
      });
      result.failed++;
      continue;
    }

    // Upload the canvas under the existing user's folder. Path
    // mirrors the upload route's convention: shared uuid pairs
    // original + canvas. We reuse the raw photo's uuid stem when
    // we can parse it; otherwise fall back to a fresh uuid.
    const filename = currentPath.split("/").pop() ?? "";
    const stem = filename.split(".")[0] || crypto.randomUUID();
    const canvasPath = `${userId}/${stem}.canvas.png`;

    const up = await admin.storage
      .from("tryon-photos")
      .upload(canvasPath, norm.pngBuffer, {
        contentType: "image/png",
        upsert: true, // tolerate re-runs after a partial failure
      });
    if (up.error) {
      result.failures.push({
        userId,
        reason: "canvas_upload_failed",
        detail: up.error.message,
      });
      result.failed++;
      continue;
    }

    // Switch the user's pointers: canvas becomes the render path,
    // raw becomes the thumbnail path. tryon_original_path is set
    // to the raw photo (the value that used to live at
    // tryon_photo_path before this run).
    const upd = await admin
      .from("users")
      .update({
        tryon_photo_path: canvasPath,
        tryon_original_path: currentPath,
      })
      .eq("id", userId);
    if (upd.error) {
      result.failures.push({
        userId,
        reason: "row_update_failed",
        detail: upd.error.message,
      });
      result.failed++;
      // Roll back the canvas upload so the user's storage doesn't
      // diverge from their row.
      await admin.storage
        .from("tryon-photos")
        .remove([canvasPath])
        .catch(() => {});
      continue;
    }

    result.newly_normalized++;
    result.total_credits_used += norm.totalCreditsUsed;
    console.log(
      `[regenerate-canvas] user=${userId} canvas=${canvasPath} credits=${norm.totalCreditsUsed} runtime=${norm.runtimeMs}ms`
    );
  }

  return Response.json(result);
}
