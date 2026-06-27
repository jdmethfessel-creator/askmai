/**
 * GET /api/render/quota
 *
 * Read-only quota + gate status. The Chat component calls this once
 * on mount (when signed in) to decide:
 *
 *   - whether to show the render buttons at all
 *     (signed in + age verified + has photo)
 *   - what label to put on them
 *     ("Show This Item" / "Try This Outfit" while quota > 0,
 *      "Buy Image Package" when quota == 0)
 *
 * Anonymous callers get 200 with signed_in=false so the client can
 * stay silent without an error rail. The actual gates re-run inside
 * POST /api/render — this endpoint never grants access on its own.
 *
 * Returns:
 *   200 {
 *     signed_in: boolean,
 *     age_verified: boolean,
 *     has_photo: boolean,
 *     included_remaining: number,
 *     pack_balance: number,
 *     total_remaining: number,
 *   }
 */

import { getServerSession } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";
import { getRenderQuota } from "@/lib/render";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession();
  if (!session) {
    return Response.json({
      signed_in: false,
      age_verified: false,
      has_photo: false,
      included_remaining: 0,
      pack_balance: 0,
      total_remaining: 0,
    });
  }

  const admin = supabaseAdmin();
  const userRow = await admin
    .from("users")
    .select("age_verified_at, tryon_photo_path")
    .eq("id", session.userId)
    .maybeSingle();
  const ageVerified = Boolean(userRow.data?.age_verified_at);
  const hasPhoto = Boolean(userRow.data?.tryon_photo_path);

  const quota = await getRenderQuota(session.userId);
  return Response.json({
    signed_in: true,
    age_verified: ageVerified,
    has_photo: hasPhoto,
    included_remaining: quota.includedRemaining,
    pack_balance: quota.packBalance,
    total_remaining: quota.totalRemaining,
  });
}
