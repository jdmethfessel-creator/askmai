// Browser-like fetch wrapper. The existing scripts/ingest.mjs concluded
// Shopbop / Revolve / FWRD were "blocked by WAF or auth" using curl,
// but Node's built-in fetch (undici) passes all three with the right
// header set — Akamai's WAF was tripping on curl's TLS fingerprint,
// not on the request shape. Keep these headers identical across all
// network parsers so an upstream WAF change is one place to fix.

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "sec-ch-ua":
    '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

export async function fetchHtml(url, { timeoutMs = 30_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      redirect: "follow",
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${url} (${text.length} bytes)`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}
