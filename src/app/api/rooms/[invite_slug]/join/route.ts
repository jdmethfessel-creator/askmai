/**
 * POST /api/rooms/[invite_slug]/join
 *
 * Join a Shared Fitting Room as a member. No photo required: voters
 * and commenters get full read + comment + react access from the same
 * membership row. Uploading a photo + submitting a look are separate,
 * later steps handled by /submissions.
 *
 * Behavior:
 *   - Anonymous request -> 401. The client opens SignInModal in place.
 *   - Room archived -> 410 gone.
 *   - Already an active member -> 200 ok (idempotent).
 *   - Previously removed (removed_at set) -> 403 removed; a host has
 *     to reinstate. Silent re-join would let a booted troll walk back
 *     through the invite link.
 *   - Fresh join -> insert membership, return 200.
 *
 * Response:
 *   200 { ok: true, membership: { role, joined_at } }
 *   401 { error: "not_signed_in" }
 *   403 { error: "removed" }
 *   404 { error: "not_found" }
 *   410 { error: "archived" }
 *   500 { error: "join_failed" }
 */

import { getServerSession } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";
import { broadcastRoomChange, loadRoomBySlug } from "@/lib/rooms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { invite_slug: string };

export async function POST(_request: Request, ctx: { params: Params }) {
  const session = await getServerSession();
  if (!session) {
    return Response.json({ error: "not_signed_in" }, { status: 401 });
  }

  const room = await loadRoomBySlug(ctx.params.invite_slug);
  if (!room) return Response.json({ error: "not_found" }, { status: 404 });
  if (room.is_archived) {
    return Response.json({ error: "archived" }, { status: 410 });
  }

  const admin = supabaseAdmin();

  // Any prior membership row wins over an insert. We hand the caller
  // an idempotent 200 for an already-active member and a 403 for a
  // soft-removed one.
  const existing = await admin
    .from("fitting_room_members")
    .select("id, role, removed_at, joined_at")
    .eq("room_id", room.id)
    .eq("user_id", session.userId)
    .maybeSingle();

  if (existing.error) {
    console.error("[rooms] join lookup failed:", existing.error.message);
    return Response.json({ error: "join_failed" }, { status: 500 });
  }

  if (existing.data) {
    if (existing.data.removed_at) {
      return Response.json({ error: "removed" }, { status: 403 });
    }
    return Response.json({
      ok: true,
      membership: {
        role: existing.data.role,
        joined_at: existing.data.joined_at,
      },
    });
  }

  const ins = await admin
    .from("fitting_room_members")
    .insert({
      room_id: room.id,
      user_id: session.userId,
      role: "member",
    })
    .select("role, joined_at")
    .maybeSingle();

  if (ins.error || !ins.data) {
    console.error("[rooms] join insert failed:", ins.error?.message);
    return Response.json({ error: "join_failed" }, { status: 500 });
  }

  await broadcastRoomChange(room.invite_slug);

  return Response.json({
    ok: true,
    membership: { role: ins.data.role, joined_at: ins.data.joined_at },
  });
}
