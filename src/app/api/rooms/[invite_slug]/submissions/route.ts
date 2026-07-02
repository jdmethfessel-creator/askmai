/**
 * POST /api/rooms/[invite_slug]/submissions
 *
 * Submit a look to a Shared Fitting Room. This is the ONLY path by
 * which anything from a user's wardrobe becomes visible to other
 * members: no wardrobe sync, no background feed of local looks.
 *
 * The client sends the storage path of a prior /api/render output
 * (renderPath from SavedLook). We verify the path belongs to the
 * caller by matching the leading path segment against the caller's
 * userId; the render bucket layout is `{userId}/{uuid}.png`, so this
 * check is structural rather than requiring a lookup.
 *
 * Body:
 *   {
 *     renderPath: string,
 *     beforePath?: string | null,
 *     itemIds: string[],
 *     itemSnapshots: Array<{ id, name, brand, imageUrl, affiliateUrl }>,
 *     caption?: string
 *   }
 *
 * Response:
 *   200 { ok: true, submission: { id, created_at } }
 *   400 { error: "invalid_request" | "invalid_render_path" |
 *                "invalid_caption" }
 *   401 { error: "not_signed_in" }
 *   403 { error: "not_a_member" }
 *   404 { error: "not_found" }
 *   410 { error: "archived" }
 *   500 { error: "submit_failed" }
 */

import { getServerSession } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";
import {
  CAPTION_MAX,
  loadActiveMembership,
  loadRoomBySlug,
} from "@/lib/rooms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { invite_slug: string };
type Body = {
  renderPath?: string;
  beforePath?: string | null;
  itemIds?: string[];
  itemSnapshots?: Array<{
    id: string;
    name: string;
    brand?: string | null;
    imageUrl: string;
    affiliateUrl: string;
  }>;
  caption?: string | null;
};

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

  const renderPath = typeof body.renderPath === "string" ? body.renderPath.trim() : "";
  // Layout guard: renderPath MUST start with `{callerId}/` so a member
  // can never submit another user's render even if they somehow got
  // the storage path.
  if (!renderPath.startsWith(`${session.userId}/`)) {
    return Response.json({ error: "invalid_render_path" }, { status: 400 });
  }

  const beforePath =
    typeof body.beforePath === "string" && body.beforePath.trim()
      ? body.beforePath.trim()
      : null;
  if (beforePath && !beforePath.startsWith(`${session.userId}/`)) {
    return Response.json({ error: "invalid_render_path" }, { status: 400 });
  }

  const caption =
    typeof body.caption === "string" ? body.caption.trim() : "";
  if (caption.length > CAPTION_MAX) {
    return Response.json({ error: "invalid_caption" }, { status: 400 });
  }

  const itemIds = Array.isArray(body.itemIds)
    ? body.itemIds.filter((x): x is string => typeof x === "string").slice(0, 32)
    : [];
  const itemSnapshots = Array.isArray(body.itemSnapshots)
    ? body.itemSnapshots
        .filter(
          (s) =>
            s &&
            typeof s === "object" &&
            typeof s.id === "string" &&
            typeof s.name === "string" &&
            typeof s.imageUrl === "string" &&
            typeof s.affiliateUrl === "string"
        )
        .slice(0, 32)
    : [];

  const admin = supabaseAdmin();
  const ins = await admin
    .from("fitting_room_submissions")
    .insert({
      room_id: room.id,
      submitter_id: session.userId,
      render_path: renderPath,
      before_path: beforePath,
      item_ids: itemIds,
      item_snapshots: itemSnapshots,
      caption: caption || null,
    })
    .select("id, created_at")
    .maybeSingle();

  if (ins.error || !ins.data) {
    console.error("[rooms] submission insert failed:", ins.error?.message);
    return Response.json({ error: "submit_failed" }, { status: 500 });
  }

  return Response.json({
    ok: true,
    submission: { id: ins.data.id, created_at: ins.data.created_at },
  });
}
