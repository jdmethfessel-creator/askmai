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
  const upsert = await admin
    .from("users")
    .upsert({ email }, { onConflict: "email" })
    .select("id")
    .single();
  if (upsert.error || !upsert.data) {
    console.error("[auth] users upsert failed:", upsert.error?.message);
    return NextResponse.redirect(`${siteUrl}/?auth=user_upsert_failed`);
  }

  const deviceId = cookieStore.get(DEVICE_COOKIE_NAME)?.value;
  if (deviceId) {
    await attachCounterToUser({
      deviceId,
      userId: upsert.data.id as string,
    });
  }

  // Cookies set via cookieStore.set() above are auto-attached to
  // this response by Next.js. The redirect lands the user back on
  // the page they triggered sign-in from (?next=) and the next
  // request server-renders with signedIn=true.
  return NextResponse.redirect(`${siteUrl}${next}?auth=ok`);
}
