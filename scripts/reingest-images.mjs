// One-off: re-ingest feed-tier product images.
//
// Original plan was Mytheresa's CDN, but both Mytheresa's CDN (img.mytheresa.com)
// and their product pages are bot-blocked from server-side fetches (S3-403 on
// the CDN; product pages serve a 9.9KB "isBotPage" interstitial). Same blocker
// as the ShopMy S3 bucket the original ingest used.
//
// Pivot: Bing image search. Its thumbnail CDN (ts*.mm.bing.net) is publicly
// reachable, returns ~300px product photos, and matches our card display
// dimensions. Same approach that's worked reliably in our dsdupe project.
//
// Run with: npm run reingest:images

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceKey) {
  console.error("Missing Supabase env vars.");
  process.exit(1);
}
const sb = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Bing serves thumbnails from ts0–ts4.mm.bing.net. Pinning here lets us
// allowlist a single, predictable host family in /api/img.
const BING_THUMB_HOST_RE = /^ts\d+\.(?:mm|explicit)\.bing\.net$/;

const REQUEST_DELAY_MS = 800;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function bingFirstImage(brand, name) {
  const query = `${brand ?? ""} ${name}`.trim();
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

  // Bing embeds image data as JSON inside m="..." on .iusc anchors.
  // turl = thumbnail (small, served by Bing's CDN, never blocked).
  // murl = medium-resolution URL on the original merchant's CDN.
  const matches = html.match(/class="iusc"[^>]*m="([^"]+)"/g);
  if (!matches || matches.length === 0) return { error: "no iusc results" };

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
    if (obj.turl && typeof obj.turl === "string") {
      return { url: obj.turl, source: "bing-thumb", murl: obj.murl };
    }
  }
  return { error: "no turl in any iusc result" };
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

function labelFor(p) {
  return `${p.brand ?? "?"} — ${p.name}`;
}

async function main() {
  const { data: creator } = await sb
    .from("creators")
    .select("id, slug")
    .eq("slug", "janesmith")
    .maybeSingle();
  if (!creator) {
    console.error("No creator with slug 'janesmith'.");
    process.exit(1);
  }

  const { data: products, error: readErr } = await sb
    .from("products")
    .select("id, name, brand, affiliate_url, image_url, network")
    .eq("creator_id", creator.id)
    .eq("network", "shopmy");
  if (readErr) {
    console.error("Read failed:", readErr.message);
    process.exit(1);
  }

  console.log(
    `Re-ingesting images via Bing for ${products.length} feed-tier products...\n`
  );

  const success = [];
  const failed = [];

  for (const p of products) {
    const found = await bingFirstImage(p.brand, p.name);
    if (found.error) {
      failed.push({ p, reason: found.error });
      console.log(`  FAIL  ${labelFor(p)}: ${found.error}`);
      await sleep(REQUEST_DELAY_MS);
      continue;
    }

    const valid = await validateImage(found.url);
    if (!valid.ok) {
      failed.push({ p, reason: valid.reason });
      console.log(
        `  FAIL  ${labelFor(p)}: image ${valid.reason} (${found.url.slice(0, 80)})`
      );
      await sleep(REQUEST_DELAY_MS);
      continue;
    }

    const { error: updErr } = await sb
      .from("products")
      .update({ image_url: found.url })
      .eq("id", p.id);
    if (updErr) {
      failed.push({ p, reason: `db: ${updErr.message}` });
      console.log(`  FAIL  ${labelFor(p)}: db ${updErr.message}`);
    } else {
      success.push({ p, url: found.url });
      console.log(`  OK    ${labelFor(p)}  (${valid.bytes}b)`);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  console.log("\n=== SUMMARY ===");
  console.log(
    `${success.length} of ${products.length} products now have a working Bing-thumb image_url`
  );
  if (failed.length > 0) {
    console.log(`\n${failed.length} failed:`);
    for (const f of failed) {
      console.log(`  - ${labelFor(f.p)}: ${f.reason}`);
    }
  }
}

main().catch((e) => {
  console.error("\nSCRIPT FAILED:", e.message);
  process.exit(1);
});
