/**
 * POST /api/profile/update
 *
 * Updates the editable profile fields. For Phase 1 this is just
 * display_name. Returns 200 + ok on success. Always 200 here, never
 * a 204; the client uses the body to swap state.
 *
 * Body: { display_name: string }    1-80 chars, trimmed
 *
 * Returns:
 *   200 { ok: true, display_name: "<trimmed value>" }
 *   400 { error: "invalid_json" | "invalid_display_name" }
 *   401 { error: "not_signed_in" }
 *   500 { error: "store_failed" }
 */

import { getServerSession } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_DISPLAY_NAME = 80;

export async function POST(request: Request) {
  const session = await getServerSession();
  if (!session) {
    return Response.json({ error: "not_signed_in" }, { status: 401 });
  }

  let body: { display_name?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const raw = typeof body.display_name === "string" ? body.display_name : "";
  const displayName = raw.trim();
  if (displayName.length === 0 || displayName.length > MAX_DISPLAY_NAME) {
    return Response.json({ error: "invalid_display_name" }, { status: 400 });
  }

  const admin = supabaseAdmin();
  const upd = await admin
    .from("users")
    .update({ display_name: displayName })
    .eq("id", session.userId);
  if (upd.error) {
    console.error("[profile-update] users update failed:", upd.error.message);
    return Response.json({ error: "store_failed" }, { status: 500 });
  }

  return Response.json({ ok: true, display_name: displayName });
}
