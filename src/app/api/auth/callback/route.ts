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

  const cookieStore = await cookies();
  const response = NextResponse.redirect(`${siteUrl}${next}?auth=ok`);
  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(toSet: { name: string; value: string; options: CookieOptions }[]) {
        for (const c of toSet) response.cookies.set(c.name, c.value, c.options);
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

  return response;
}
