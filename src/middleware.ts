import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Site-wide HTTP Basic Auth gate.
 *
 * Credentials live in SITE_AUTH_USER / SITE_AUTH_PASS. When either is
 * missing we fail open and log — a misconfigured deploy should be
 * obvious, not silently brick the entire site.
 *
 * /api/img stays public so product/avatar images keep loading without
 * cached browser credentials; _next/static, _next/image, and the
 * favicon/icon routes are framework assets that shouldn't sit behind
 * auth either. Everything else (pages, /api/chat, /api/product-image)
 * requires Basic Auth.
 */
export function middleware(request: NextRequest) {
  const user = process.env.SITE_AUTH_USER;
  const pass = process.env.SITE_AUTH_PASS;
  if (!user || !pass) {
    console.warn(
      "[middleware] SITE_AUTH_USER / SITE_AUTH_PASS not set — failing open"
    );
    return NextResponse.next();
  }

  const header = request.headers.get("authorization");
  if (header) {
    const [scheme, encoded] = header.split(" ");
    if (scheme === "Basic" && encoded) {
      try {
        const decoded = atob(encoded);
        const idx = decoded.indexOf(":");
        if (idx > -1) {
          const u = decoded.slice(0, idx);
          const p = decoded.slice(idx + 1);
          if (u === user && p === pass) {
            return NextResponse.next();
          }
        }
      } catch {
        // Malformed base64 — fall through to 401.
      }
    }
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="askmai"',
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

export const config = {
  matcher: [
    // Match every path EXCEPT the public ones. The negative lookahead
    // runs against the rest of the path after the leading slash.
    "/((?!api/img|_next/static|_next/image|favicon|icon|apple-icon).*)",
  ],
};
