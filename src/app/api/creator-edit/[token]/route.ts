/**
 * GET  /api/creator-edit/[token]
 * PUT  /api/creator-edit/[token]
 *
 * Tokenized self-serve edit endpoint for a creator's voice_prompt
 * and taste_profile. The token is the creators.edit_token UUID
 * (migration 011) -- whoever holds it can read + write the
 * creator's two voice fields. The completion email sends the
 * token URL to the creator's email so only they have it.
 *
 * Concept-test stage: no rate-limit, no audit log on writes. If
 * this graduates to "creators paying for the platform" we'd add
 * a creator login + replace the token with a session.
 *
 * GET response: { ok, slug, name, voice_prompt, taste_profile }.
 * Used by the edit page to hydrate the form.
 *
 * PUT body: { voice_prompt: string, taste_profile: object }.
 * Both required; the validator enforces voice_prompt is a
 * non-empty string and taste_profile is an object with an
 * identity.name -- matching the safeguard the onboarding voice
 * generator enforces (safeguard c) so the Ask chat never reads
 * a malformed taste_profile.
 */

import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  if (!isUuid(token)) {
    return Response.json({ error: "invalid_token" }, { status: 400 });
  }
  const sb = supabaseAdmin();
  const row = await sb
    .from("creators")
    .select("id, slug, name, voice_prompt, taste_profile")
    .eq("edit_token", token)
    .maybeSingle();
  if (row.error || !row.data) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  return Response.json({
    ok: true,
    slug: row.data.slug,
    name: row.data.name,
    voice_prompt: row.data.voice_prompt ?? "",
    taste_profile: row.data.taste_profile ?? {},
  });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  if (!isUuid(token)) {
    return Response.json({ error: "invalid_token" }, { status: 400 });
  }
  let body: { voice_prompt?: unknown; taste_profile?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof body.voice_prompt !== "string" || body.voice_prompt.trim().length < 50) {
    return Response.json(
      { error: "voice_prompt_too_short" },
      { status: 400 }
    );
  }
  if (
    !body.taste_profile ||
    typeof body.taste_profile !== "object" ||
    Array.isArray(body.taste_profile)
  ) {
    return Response.json(
      { error: "taste_profile_not_object" },
      { status: 400 }
    );
  }
  const taste = body.taste_profile as Record<string, unknown>;
  if (
    !taste.identity ||
    typeof taste.identity !== "object" ||
    typeof (taste.identity as Record<string, unknown>).name !== "string"
  ) {
    return Response.json(
      { error: "taste_profile_identity_name_missing" },
      { status: 400 }
    );
  }

  const sb = supabaseAdmin();
  const update = await sb
    .from("creators")
    .update({
      voice_prompt: body.voice_prompt,
      taste_profile: body.taste_profile,
    })
    .eq("edit_token", token)
    .select("slug")
    .single();
  if (update.error || !update.data) {
    console.error(
      "[creator-edit] update failed:",
      update.error?.message
    );
    return Response.json({ error: "update_failed" }, { status: 500 });
  }
  return Response.json({ ok: true, slug: update.data.slug });
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
