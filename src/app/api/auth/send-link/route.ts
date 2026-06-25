/**
 * Magic-link sender.
 *
 * POST { email } → Supabase Auth sends a one-tap login link to the
 * address with our /auth/callback URL embedded as the redirect. No
 * password handling at any point.
 */

import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { email?: string; returnTo?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const email = body.email?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ error: "Invalid email" }, { status: 400 });
  }
  // Only accept relative paths — protects against open-redirect via
  // the magic link.
  const returnTo =
    typeof body.returnTo === "string" && body.returnTo.startsWith("/")
      ? body.returnTo
      : "/";

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

  // The magic-link URL preserves query string, so the callback receives
  // both ?code= and ?next= and can redirect the user back to wherever
  // they triggered sign-in (the creator page in the paywall flow).
  const callback =
    `${siteUrl}/api/auth/callback?next=${encodeURIComponent(returnTo)}`;

  const supabase = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: callback, shouldCreateUser: true },
  });
  if (error) {
    console.error("[auth] signInWithOtp error:", error.message);
    return Response.json(
      { error: "Could not send magic link" },
      { status: 500 }
    );
  }
  return Response.json({ ok: true });
}
