import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

/**
 * Two-layer middleware.
 *
 *   1) Site-wide HTTP Basic Auth gate. Credentials live in
 *      SITE_AUTH_USER / SITE_AUTH_PASS. When either is missing we
 *      fail open and log — a misconfigured deploy should be obvious,
 *      not silently brick the entire site.
 *
 *   2) Supabase session refresh. Runs on every let-through request
 *      so the page handler reads cookies that are already
 *      revalidated/refreshed. Without this, Supabase Auth's access
 *      token can fall out of sync between the cookie jar and the
 *      JWT signature, and getServerSession() in /[slug]/page.tsx
 *      starts returning null intermittently — the "modal shows
 *      plans for a moment, then reverts to email form" bug.
 *
 * /api/img and /api/webhooks/* are intentionally excluded by the
 * matcher: the image proxy must stay open (browsers serve product
 * photos without cached credentials) and external webhook callers
 * (Stripe today, others later) authenticate via their own signed
 * payload, never with HTTP Basic.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export async function middleware(request: NextRequest) {
  // ---- (1) Basic Auth gate ------------------------------------
  const user = process.env.SITE_AUTH_USER;
  const pass = process.env.SITE_AUTH_PASS;
  const basicAuthConfigured = Boolean(user && pass);

  if (basicAuthConfigured) {
    const header = request.headers.get("authorization");
    let allowed = false;
    if (header) {
      const [scheme, encoded] = header.split(" ");
      if (scheme === "Basic" && encoded) {
        try {
          const decoded = atob(encoded);
          const idx = decoded.indexOf(":");
          if (idx > -1) {
            const u = decoded.slice(0, idx);
            const p = decoded.slice(idx + 1);
            if (u === user && p === pass) allowed = true;
          }
        } catch {
          // Malformed base64 — fall through to 401.
        }
      }
    }
    if (!allowed) {
      return new NextResponse("Authentication required", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Basic realm="askmai"',
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
    }
  } else {
    console.warn(
      "[middleware] SITE_AUTH_USER / SITE_AUTH_PASS not set — failing open"
    );
  }

  // ---- (2) Supabase session refresh ---------------------------
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
    // Match every path EXCEPT the public ones. The negative lookahead
    // runs against the rest of the path after the leading slash.
    "/((?!api/img|api/webhooks|_next/static|_next/image|favicon|icon|apple-icon).*)",
  ],
};
