/**
 * POST /api/profile/age-verify
 *
 * 18+ age gate. Server side enforced, server side computed. The client
 * may show a preview state on its end but the actual gate is THIS
 * route. Once a user is verified the row stamp is kept; the gate is
 * a no-op on subsequent calls (idempotent).
 *
 * Privacy posture: the date of birth is accepted, used for the age
 * comparison, and then dropped. We never write it, never log it, never
 * return it. Only the derived boolean (via age_verified_at timestamp)
 * is stored. This keeps us out of any "what DOB do you have on file"
 * question.
 *
 * Body: { dob: "YYYY-MM-DD" }
 *
 * Returns:
 *   200 { verified: true }                    user is 18+ now, row stamped
 *   200 { verified: false, blocked: true }    user is under 18, no row write
 *   400 { error: "invalid_json" | "invalid_dob" }
 *   401 { error: "not_signed_in" }
 *   500 { error: "store_failed" }
 *
 * Under 18 returns 200 (not 4xx) deliberately. The client uses the
 * boolean to swap UI; an HTTP error code would invite an error toast,
 * which is the wrong tone for "we cannot offer this feature to you."
 */

import { getServerSession } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await getServerSession();
  if (!session) {
    return Response.json({ error: "not_signed_in" }, { status: 401 });
  }

  const admin = supabaseAdmin();

  // Idempotency check first. If the user already has age_verified_at
  // set we skip the DOB step entirely. A repeated prompt during a
  // flaky network round trip is a no-op, not a re-collection event.
  const existing = await admin
    .from("users")
    .select("age_verified_at")
    .eq("id", session.userId)
    .maybeSingle();
  if (existing.error) {
    console.error(
      "[age-verify] read of users.age_verified_at failed:",
      existing.error.message
    );
    return Response.json({ error: "store_failed" }, { status: 500 });
  }
  if (existing.data?.age_verified_at) {
    return Response.json({ verified: true });
  }

  let body: { dob?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const dob = typeof body.dob === "string" ? body.dob.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
    return Response.json({ error: "invalid_dob" }, { status: 400 });
  }

  const parts = dob.split("-").map((s) => Number(s));
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];

  // Reject impossible months/days and pre-1900 / future dates. These
  // catch typos (1029 instead of 2029) and the obvious "bypass with a
  // fake date" attempt.
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    year < 1900 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return Response.json({ error: "invalid_dob" }, { status: 400 });
  }
  const dobDate = new Date(Date.UTC(year, month - 1, day));
  // Round trip check: catches things like Feb 30 that the constructor
  // would silently overflow to March.
  if (
    dobDate.getUTCFullYear() !== year ||
    dobDate.getUTCMonth() !== month - 1 ||
    dobDate.getUTCDate() !== day
  ) {
    return Response.json({ error: "invalid_dob" }, { status: 400 });
  }
  const nowDate = new Date();
  if (dobDate.getTime() > nowDate.getTime()) {
    return Response.json({ error: "invalid_dob" }, { status: 400 });
  }

  // Age computation in years. Adjust for the case where this year's
  // birthday has not yet occurred.
  let age = nowDate.getUTCFullYear() - year;
  const monthDiff = nowDate.getUTCMonth() - (month - 1);
  if (
    monthDiff < 0 ||
    (monthDiff === 0 && nowDate.getUTCDate() < day)
  ) {
    age = age - 1;
  }

  if (age < 18) {
    // Hard block. Write nothing. Do not log the DOB or even the age.
    // The client gets the boolean signal and shows a polite block.
    return Response.json({ verified: false, blocked: true });
  }

  // Verified. Stamp the row. The DOB itself was used only for the
  // comparison and is now out of scope; the timestamp is the only
  // artifact we retain.
  const upd = await admin
    .from("users")
    .update({ age_verified_at: new Date().toISOString() })
    .eq("id", session.userId);
  if (upd.error) {
    console.error("[age-verify] update failed:", upd.error.message);
    return Response.json({ error: "store_failed" }, { status: 500 });
  }

  return Response.json({ verified: true });
}
