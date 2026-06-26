/**
 * Magic-link callback.
 *
 * Supabase redirects here with ?code=<otp_code> after the user clicks
 * the email link. We:
 *   1. Exchange the code for a session (sets Supabase auth cookies).
 *   2. Upsert our application-level users row keyed by email.
 *   3. Link the current device's usage_counter to that user_id so the
 *      pre-signup free_uses_count carries forward.
 *   4. Redirect to "/" — Stripe checkout and the paywall modal land
 *      here in the next phase.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabase";
import { DEVICE_COOKIE_NAME } from "@/lib/deviceId";
import { attachCounterToUser } from "@/lib/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const nextParam = request.nextUrl.searchParams.get("next");
  const next =
    nextParam && nextParam.startsWith("/") ? nextParam : "/";
  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL ?? request.nextUrl.origin;

  if (!code) {
    return NextResponse.redirect(`${siteUrl}${next}?auth=missing_code`);
  }

  // Use the canonical Supabase Next.js pattern: write to cookieStore
  // directly. In an App Router Route Handler, cookies set via
  // cookieStore.set() are automatically attached to the returned
  // response (including NextResponse.redirect). The previous code
  // wrote to response.cookies which works in theory but is one step
  // further off the supported path — and the bug report ("unclear
  // whether the session was actually established") suggests session
  // cookies weren't landing on every browser as expected. Aligning
  // with the official adapter is the defensive move.
  const cookieStore = await cookies();
  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(toSet: { name: string; value: string; options: CookieOptions }[]) {
        try {
          for (const c of toSet) {
            cookieStore.set(c.name, c.value, c.options);
          }
        } catch {
          // cookieStore.set throws when called outside a Route
          // Handler / Server Action context. In our context it's
          // legal, but the guard mirrors Supabase's own example
          // and keeps a bad call from killing the redirect.
        }
      },
    },
  });

  const exchange = await supabase.auth.exchangeCodeForSession(code);
  if (exchange.error || !exchange.data.session?.user?.email) {
    console.error(
      "[auth] exchangeCodeForSession failed:",
      exchange.error?.message
    );
    return NextResponse.redirect(`${siteUrl}${next}?auth=exchange_failed`);
  }

  const email = exchange.data.session.user.email.toLowerCase();
  const admin = supabaseAdmin();
  // Insert-then-select-on-conflict so we can tell new signup from a
  // returning user. Only NEW signups can claim a referral; an existing
  // user clicking a magic link with a ?ref param can't retroactively
  // credit themselves to an inviter. This matches the "create an
  // account via an inviter's link" semantics of the referral spec and
  // also makes the callback idempotent — a re-clicked magic link
  // produces isNewUser=false and the claim_referral RPC is skipped.
  let userId: string | null = null;
  let isNewUser = false;
  const ins = await admin
    .from("users")
    .insert({ email })
    .select("id")
    .maybeSingle();
  if (ins.error) {
    // 23505 = unique_violation → user already exists. Look it up.
    if (ins.error.code === "23505") {
      const sel = await admin
        .from("users")
        .select("id")
        .eq("email", email)
        .single();
      if (sel.error || !sel.data) {
        console.error(
          "[auth] users select-after-conflict failed:",
          sel.error?.message
        );
        return NextResponse.redirect(`${siteUrl}/?auth=user_upsert_failed`);
      }
      userId = sel.data.id as string;
    } else {
      console.error("[auth] users insert failed:", ins.error.message);
      return NextResponse.redirect(`${siteUrl}/?auth=user_upsert_failed`);
    }
  } else if (ins.data) {
    userId = ins.data.id as string;
    isNewUser = true;
  }
  if (!userId) {
    return NextResponse.redirect(`${siteUrl}/?auth=user_upsert_failed`);
  }

  // Referral claim: strictly first-signup, validated ref code only.
  // RPC is itself idempotent (only fires if referred_by IS NULL) so a
  // duplicate callback can't double-credit. Pattern check mirrors the
  // send-link and client-side validation; defense in depth.
  if (isNewUser) {
    const rawRef = request.nextUrl.searchParams.get("ref");
    const refCode = rawRef?.trim().toUpperCase();
    if (refCode && /^[2-9A-HJKM-NP-TV-Z]{7}$/.test(refCode)) {
      const claim = await admin.rpc("claim_referral", {
        p_new_user_id: userId,
        p_ref_code: refCode,
      });
      if (claim.error) {
        // Log + continue — a referral failure must never block signup.
        console.error("[auth] claim_referral RPC failed:", claim.error.message);
      }
    }
  }

  const deviceId = cookieStore.get(DEVICE_COOKIE_NAME)?.value;
  if (deviceId) {
    await attachCounterToUser({
      deviceId,
      userId,
    });
  }

  // Cookies set via cookieStore.set() above are auto-attached to
  // this response by Next.js. The redirect lands the user back on
  // the page they triggered sign-in from (?next=) and the next
  // request server-renders with signedIn=true.
  return NextResponse.redirect(`${siteUrl}${next}?auth=ok`);
}
