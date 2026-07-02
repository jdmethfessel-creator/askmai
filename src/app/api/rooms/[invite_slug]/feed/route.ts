/**
 * GET /api/rooms/[invite_slug]/feed
 *
 * The members-only submissions feed. Non-members get a hard 403 with
 * no leaked shape whatsoever, because non-membership is the load-
 * bearing privacy boundary.
 *
 * Returns everything a member needs to render the room in one shot:
 *   - submissions (with resigned render + before URLs, per-viewer
 *     reaction state, and item snapshots)
 *   - reaction counts + the viewer's own kinds
 *   - top-level comments per submission (first page)
 *
 * Signed URLs use a short TTL (10 minutes; see FEED_URL_TTL_SECONDS
 * in lib/rooms.ts) so a link exfiltrated from the wire expires quickly.
 *
 * Response:
 *   200 { ok: true, submissions: [...] }
 *   401 { error: "not_signed_in" }
 *   403 { error: "not_a_member" }
 *   404 { error: "not_found" }
 *   410 { error: "archived" }
 */

import { getServerSession } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";
import {
  COMMENTS_PAGE,
  SUBMISSIONS_PAGE,
  loadActiveMembership,
  loadRoomBySlug,
  signBeforePath,
  signRenderPath,
} from "@/lib/rooms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { invite_slug: string };

type SubmissionRow = {
  id: string;
  submitter_id: string;
  render_path: string | null;
  before_path: string | null;
  item_snapshots: unknown;
  caption: string | null;
  created_at: string;
};

type ReactionRow = {
  submission_id: string;
  user_id: string;
  kind: string;
};

type CommentRow = {
  id: string;
  submission_id: string;
  user_id: string;
  parent_id: string | null;
  body: string;
  created_at: string;
};

export async function GET(_request: Request, ctx: { params: Params }) {
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

  const admin = supabaseAdmin();

  const subs = await admin
    .from("fitting_room_submissions")
    .select(
      "id, submitter_id, render_path, before_path, item_snapshots, caption, created_at"
    )
    .eq("room_id", room.id)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(SUBMISSIONS_PAGE);

  if (subs.error) {
    console.error("[rooms] feed submissions failed:", subs.error.message);
    return Response.json({ error: "feed_failed" }, { status: 500 });
  }

  const submissions = (subs.data as SubmissionRow[] | null) ?? [];
  const submissionIds = submissions.map((s) => s.id);

  const reactionsBySub = new Map<string, Array<{ user_id: string; kind: string }>>();
  const commentsBySub = new Map<string, CommentRow[]>();
  const submitterIds = new Set(submissions.map((s) => s.submitter_id));

  if (submissionIds.length > 0) {
    const [rxRes, cmRes] = await Promise.all([
      admin
        .from("fitting_room_reactions")
        .select("submission_id, user_id, kind")
        .in("submission_id", submissionIds),
      admin
        .from("fitting_room_comments")
        .select("id, submission_id, user_id, parent_id, body, created_at")
        .in("submission_id", submissionIds)
        .is("deleted_at", null)
        .order("created_at", { ascending: true })
        .limit(COMMENTS_PAGE),
    ]);

    for (const r of (rxRes.data as ReactionRow[] | null) ?? []) {
      const bucket = reactionsBySub.get(r.submission_id) ?? [];
      bucket.push({ user_id: r.user_id, kind: r.kind });
      reactionsBySub.set(r.submission_id, bucket);
    }

    for (const c of (cmRes.data as CommentRow[] | null) ?? []) {
      const bucket = commentsBySub.get(c.submission_id) ?? [];
      bucket.push(c);
      commentsBySub.set(c.submission_id, bucket);
      submitterIds.add(c.user_id);
    }
  }

  // Resolve display names for every user id we're about to hand back
  // (submitters + commenters). Same local-part-of-email rule the info
  // route uses, so member handles stay consistent across surfaces.
  const nameMap = new Map<string, string>();
  if (submitterIds.size > 0) {
    const usr = await admin
      .from("users")
      .select("id, email")
      .in("id", Array.from(submitterIds));
    for (const row of (usr.data as Array<{ id: string; email: string }> | null) ?? []) {
      const email = row.email ?? "";
      const at = email.indexOf("@");
      const local = at > 0 ? email.slice(0, at) : email;
      const plus = local.indexOf("+");
      nameMap.set(row.id, (plus > 0 ? local.slice(0, plus) : local) || "member");
    }
  }

  // Resign paths per-viewer. We fire the sign requests concurrently so
  // a 50-submission feed doesn't turn into 100 sequential storage RPCs.
  const signed = await Promise.all(
    submissions.map(async (s) => ({
      id: s.id,
      renderUrl: s.render_path ? await signRenderPath(s.render_path) : null,
      beforeUrl: s.before_path ? await signBeforePath(s.before_path) : null,
    }))
  );
  const signedById = new Map(signed.map((x) => [x.id, x]));

  const viewerId = session.userId;

  const payload = submissions.map((s) => {
    const rxs = reactionsBySub.get(s.id) ?? [];
    const counts: Record<string, number> = {};
    const viewerKinds: string[] = [];
    for (const r of rxs) {
      counts[r.kind] = (counts[r.kind] ?? 0) + 1;
      if (r.user_id === viewerId) viewerKinds.push(r.kind);
    }
    const comments = (commentsBySub.get(s.id) ?? []).map((c) => ({
      id: c.id,
      user_id: c.user_id,
      display_name: nameMap.get(c.user_id) ?? "member",
      parent_id: c.parent_id,
      body: c.body,
      created_at: c.created_at,
    }));
    const urls = signedById.get(s.id);
    return {
      id: s.id,
      submitter_id: s.submitter_id,
      submitter_display_name: nameMap.get(s.submitter_id) ?? "member",
      render_url: urls?.renderUrl ?? null,
      before_url: urls?.beforeUrl ?? null,
      item_snapshots: Array.isArray(s.item_snapshots) ? s.item_snapshots : [],
      caption: s.caption,
      created_at: s.created_at,
      reaction_counts: counts,
      viewer_reaction_kinds: viewerKinds,
      comments,
    };
  });

  return Response.json({ ok: true, submissions: payload });
}
