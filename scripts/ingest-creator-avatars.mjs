// Fetch a TEMPORARY headshot for each creator via the same Bing image
// pipeline used by /api/product-image and scripts/reingest-images.mjs.
// Stores the Bing-CDN thumbnail URL on creators.avatar_url. The rendered
// /creators page proxies the URL through /api/img (which allowlists
// ts*.mm.bing.net), so we never hotlink to a third-party host that could
// hotlink-block us, and the URL is cached in Supabase — no Bing refetch
// per page load.
//
// Run with: npm run seed:avatars

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing Supabase env vars.");
  process.exit(1);
}
const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const BING_THUMB_HOST_RE = /^ts\d+\.(?:mm|explicit)\.bing\.net$/;

const REQUEST_DELAY_MS = 800;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Per-creator Bing query. The niche keyword biases Bing toward the
// right person (there are many "Emily Henderson"s; "interior designer"
// pins the lookup). Order matters: we use the FIRST .iusc result.
const QUERIES = [
  { slug: "janesmith", query: "Cass DiMicco fashion influencer NYC" },
  { slug: "tezza", query: "Tezza Barton photographer creator" },
  { slug: "weworewhat", query: "Danielle Bernstein WeWoreWhat" },
  { slug: "somethingnavy", query: "Arielle Charnas Something Navy" },
  { slug: "emilyhenderson", query: "Emily Henderson interior designer" },
];

async function bingFirstImage(query) {
  if (!query) return { error: "empty query" };
  const url = `https://www.bing.com/images/search?q=${encodeURIComponent(
    query
  )}&form=HDRSC2&first=1`;

  let html;
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return { error: `bing ${r.status}` };
    html = await r.text();
  } catch (e) {
    return { error: `bing fetch: ${e.message}` };
  }

  const matches = html.match(/class="iusc"[^>]*m="([^"]+)"/g);
  if (!matches || matches.length === 0) return { error: "no iusc results" };

  // Walk results; take the first one whose turl validates as a real image.
  for (const m of matches) {
    const raw = m.match(/m="([^"]+)"/)?.[1];
    if (!raw) continue;
    const decoded = raw
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'");
    let obj;
    try {
      obj = JSON.parse(decoded);
    } catch {
      continue;
    }
    if (!obj.turl || typeof obj.turl !== "string") continue;
    const validation = await validateImage(obj.turl);
    if (validation.ok) {
      return {
        url: obj.turl,
        source: obj.purl,
        bytes: validation.bytes,
      };
    }
  }
  return { error: "no usable turl in any iusc result" };
}

async function validateImage(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "invalid URL" };
  }
  if (!BING_THUMB_HOST_RE.test(parsed.hostname)) {
    return { ok: false, reason: `host not allowed: ${parsed.hostname}` };
  }
  try {
    const r = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return { ok: false, reason: `GET ${r.status}` };
    const ct = r.headers.get("content-type") || "";
    if (!ct.startsWith("image/")) return { ok: false, reason: `ct=${ct}` };
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 500) {
      return { ok: false, reason: `body ${buf.byteLength}b` };
    }
    return { ok: true, bytes: buf.byteLength };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function main() {
  console.log("Fetching temporary headshots for 5 creators via Bing...\n");
  let ok = 0;
  let failed = 0;
  for (const { slug, query } of QUERIES) {
    const { data: creator, error: cErr } = await sb
      .from("creators")
      .select("id, slug, name, avatar_url")
      .eq("slug", slug)
      .maybeSingle();
    if (cErr || !creator) {
      console.log(`  ${slug}: SKIP — creator row not found`);
      failed++;
      continue;
    }

    const result = await bingFirstImage(query);
    if (result.error) {
      console.log(`  ${creator.name} (${slug}): FAIL — ${result.error}`);
      failed++;
      await sleep(REQUEST_DELAY_MS);
      continue;
    }

    const { error: uErr } = await sb
      .from("creators")
      .update({ avatar_url: result.url })
      .eq("id", creator.id);
    if (uErr) {
      console.log(`  ${creator.name} (${slug}): UPDATE FAILED — ${uErr.message}`);
      failed++;
    } else {
      console.log(
        `  ${creator.name} (${slug}): OK — ${result.bytes}b — ${result.url}`
      );
      ok++;
    }
    await sleep(REQUEST_DELAY_MS);
  }
  console.log(`\n${ok}/${QUERIES.length} avatars stored, ${failed} failed.`);
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
