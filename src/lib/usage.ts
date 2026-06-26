/**
 * Cap-gate wrapper around the check_and_increment_usage RPC.
 *
 * Single atomic round-trip per chat request: enforces FREE_LIMIT,
 * increments the counter when allowed, returns the post-increment
 * count. Subscribed users short-circuit on the skip flag and never
 * touch the counter.
 */

import { supabaseAdmin } from "./supabase";

export type GateResult = {
  allowed: boolean;
  used: number;
  limit: number;
};

export function freeLimit(): number {
  const raw = process.env.FREE_LIMIT;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 3;
}

export async function checkAndIncrementUsage(args: {
  deviceId: string;
  fingerprint: string;
  userId: string | null;
  isSubscribed: boolean;
}): Promise<GateResult> {
  const limit = freeLimit();
  const sb = supabaseAdmin();
  const { data, error } = await sb.rpc("check_and_increment_usage", {
    p_device_id: args.deviceId,
    p_fingerprint: args.fingerprint,
    p_user_id: args.userId,
    p_limit: limit,
    p_skip: args.isSubscribed,
  });
  if (error) {
    // Fail open in dev when the migration hasn't been applied. Logs
    // loud so a missing function in prod is obvious, but never blocks
    // a chat over an infrastructure hiccup.
    console.error(
      "[usage] check_and_increment_usage RPC failed:",
      error.message
    );
    return { allowed: true, used: 0, limit };
  }
  // The RPC returns a setof row; supabase-js gives us an array.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    console.error("[usage] empty response from check_and_increment_usage");
    return { allowed: true, used: 0, limit };
  }
  return {
    allowed: Boolean(row.allowed),
    used: Number(row.used ?? 0),
    limit,
  };
}

/**
 * Cookie-recovery lookup. Returns the device_id of a previous counter
 * row whose fingerprint matches, so a cookie-clear doesn't yield a
 * fresh quota.
 */
export async function findCounterByFingerprint(
  fingerprint: string
): Promise<{ device_id: string } | null> {
  if (!fingerprint) return null;
  const sb = supabaseAdmin();
  const { data, error } = await sb.rpc("find_counter_by_fingerprint", {
    p_fingerprint: fingerprint,
  });
  if (error || !data) return null;
  // Function returns a single usage_counters row (or null).
  return { device_id: (data as { device_id: string }).device_id };
}

/**
 * Called from the auth callback after the magic-link OTP is verified.
 * Stamps the device counter with the new user_id, carrying forward
 * the pre-signup free_uses_count.
 */
export async function attachCounterToUser(args: {
  deviceId: string;
  userId: string;
}): Promise<void> {
  const sb = supabaseAdmin();
  const { error } = await sb.rpc("attach_counter_to_user", {
    p_device_id: args.deviceId,
    p_user_id: args.userId,
  });
  if (error) {
    console.error("[usage] attach_counter_to_user RPC failed:", error.message);
  }
}

/**
 * Atomic decrement of users.bonus_questions. Called from the chat route
 * when the per-device cap is exhausted AND the requester has a
 * signed-in session — gives the user one extra chat per consumed bonus,
 * independent of which device they're on. RPC returns true iff the
 * decrement actually happened (bonus_questions > 0 before the call).
 *
 * Failing open if the RPC errors keeps the existing FREE_LIMIT behavior
 * intact under infrastructure hiccups: a missing RPC or transient DB
 * blip won't let a free user past the cap unexpectedly, because the
 * caller only invokes this AFTER checkAndIncrementUsage has already
 * denied — a false return here just falls through to the existing 402.
 */
export async function consumeBonusQuestion(
  userId: string
): Promise<boolean> {
  if (!userId) return false;
  const sb = supabaseAdmin();
  const { data, error } = await sb.rpc("consume_bonus_question", {
    p_user_id: userId,
  });
  if (error) {
    console.error("[usage] consume_bonus_question RPC failed:", error.message);
    return false;
  }
  return Boolean(data);
}
