/**
 * POST /api/rooms/[invite_slug]/submissions/[submission_id]/reactions
 *
 * Toggle a reaction on a submission. Kinds:
 *   - "upvote"
 *   - "emoji:<glyph>" where glyph is in EMOJI_ALLOWLIST
 * Downvotes don't exist as a kind and are structurally impossible.
 *
 * Toggle rule: presence check first; DELETE if a row exists for
 * (submission, user, kind), INSERT otherwise. The unique constraint
 * guards against a race producing duplicates.
 *
 * Body:
 *   { kind: string }
 *
 * Response:
 *   200 { ok: true, state: "added" | "removed" }
 *   400 { error: "invalid_request" | "invalid_kind" }
 *   401 { error: "not_signed_in" }
 *   403 { error: "not_a_member" }
 *   404 { error: "not_found" | "submission_not_found" }
 *   410 { error: "archived" }
 */

import { getServerSession } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";
import {
  loadActiveMembership,
  loadRoomBySlug,
  normalizeReactionKind,
} from "@/lib/rooms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { invite_slug: string; submission_id: string };
type Body = { kind?: string };

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
  const kind = normalizeReactionKind(String(body.kind ?? ""));
  if (!kind) {
    return Response.json({ error: "invalid_kind" }, { status: 400 });
  }

  const admin = supabaseAdmin();

  // Verify the submission lives in THIS room + isn't tombstoned. A
  // reaction on a deleted submission is dropped so a soft-deleted
  // look can't accumulate ghost reactions.
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

  const existing = await admin
    .from("fitting_room_reactions")
    .select("id")
    .eq("submission_id", sub.data.id)
    .eq("user_id", session.userId)
    .eq("kind", kind)
    .maybeSingle();

  if (existing.data) {
    const del = await admin
      .from("fitting_room_reactions")
      .delete()
      .eq("id", existing.data.id);
    if (del.error) {
      console.error("[rooms] reaction remove failed:", del.error.message);
      return Response.json({ error: "reaction_failed" }, { status: 500 });
    }
    return Response.json({ ok: true, state: "removed" });
  }

  const ins = await admin.from("fitting_room_reactions").insert({
    submission_id: sub.data.id,
    user_id: session.userId,
    kind,
  });
  if (ins.error) {
    // 23505 = unique_violation. Race between two concurrent adds;
    // treat as "already added" and return "added".
    if ((ins.error as { code?: string }).code !== "23505") {
      console.error("[rooms] reaction add failed:", ins.error.message);
      return Response.json({ error: "reaction_failed" }, { status: 500 });
    }
  }
  return Response.json({ ok: true, state: "added" });
}
