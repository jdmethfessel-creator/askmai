/**
 * DELETE /api/rooms/[invite_slug]/comments/[comment_id]
 *
 * Remove a comment. Author or host only. Soft-delete via deleted_at.
 *
 * Response:
 *   200 { ok: true }
 *   401 { error: "not_signed_in" }
 *   403 { error: "forbidden" | "not_a_member" }
 *   404 { error: "not_found" | "comment_not_found" }
 */

import { getServerSession } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";
import { loadActiveMembership, loadRoomBySlug } from "@/lib/rooms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { invite_slug: string; comment_id: string };

export async function DELETE(_request: Request, ctx: { params: Params }) {
  const session = await getServerSession();
  if (!session) {
    return Response.json({ error: "not_signed_in" }, { status: 401 });
  }

  const room = await loadRoomBySlug(ctx.params.invite_slug);
  if (!room) return Response.json({ error: "not_found" }, { status: 404 });

  const membership = await loadActiveMembership(room.id, session.userId);
  if (!membership) {
    return Response.json({ error: "not_a_member" }, { status: 403 });
  }

  const admin = supabaseAdmin();
  const cm = await admin
    .from("fitting_room_comments")
    .select("id, user_id, submission_id, deleted_at")
    .eq("id", ctx.params.comment_id)
    .maybeSingle();
  if (cm.error || !cm.data) {
    return Response.json({ error: "comment_not_found" }, { status: 404 });
  }

  // Verify the comment belongs to a submission in this room.
  const sub = await admin
    .from("fitting_room_submissions")
    .select("room_id")
    .eq("id", cm.data.submission_id)
    .maybeSingle();
  if (sub.error || !sub.data || sub.data.room_id !== room.id) {
    return Response.json({ error: "comment_not_found" }, { status: 404 });
  }

  const isHost = room.host_user_id === session.userId;
  const isAuthor = cm.data.user_id === session.userId;
  if (!isHost && !isAuthor) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (cm.data.deleted_at) {
    return Response.json({ ok: true });
  }

  const del = await admin
    .from("fitting_room_comments")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", cm.data.id);
  if (del.error) {
    console.error("[rooms] comment delete failed:", del.error.message);
    return Response.json({ error: "delete_failed" }, { status: 500 });
  }

  return Response.json({ ok: true });
}
