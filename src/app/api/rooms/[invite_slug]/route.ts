/**
 * GET /api/rooms/[invite_slug]
 *
 * Room info for the /room/<invite_slug> landing page. Deliberately
 * PUBLIC: any invite-link holder can see the room's name, creator
 * slug, host id, member roster (id + display name), and whether the
 * current viewer is already a member.
 *
 * What this does NOT return:
 *   - The submissions feed. That's members-only via /feed.
 *   - Any private wardrobe or non-submitted look.
 *
 * Response:
 *   200 {
 *     ok: true,
 *     room: { id, name, creator_slug, host_user_id, invite_slug,
 *             is_archived, created_at },
 *     viewer: { user_id, is_member, role, is_host } | null,
 *     members: [ { user_id, role, joined_at, display_name } ]
 *   }
 *   404 { error: "not_found" }
 */

import { getServerSession } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";
import { loadRoomBySlug, loadActiveMembership } from "@/lib/rooms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { invite_slug: string };

export async function GET(_request: Request, ctx: { params: Params }) {
  const room = await loadRoomBySlug(ctx.params.invite_slug);
  if (!room) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const admin = supabaseAdmin();

  const roster = await admin
    .from("fitting_room_members")
    .select("user_id, role, joined_at")
    .eq("room_id", room.id)
    .is("removed_at", null)
    .order("joined_at", { ascending: true });

  const memberRows =
    (roster.data as Array<{ user_id: string; role: string; joined_at: string }> | null) ?? [];

  const userIds = memberRows.map((m) => m.user_id);
  const nameMap = new Map<string, string>();
  if (userIds.length > 0) {
    const users = await admin
      .from("users")
      .select("id, email")
      .in("id", userIds);
    for (const row of (users.data as Array<{ id: string; email: string }> | null) ?? []) {
      // Display name = local part of the email up to the "+" or "@".
      // Room chrome shows something human without leaking full emails.
      const email = row.email ?? "";
      const at = email.indexOf("@");
      const local = at > 0 ? email.slice(0, at) : email;
      const plus = local.indexOf("+");
      const clean = plus > 0 ? local.slice(0, plus) : local;
      nameMap.set(row.id, clean || "member");
    }
  }

  const session = await getServerSession();
  let viewer: {
    user_id: string;
    is_member: boolean;
    role: "host" | "member" | null;
    is_host: boolean;
  } | null = null;
  if (session) {
    const membership = await loadActiveMembership(room.id, session.userId);
    viewer = {
      user_id: session.userId,
      is_member: Boolean(membership),
      role: membership ? membership.role : null,
      is_host: room.host_user_id === session.userId,
    };
  }

  return Response.json({
    ok: true,
    room,
    viewer,
    members: memberRows.map((m) => ({
      user_id: m.user_id,
      role: m.role,
      joined_at: m.joined_at,
      display_name: nameMap.get(m.user_id) ?? "member",
    })),
  });
}
