/**
 * Bing image search → first-thumb URL on the allowlisted Bing CDN.
 *
 * Shared by /api/product-image (client lazy lookup) and the chat route
 * (server-side pre-resolution for aggregator items whose Serper hit had
 * no image). One module → one cache → repeat queries stay warm across
 * both callsites.
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const BING_THUMB_HOST_RE = /^ts\d+\.(?:mm|explicit)\.bing\.net$/;

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
type CacheEntry = { url: string | null; expiresAt: number };
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<string | null>>();

async function bingFirstThumb(query: string): Promise<string | null> {
  const url = `https://www.bing.com/images/search?q=${encodeURIComponent(
    query
  )}&form=HDRSC2&first=1`;
  let html: string;
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return null;
    html = await r.text();
  } catch {
    return null;
  }

  const iuscMatches = html.match(/class="iusc"[^>]*m="([^"]+)"/g);
  if (!iuscMatches || iuscMatches.length === 0) return null;

  for (const raw of iuscMatches) {
    const m = raw.match(/m="([^"]+)"/);
    if (!m) continue;
    const decoded = m[1]
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'");
    let obj: { turl?: unknown };
    try {
      obj = JSON.parse(decoded);
    } catch {
      continue;
    }
    if (typeof obj.turl !== "string" || !obj.turl) continue;
    try {
      const host = new URL(obj.turl).hostname;
      if (BING_THUMB_HOST_RE.test(host)) {
        return obj.turl;
      }
    } catch {
      continue;
    }
  }
  return null;
}

export async function bingLookup(query: string): Promise<string | null> {
  const key = query.toLowerCase().trim();
  if (!key) return null;

  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.url;

  const existing = inflight.get(key);
  if (existing) return existing;

  const p = (async () => {
    const url = await bingFirstThumb(query);
    cache.set(key, { url, expiresAt: Date.now() + CACHE_TTL_MS });
    inflight.delete(key);
    return url;
  })();
  inflight.set(key, p);
  return p;
}
