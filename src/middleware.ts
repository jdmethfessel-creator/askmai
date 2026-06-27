import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

/**
 * Supabase session refresh middleware.
 *
 * Runs on every page request that isn't on the matcher exclusion list,
 * and asks Supabase to refresh the auth token cookies. Without this,
 * Supabase Auth's access token can fall out of sync between the cookie
 * jar and the JWT signature, and getServerSession() in /[slug]/page.tsx
 * starts returning null intermittently — the "modal shows plans for a
 * moment, then reverts to email form" bug.
 *
 * Was previously a two-layer middleware that also enforced site-wide
 * HTTP Basic Auth via SITE_AUTH_USER / SITE_AUTH_PASS. That gate has
 * been removed per direction — the site now loads fully open. The
 * env vars are no longer read by anything; leaving them set or
 * unset has no effect. Safe to delete from Vercel later.
 *
 * The matcher exclusions are kept as a no-op-cost performance
 * optimization: static assets and webhook endpoints don't need a
 * Supabase session refresh round-trip on every request.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export async function middleware(request: NextRequest) {
  // No-op if Supabase isn't configured — keeps things resilient if
  // an env var hasn't been wired yet.
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return NextResponse.next({ request });
  }

  // Per Supabase's canonical Next.js middleware pattern: we keep a
  // mutable supabaseResponse so refreshed cookies land on BOTH the
  // request (so the downstream page handler reads them fresh) and
  // the outgoing response (so the browser persists them). The
  // `request` object's cookies are mutable in middleware.
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(
        cookiesToSet: {
          name: string;
          value: string;
          options: CookieOptions;
        }[]
      ) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        // Reissue the response so subsequent set() calls land on the
        // current response object, then copy each refreshed cookie
        // through to the browser.
        supabaseResponse = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          supabaseResponse.cookies.set(name, value, options);
        }
      },
    },
  });

  // Triggers token refresh when needed. Result is intentionally
  // ignored — we don't gate based on auth state here, only sync
  // cookies.
  await supabase.auth.getUser();

  return supabaseResponse;
}

export const config = {
  matcher: [
    // Match every path EXCEPT the static / webhook ones. The
    // exclusions are a perf optimization now (no point doing a
    // Supabase session refresh round-trip on a webhook callback or
    // an image asset); they no longer guard auth, because there's
    // no site-wide auth gate any more.
    "/((?!api/img|api/webhooks|_next/static|_next/image|favicon|icon|apple-icon|forcreators|demo|og).*)",
  ],
};
