/**
 * Image proxy.
 *
 * Defeats retailer/CDN hotlink blocking (which rejects requests whose
 * Referer is our domain instead of theirs) by re-fetching the image
 * server-side, where Node's fetch never sends a Referer header by default.
 *
 * SECURITY: the URL's hostname must be on ALLOWED_HOSTS. This prevents
 * the route from being used as an open SSRF relay against arbitrary
 * internal or external hosts.
 *
 * The endpoint is intentionally permissive on failures — anything that
 * isn't a 200 image response returns a 404, which the client component's
 * onError handler converts into the branded letter tile.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_HOSTS = new Set<string>([
  // ShopMy feed CDNs (kept; some legacy rows may still point here)
  "production-shopmyshelf-pins.s3.us-east-2.amazonaws.com",
  "production-shopmyshelf-uploads.s3.us-east-2.amazonaws.com",
  // Common retailer image CDNs we expect to encounter as feeds expand.
  "static.zara.net",
  "lp2.hm.com",
  "img.mytheresa.com",
  "is4-ssl.mzstatic.com",
  "images.thereformation.com",
  "cdn.aritzia.com",
  "static.zarahome.net",
  "images.ulta.com",
  "www.sephora.com",
  "cdn.shopify.com",
]);

// Bing image-search thumbnails (where the re-ingest script puts feed images).
// All Bing thumbs come from ts0–ts9.mm.bing.net; pinning the pattern lets us
// keep SSRF protection without enumerating every subdomain.
const ALLOWED_HOST_PATTERNS: RegExp[] = [
  /^ts\d+\.(?:mm|explicit)\.bing\.net$/,
];

const ALLOWED_CONTENT_TYPE = /^image\//i;

function hostAllowed(host: string): boolean {
  if (ALLOWED_HOSTS.has(host)) return true;
  return ALLOWED_HOST_PATTERNS.some((re) => re.test(host));
}

const FETCH_HEADERS = {
  // A real-browser UA defeats trivial bot blocks. We do NOT set a Referer,
  // which is the whole point of the proxy — it lets the upstream see a
  // refer-less or same-origin request and skip hotlink rejection.
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const target = url.searchParams.get("url");
  if (!target) {
    return new Response("Missing url", { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return new Response("Invalid url", { status: 400 });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return new Response("Bad protocol", { status: 400 });
  }
  if (!hostAllowed(parsed.hostname)) {
    return new Response(`Host not allowed: ${parsed.hostname}`, {
      status: 400,
    });
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      headers: FETCH_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return new Response("Upstream fetch failed", { status: 404 });
  }

  if (!upstream.ok || !upstream.body) {
    return new Response("Upstream not ok", { status: 404 });
  }

  const contentType = upstream.headers.get("content-type") ?? "image/jpeg";
  if (!ALLOWED_CONTENT_TYPE.test(contentType)) {
    return new Response("Upstream is not an image", { status: 404 });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400, s-maxage=86400",
    },
  });
}
