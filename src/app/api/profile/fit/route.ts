/**
 * GET  /api/profile/fit -- current caller's fit profile
 * POST /api/profile/fit -- update fit profile (partial, whitelisted)
 *
 * Hard privacy: both routes are scoped to the caller only. No other
 * user can read another user's fit fields via this route. Feed reads
 * on /room/[slug] never surface these columns; the recommendation
 * engine consumes them internally and only ever outputs a size
 * label + rationale.
 *
 * POST body (all fields optional):
 *   {
 *     height?: string | number,  // "5'4" or 163 or "163cm"
 *     weight?: string | number | null,
 *     usual_top?: string | null,
 *     usual_bottom?: string | null,
 *     usual_dress?: string | null,
 *     anchor_brand?: string | null,
 *     preference?: "fitted" | "true" | "relaxed" | null,
 *     dismiss_prompt?: boolean   // records that the dialog was seen
 *   }
 *
 * Passing null to a field explicitly clears it. Omitted fields are
 * left untouched.
 *
 * Response:
 *   200 { ok: true, profile: UserFitProfile }
 *   400 { error: "invalid_request" | "invalid_field" }
 *   401 { error: "not_signed_in" }
 *   500 { error: "store_failed" }
 */

import { getServerSession } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";
import {
  loadUserFitProfile,
  normalizeAnchorBrandInput,
  normalizePreferenceInput,
  normalizeSizeInput,
  parseHeightInput,
  parseWeightInput,
} from "@/lib/fit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession();
  if (!session) {
    return Response.json({ error: "not_signed_in" }, { status: 401 });
  }
  const profile = await loadUserFitProfile(session.userId);
  return Response.json({ ok: true, profile });
}

type Body = {
  height?: unknown;
  weight?: unknown;
  usual_top?: unknown;
  usual_bottom?: unknown;
  usual_dress?: unknown;
  anchor_brand?: unknown;
  preference?: unknown;
  dismiss_prompt?: unknown;
};

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

  const patch: Record<string, unknown> = {};
  const now = new Date().toISOString();

  if (body.height !== undefined) {
    if (body.height === null) {
      patch.fit_height_cm = null;
    } else {
      const cm = parseHeightInput(body.height);
      if (cm == null) {
        return Response.json({ error: "invalid_field" }, { status: 400 });
      }
      patch.fit_height_cm = cm;
    }
  }

  if (body.weight !== undefined) {
    if (body.weight === null || body.weight === "") {
      patch.fit_weight_kg = null;
    } else {
      const kg = parseWeightInput(body.weight);
      if (kg == null) {
        return Response.json({ error: "invalid_field" }, { status: 400 });
      }
      patch.fit_weight_kg = kg;
    }
  }

  if (body.usual_top !== undefined) {
    patch.fit_usual_top =
      body.usual_top === null ? null : normalizeSizeInput(body.usual_top);
  }
  if (body.usual_bottom !== undefined) {
    patch.fit_usual_bottom =
      body.usual_bottom === null
        ? null
        : normalizeSizeInput(body.usual_bottom);
  }
  if (body.usual_dress !== undefined) {
    patch.fit_usual_dress =
      body.usual_dress === null
        ? null
        : normalizeSizeInput(body.usual_dress);
  }
  if (body.anchor_brand !== undefined) {
    patch.fit_anchor_brand =
      body.anchor_brand === null
        ? null
        : normalizeAnchorBrandInput(body.anchor_brand);
  }
  if (body.preference !== undefined) {
    if (body.preference === null) {
      patch.fit_preference = null;
    } else {
      const p = normalizePreferenceInput(body.preference);
      if (p == null) {
        return Response.json({ error: "invalid_field" }, { status: 400 });
      }
      patch.fit_preference = p;
    }
  }

  if (body.dismiss_prompt === true) {
    patch.fit_profile_prompted_at = now;
  }

  // If any real field was set, stamp updated_at.
  const anyField = Object.keys(patch).some(
    (k) => k !== "fit_profile_prompted_at"
  );
  if (anyField) {
    patch.fit_profile_updated_at = now;
  }

  if (Object.keys(patch).length === 0) {
    // No-op POST. Still return the current profile so the client
    // stays in sync.
    const profile = await loadUserFitProfile(session.userId);
    return Response.json({ ok: true, profile });
  }

  const admin = supabaseAdmin();
  const upd = await admin.from("users").update(patch).eq("id", session.userId);
  if (upd.error) {
    console.error("[profile-fit] update failed:", upd.error.message);
    return Response.json({ error: "store_failed" }, { status: 500 });
  }

  const profile = await loadUserFitProfile(session.userId);
  return Response.json({ ok: true, profile });
}
