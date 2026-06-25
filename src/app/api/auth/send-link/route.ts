/**
 * Magic-link sender.
 *
 * POST { email, returnTo } → Supabase Auth sends a one-tap login
 * link to the address. The callback URL (/api/auth/callback) is
 * embedded as the redirect_to so the user lands back on this app
 * after clicking. No password handling at any point.
 *
 *   Critical: this route MUST use @supabase/ssr's createServerClient
 *   with a writable cookie adapter — NOT createClient from
 *   @supabase/supabase-js. Reason: Supabase's auth SDK uses the PKCE
 *   flow by default, which means signInWithOtp generates a
 *   code-verifier here on the server and must persist it to the
 *   browser as a cookie. When the user later clicks the email link,
 *   the /api/auth/callback route's exchangeCodeForSession() reads
 *   that same verifier cookie back from the browser to complete the
 *   handshake.
 *
 *   The previous implementation used @supabase/supabase-js's
 *   createClient with persistSession:false, which has NO cookie
 *   adapter — the verifier was generated in-memory only and never
 *   reached the browser. The callback's exchange would then either
 *   fail or succeed in a degraded way that produced auth-token
 *   cookies the next getUser() didn't trust. Symptom: modal showed
 *   plan options for a flash, then reverted to the sign-in form on
 *   the next page render.
 */

import { cookies } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

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

  // Prefer the explicit env var, otherwise fall back to the request's
  // own origin. On Vercel the origin is https://askmai.co for prod
  // traffic; in dev it's http://localhost:3000.
  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL ?? new URL(request.url).origin;

  if (
    /^https?:\/\/localhost/i.test(siteUrl) &&
    !/^https?:\/\/localhost/i.test(new URL(request.url).origin)
  ) {
    console.error(
      `[auth] siteUrl resolved to ${siteUrl} on a non-localhost request — ` +
        `NEXT_PUBLIC_SITE_URL is probably misset on this deploy.`
    );
  }

  const callback =
    `${siteUrl}/api/auth/callback?next=${encodeURIComponent(returnTo)}`;

  // SSR client with writable cookie adapter. The PKCE verifier
  // cookie that signInWithOtp wants to store lands on the response
  // headers here and the browser holds it until the callback
  // request, at which point exchangeCodeForSession reads it back.
  const cookieStore = await cookies();
  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(
        toSet: { name: string; value: string; options: CookieOptions }[]
      ) {
        try {
          for (const c of toSet) {
            cookieStore.set(c.name, c.value, c.options);
          }
        } catch {
          // cookieStore.set throws if called outside an App Router
          // Route Handler / Server Action context. We're inside one
          // here, but the guard mirrors Supabase's example and keeps
          // a bad call from killing the request.
        }
      },
    },
  });

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: callback, shouldCreateUser: true },
  });

  if (error) {
    console.error("[auth] signInWithOtp error:", error.message);
    // Supabase's built-in email provider rate-limits to 2 emails/hour
    // per project. After switching Auth → Email to a real SMTP
    // provider (e.g. Resend), the cap rises to 30/hour by default and
    // is configurable. Surface that signal as a 429 so the client can
    // show a friendlier message instead of the generic "could not
    // send" wording.
    const isRateLimited =
      /rate.?limit|too many|429/i.test(error.message);
    return Response.json(
      {
        error: isRateLimited
          ? "Too many sign-in emails for this address right now. Try again in a minute."
          : "Could not send magic link",
      },
      { status: isRateLimited ? 429 : 500 }
    );
  }

  return Response.json({ ok: true });
}
