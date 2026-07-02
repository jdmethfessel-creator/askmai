/**
 * POST /api/rooms/[invite_slug]/submissions/[submission_id]/comments
 *
 * Post a comment on a submission. One level of threading via
 * parent_id. Body is 1..COMMENT_MAX chars.
 *
 * Body:
 *   { body: string, parentId?: string | null }
 *
 * Response:
 *   200 { ok: true, comment: { id, created_at } }
 *   400 { error: "invalid_request" | "invalid_body" }
 *   401 { error: "not_signed_in" }
 *   403 { error: "not_a_member" }
 *   404 { error: "not_found" | "submission_not_found" | "parent_not_found" }
 *   410 { error: "archived" }
 */

import { getServerSession } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";
import {
  COMMENT_MAX,
  loadActiveMembership,
  loadRoomBySlug,
} from "@/lib/rooms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { invite_slug: string; submission_id: string };
type Body = { body?: string; parentId?: string | null };

export async function POST(request: Request, ctx: { params: Params }) {
  const session = await getServerSession();
  if (!session) {
    return Response.json({ error: "not_signed_in" }, { status: 401 });
  }

  const room = await loadRoomBySlug(ctx.params.invite_slug);
  if (!room) return Response.json({ error: "not_found" }, { status: 404 });
  if (room.is_archived) {
    return Response.json({ error: "archived" }, { status: 410 });
  }

  const membership = await loadActiveMembership(room.id, session.userId);
  if (!membership) {
    return Response.json({ error: "not_a_member" }, { status: 403 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!text || text.length > COMMENT_MAX) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  const parentId =
    typeof body.parentId === "string" && body.parentId.trim()
      ? body.parentId.trim()
      : null;

  const admin = supabaseAdmin();

  const sub = await admin
    .from("fitting_room_submissions")
    .select("id, room_id, deleted_at")
    .eq("id", ctx.params.submission_id)
    .maybeSingle();
  if (
    sub.error ||
    !sub.data ||
    sub.data.room_id !== room.id ||
    sub.data.deleted_at
  ) {
    return Response.json({ error: "submission_not_found" }, { status: 404 });
  }

  if (parentId) {
    const parent = await admin
      .from("fitting_room_comments")
      .select("id, submission_id, deleted_at")
      .eq("id", parentId)
      .maybeSingle();
    if (
      parent.error ||
      !parent.data ||
      parent.data.submission_id !== sub.data.id ||
      parent.data.deleted_at
    ) {
      return Response.json({ error: "parent_not_found" }, { status: 404 });
    }
  }

  const ins = await admin
    .from("fitting_room_comments")
    .insert({
      submission_id: sub.data.id,
      user_id: session.userId,
      parent_id: parentId,
      body: text,
    })
    .select("id, created_at")
    .maybeSingle();

  if (ins.error || !ins.data) {
    console.error("[rooms] comment insert failed:", ins.error?.message);
    return Response.json({ error: "comment_failed" }, { status: 500 });
  }

  return Response.json({
    ok: true,
    comment: { id: ins.data.id, created_at: ins.data.created_at },
  });
}
