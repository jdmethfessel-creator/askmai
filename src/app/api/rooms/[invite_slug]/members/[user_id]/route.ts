/**
 * DELETE /api/rooms/[invite_slug]/members/[user_id]
 *
 * Host removes a member. Sets removed_at so the member's prior
 * reactions and comments stay in place (avoids cascading a member's
 * history into inconsistency) but they lose feed access and can't
 * silently re-join through the invite link.
 *
 * A host removing themselves is 400: the room should be archived
 * separately, not left member-less.
 *
 * Response:
 *   200 { ok: true }
 *   400 { error: "cannot_remove_host" }
 *   401 { error: "not_signed_in" }
 *   403 { error: "forbidden" }
 *   404 { error: "not_found" | "member_not_found" }
 */

import { getServerSession } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";
import { loadRoomBySlug } from "@/lib/rooms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { invite_slug: string; user_id: string };

export async function DELETE(_request: Request, ctx: { params: Params }) {
  const session = await getServerSession();
  if (!session) {
    return Response.json({ error: "not_signed_in" }, { status: 401 });
  }

  const room = await loadRoomBySlug(ctx.params.invite_slug);
  if (!room) return Response.json({ error: "not_found" }, { status: 404 });

  if (room.host_user_id !== session.userId) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const targetId = ctx.params.user_id;
  if (targetId === room.host_user_id) {
    return Response.json({ error: "cannot_remove_host" }, { status: 400 });
  }

  const admin = supabaseAdmin();
  const member = await admin
    .from("fitting_room_members")
    .select("id, removed_at")
    .eq("room_id", room.id)
    .eq("user_id", targetId)
    .maybeSingle();
  if (member.error || !member.data) {
    return Response.json({ error: "member_not_found" }, { status: 404 });
  }
  if (member.data.removed_at) {
    return Response.json({ ok: true });
  }

  const upd = await admin
    .from("fitting_room_members")
    .update({ removed_at: new Date().toISOString() })
    .eq("id", member.data.id);
  if (upd.error) {
    console.error("[rooms] remove member failed:", upd.error.message);
    return Response.json({ error: "remove_failed" }, { status: 500 });
  }

  return Response.json({ ok: true });
}
