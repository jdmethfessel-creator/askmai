/**
 * POST /api/rooms
 *
 * Create a Shared Fitting Room. The caller becomes the host member
 * automatically. Returns the invite_slug so the client can route to
 * /room/[invite_slug] and share the link.
 *
 * Body:
 *   { name: string, creatorSlug: string }
 *
 * Response:
 *   200 { ok: true, invite_slug, id, name, creator_slug }
 *   400 { error: "invalid_request" | "invalid_creator" | "invalid_name" }
 *   401 { error: "not_signed_in" }
 *   500 { error: "create_failed" }
 */

import { getServerSession } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";
import { generateInviteSlug, ROOM_NAME_MAX } from "@/lib/rooms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { name?: string; creatorSlug?: string };

export async function POST(request: Request) {
  const session = await getServerSession();
  if (!session) {
    return Response.json({ error: "not_signed_in" }, { status: 401 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > ROOM_NAME_MAX) {
    return Response.json({ error: "invalid_name" }, { status: 400 });
  }

  const creatorSlug =
    typeof body.creatorSlug === "string"
      ? body.creatorSlug.trim().toLowerCase().slice(0, 64)
      : "";
  if (!creatorSlug) {
    return Response.json({ error: "invalid_creator" }, { status: 400 });
  }

  const admin = supabaseAdmin();

  // Verify the creator exists so we don't strand rooms against unknown
  // slugs. A 400 here reads as a user error (bad share URL); silent
  // insertion would leave a dead room.
  const creator = await admin
    .from("creators")
    .select("slug")
    .eq("slug", creatorSlug)
    .maybeSingle();
  if (creator.error || !creator.data) {
    return Response.json({ error: "invalid_creator" }, { status: 400 });
  }

  // Retry on the (astronomically unlikely) invite_slug collision so a
  // duplicate never bubbles up as a 500 to the user.
  for (let attempt = 0; attempt < 5; attempt++) {
    const invite = generateInviteSlug();
    const ins = await admin
      .from("fitting_rooms")
      .insert({
        name,
        creator_slug: creatorSlug,
        host_user_id: session.userId,
        invite_slug: invite,
      })
      .select("id, name, creator_slug, invite_slug")
      .maybeSingle();
    if (ins.error) {
      // 23505 = unique_violation. Retry with a fresh slug.
      if ((ins.error as { code?: string }).code === "23505") continue;
      console.error("[rooms] create failed:", ins.error.message);
      return Response.json({ error: "create_failed" }, { status: 500 });
    }
    if (!ins.data) {
      return Response.json({ error: "create_failed" }, { status: 500 });
    }

    // Enroll the creator as host. Failure here is a leak (we have a
    // room without its host member) so we bail loud.
    const enroll = await admin.from("fitting_room_members").insert({
      room_id: ins.data.id,
      user_id: session.userId,
      role: "host",
    });
    if (enroll.error) {
      console.error(
        "[rooms] host enroll failed for room",
        ins.data.id,
        ":",
        enroll.error.message
      );
      return Response.json({ error: "create_failed" }, { status: 500 });
    }

    return Response.json({
      ok: true,
      id: ins.data.id,
      name: ins.data.name,
      creator_slug: ins.data.creator_slug,
      invite_slug: ins.data.invite_slug,
    });
  }

  return Response.json({ error: "create_failed" }, { status: 500 });
}
