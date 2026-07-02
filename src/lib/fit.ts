/**
 * Fit profile server helpers. Central place for reading + validating
 * the user's optional fit inputs so both /api/profile/fit and the
 * recommendation engine (src/lib/fitRec.ts, P1c) share one policy.
 *
 * Hard privacy rule enforced here: the user-facing profile row is
 * NEVER surfaced through a route that another user can read. Only
 * the caller reads their own via /api/profile/fit GET; the engine
 * consumes it internally and outputs a size + rationale, never the
 * inputs.
 */

import { supabaseAdmin } from "./supabase";

export type FitPreference = "fitted" | "true" | "relaxed";

export type UserFitProfile = {
  height_cm: number | null;
  weight_kg: number | null;
  usual_top: string | null;
  usual_bottom: string | null;
  usual_dress: string | null;
  anchor_brand: string | null;
  preference: FitPreference | null;
  prompted_at: string | null;
  updated_at: string | null;
};

export const FIT_HEIGHT_MIN_CM = 120;
export const FIT_HEIGHT_MAX_CM = 220;
export const FIT_WEIGHT_MIN_KG = 30;
export const FIT_WEIGHT_MAX_KG = 250;
export const FIT_ANCHOR_MAX_LEN = 60;
export const FIT_SIZE_MAX_LEN = 16;

// Height accepts either a raw number in cm or an imperial string like
// "5'4" or "5' 4". Returns cm as an integer or null. Rejects anything
// outside sanity bounds so the DB CHECK doesn't have to.
export function parseHeightInput(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const cm = Math.round(raw);
    if (cm < FIT_HEIGHT_MIN_CM || cm > FIT_HEIGHT_MAX_CM) return null;
    return cm;
  }
  const s = String(raw).trim();
  const imp = s.match(/^(\d)['’]\s*(\d{1,2})/);
  if (imp) {
    const ft = Number(imp[1]);
    const inches = Number(imp[2]);
    const cm = Math.round((ft * 12 + inches) * 2.54);
    if (cm < FIT_HEIGHT_MIN_CM || cm > FIT_HEIGHT_MAX_CM) return null;
    return cm;
  }
  const cmMatch = s.match(/^(\d{2,3})(?:\s*cm)?$/i);
  if (cmMatch) {
    const cm = Number(cmMatch[1]);
    if (cm < FIT_HEIGHT_MIN_CM || cm > FIT_HEIGHT_MAX_CM) return null;
    return cm;
  }
  return null;
}

export function parseWeightInput(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const n =
    typeof raw === "number"
      ? raw
      : Number(String(raw).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n)) return null;
  if (n < FIT_WEIGHT_MIN_KG || n > FIT_WEIGHT_MAX_KG) return null;
  return Math.round(n * 100) / 100;
}

export function normalizeSizeInput(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toUpperCase().slice(0, FIT_SIZE_MAX_LEN);
  return s || null;
}

export function normalizeAnchorBrandInput(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().slice(0, FIT_ANCHOR_MAX_LEN);
  return s || null;
}

export function normalizePreferenceInput(raw: unknown): FitPreference | null {
  if (raw !== "fitted" && raw !== "true" && raw !== "relaxed") return null;
  return raw;
}

export async function loadUserFitProfile(
  userId: string
): Promise<UserFitProfile | null> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("users")
    .select(
      "fit_height_cm, fit_weight_kg, fit_usual_top, fit_usual_bottom, fit_usual_dress, fit_anchor_brand, fit_preference, fit_profile_prompted_at, fit_profile_updated_at"
    )
    .eq("id", userId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    height_cm: (data.fit_height_cm as number | null) ?? null,
    weight_kg:
      data.fit_weight_kg == null ? null : Number(data.fit_weight_kg),
    usual_top: (data.fit_usual_top as string | null) ?? null,
    usual_bottom: (data.fit_usual_bottom as string | null) ?? null,
    usual_dress: (data.fit_usual_dress as string | null) ?? null,
    anchor_brand: (data.fit_anchor_brand as string | null) ?? null,
    preference: (data.fit_preference as FitPreference | null) ?? null,
    prompted_at:
      (data.fit_profile_prompted_at as string | null) ?? null,
    updated_at: (data.fit_profile_updated_at as string | null) ?? null,
  };
}
