/**
 * DELETE /api/rooms/[invite_slug]/submissions/[submission_id]
 *
 * Remove a look from a room. Two allowed callers:
 *   - the submitter (their own look)
 *   - the room host (any look)
 * Anyone else -> 403 forbidden. Soft-delete via deleted_at so the
 * feed hides it while history stays intact for audit.
 *
 * Response:
 *   200 { ok: true }
 *   401 { error: "not_signed_in" }
 *   403 { error: "forbidden" | "not_a_member" }
 *   404 { error: "not_found" | "submission_not_found" }
 */

import { getServerSession } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";
import { broadcastRoomChange, loadActiveMembership, loadRoomBySlug } from "@/lib/rooms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { invite_slug: string; submission_id: string };

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
  const sub = await admin
    .from("fitting_room_submissions")
    .select("id, submitter_id, room_id, deleted_at")
    .eq("id", ctx.params.submission_id)
    .maybeSingle();
  if (sub.error || !sub.data) {
    return Response.json({ error: "submission_not_found" }, { status: 404 });
  }
  if (sub.data.room_id !== room.id) {
    return Response.json({ error: "submission_not_found" }, { status: 404 });
  }

  const isHost = room.host_user_id === session.userId;
  const isSubmitter = sub.data.submitter_id === session.userId;
  if (!isHost && !isSubmitter) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  // Idempotent: a second DELETE succeeds and stays a no-op.
  if (sub.data.deleted_at) {
    return Response.json({ ok: true });
  }

  const del = await admin
    .from("fitting_room_submissions")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", sub.data.id);
  if (del.error) {
    console.error("[rooms] submission delete failed:", del.error.message);
    return Response.json({ error: "delete_failed" }, { status: 500 });
  }

  await broadcastRoomChange(room.invite_slug);

  return Response.json({ ok: true });
}
