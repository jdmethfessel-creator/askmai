/**
 * /profile
 *
 * Signed-in only. Reads the user row plus a signed URL for the
 * current try-on photo (if any) and hands the read-only state to
 * the client component. All mutations route through the dedicated
 * /api/profile/* endpoints; this page never writes.
 *
 * Anonymous visitors redirect to / where the global sign-in modal
 * can be triggered from the nav.
 */

import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";
import { ProfileClient } from "./ProfileClient";
import "./profile.css";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PHOTO_SIGNED_URL_TTL_SECONDS = 300; // 5 minutes is plenty for a profile render

export default async function ProfilePage() {
  const session = await getServerSession();
  if (!session) {
    redirect("/");
  }

  const admin = supabaseAdmin();
  const row = await admin
    .from("users")
    .select(
      "email, display_name, age_verified_at, tryon_photo_path, tryon_original_path"
    )
    .eq("id", session.userId)
    .maybeSingle();
  if (row.error || !row.data) {
    redirect("/");
  }

  // Profile thumbnail shows the user's RAW uploaded photo, not the
  // normalized canvas. tryon_original_path is set on every upload
  // since the canvas-normalization shipped; older uploads may only
  // have tryon_photo_path, so we fall back to that. (For older rows
  // tryon_photo_path IS the original; only post-normalization
  // uploads diverge the two columns.)
  const thumbnailPath =
    (row.data.tryon_original_path as string | null) ??
    (row.data.tryon_photo_path as string | null);

  let photoUrl: string | null = null;
  if (thumbnailPath) {
    const signed = await admin.storage
      .from("tryon-photos")
      .createSignedUrl(thumbnailPath, PHOTO_SIGNED_URL_TTL_SECONDS);
    if (signed.data?.signedUrl) {
      photoUrl = signed.data.signedUrl;
    } else if (signed.error) {
      console.error(
        "[profile] failed to sign tryon photo URL:",
        signed.error.message
      );
    }
  }

  return (
    <ProfileClient
      email={row.data.email as string}
      initialDisplayName={(row.data.display_name as string | null) ?? ""}
      ageVerified={Boolean(row.data.age_verified_at)}
      photoUrl={photoUrl}
    />
  );
}
