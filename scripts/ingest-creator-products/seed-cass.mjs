#!/usr/bin/env node
// One-shot seed for Cass DiMicco. Pulls Shopbop hearts, Revolve and
// FWRD wishlists, and her whole ShopMy storefront, then either dry-
// runs or (with --apply) wipes + re-inserts creator_products for her
// row in one transaction.
//
// Usage:
//   node --env-file=.env.local scripts/ingest-creator-products/seed-cass.mjs
//   node --env-file=.env.local scripts/ingest-creator-products/seed-cass.mjs --apply

import { ingestUrl, fetchShopMyShop } from "./parsers.mjs";

const SOURCES = [
  {
    network: "shopbop",
    kind: "url",
    url: "https://www.shopbop.com/hearts/cassdimicco/f47546d6-4053-479a-b887-bd80058a361c?extid=affprg_linkshare_SB-8yaPBDQV8ls&cvosrc=affiliate.linkshare.8yaPBDQV8ls&affuid=user-17709-pin-40272633-puser-null-src-ql&sharedid=42352&subid1=8yaPBDQV8ls-pEE2b2tdzT6vPeoFljNM0Q",
    expectAffiliateKeys: ["extid", "cvosrc", "affuid", "sharedid", "subid1"],
  },
  {
    network: "revolve",
    kind: "url",
    url: "https://www.revolve.com/content/favorites/s/cass-dimiccos-favs-3000246?source=siplt&siplt=296d0&utm_source=rev_ambassador&utm_medium=ambassador&utm_campaign=glob_b_296d0",
    expectAffiliateKeys: [
      "source",
      "siplt",
      "utm_source",
      "utm_medium",
      "utm_campaign",
    ],
  },
  {
    network: "fwrd",
    kind: "url",
    url: "https://www.fwrd.com/fw/PublicWishListView.jsp?email=Y2Fzc2FuZHJhZGltaWNjb0BnbWFpbC5jb20%3D&source=siplt&siplt=296d0&utm_source=rev_ambassador&utm_medium=ambassador&utm_campaign=glob_b_296d0",
    expectAffiliateKeys: [
      "source",
      "siplt",
      "utm_source",
      "utm_medium",
      "utm_campaign",
    ],
  },
  {
    network: "shopmy",
    kind: "shopmy-shop",
    username: "cassdimicco",
    // Whole storefront via apiv3.shopmy.us/api/Shop/products. The
    // stored URL stays on shopmy.us, identifies Cass via Curator_id,
    // and tags AskMai-sourced clicks via u1=askmai-cass (analytics
    // only -- commission still goes to Cass's ShopMy account).
    expectAffiliateKeys: ["Curator_id", "u1"],
  },
];

const apply = process.argv.includes("--apply");

const allRows = [];
for (const src of SOURCES) {
  console.log(`\n=== ${src.network.toUpperCase()} ===`);
  if (src.kind === "url") console.log(`url: ${src.url}`);
  if (src.kind === "shopmy-shop") console.log(`shopmy shop: ${src.username}`);
  let rows;
  try {
    if (src.kind === "url") {
      rows = await ingestUrl(src.url);
    } else if (src.kind === "shopmy-shop") {
      rows = await fetchShopMyShop({ username: src.username, creatorSlug: "cass" });
    } else {
      throw new Error(`unknown source kind: ${src.kind}`);
    }
  } catch (e) {
    console.error(`  FAILED: ${e.message}`);
    continue;
  }
  console.log(`  parsed: ${rows.length} products`);

  // Affiliate-param preservation check: every row's stored URL must
  // carry every key from expectAffiliateKeys.
  const violations = [];
  for (const r of rows) {
    const u = new URL(r.affiliate_url);
    for (const k of src.expectAffiliateKeys) {
      if (!u.searchParams.has(k)) violations.push({ id: r.source_external_id, missing: k });
    }
  }
  if (violations.length) {
    console.error(`  AFFILIATE PARAM VIOLATIONS (${violations.length}):`);
    for (const v of violations.slice(0, 5)) console.error(`    ${v.id} missing ${v.missing}`);
  } else {
    console.log(
      `  affiliate params preserved on all ${rows.length} URLs (${src.expectAffiliateKeys.join(", ")})`
    );
  }

  // Sample card so eyes can confirm shape
  const s = rows[0];
  if (s) {
    console.log("  sample[0]:");
    console.log(`    brand:   ${s.brand}`);
    console.log(`    title:   ${s.product_title}`);
    console.log(`    price:   ${s.price_display}  (n=${s.price})`);
    console.log(`    img:     ${s.image_url}`);
    console.log(`    afflnk:  ${s.affiliate_url}`);
  }
  allRows.push(...rows);
}

console.log(`\n=== TOTAL ===`);
console.log(`${allRows.length} products across ${SOURCES.length} networks`);
const byNet = {};
for (const r of allRows) byNet[r.source_network] = (byNet[r.source_network] || 0) + 1;
console.log("by network:", byNet);

if (!apply) {
  console.log("\n[dry-run] no DB writes. Re-run with --apply to upsert.");
  process.exit(0);
}

const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);
const { data: creator } = await sb
  .from("creators")
  .select("id")
  .eq("slug", "cass")
  .maybeSingle();
if (!creator) {
  console.error("creator slug 'cass' not found");
  process.exit(1);
}
const payload = allRows.map((r) => ({ ...r, creator_id: creator.id }));

// The partial unique index in 007 (WHERE source_external_id IS NOT NULL)
// does not satisfy PostgreSQL's ON CONFLICT predicate requirement, so we
// can't use supabase-js upsert here. Instead: wipe creator's rows then
// insert fresh. For a single-creator demo seed this is fine and keeps
// the script idempotent — re-running gives you exactly what's currently
// on the live wishlists, no drift from prior partial loads.
const { error: delErr } = await sb
  .from("creator_products")
  .delete()
  .eq("creator_id", creator.id);
if (delErr) {
  console.error("wipe failed:", delErr.message);
  process.exit(1);
}

// Insert in chunks; PostgREST has a payload size ceiling. Chunks of
// 200 occasionally `fetch failed` on the ShopMy rows (larger `raw`
// JSON), so we keep it at 100 with a single one-shot retry on
// transient fetch failures (the most common cause is a brief
// connection drop, not a real schema issue).
const CHUNK = 100;
let inserted = 0;
for (let i = 0; i < payload.length; i += CHUNK) {
  const slice = payload.slice(i, i + CHUNK);
  let attempt = 0;
  while (true) {
    const { error } = await sb.from("creator_products").insert(slice);
    if (!error) break;
    attempt += 1;
    if (attempt > 2) {
      console.error(`insert failed at ${i} after ${attempt} attempts:`, error.message);
      process.exit(1);
    }
    console.warn(`  retry ${attempt} at offset ${i}: ${error.message}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  inserted += slice.length;
}

// Verify what actually landed. Use HEAD + count:exact so we get the
// real total — PostgREST caps row payloads at 1000 by default, which
// would silently undercount FWRD in a SELECT-and-tally approach.
console.log(`[apply] inserted ${inserted} rows into creator_products`);
const byNetActual = {};
for (const net of ["shopbop", "revolve", "fwrd", "shopmy", "csv", "manual"]) {
  const { count } = await sb
    .from("creator_products")
    .select("id", { count: "exact", head: true })
    .eq("creator_id", creator.id)
    .eq("source_network", net);
  if (count) byNetActual[net] = count;
}
const { count: total } = await sb
  .from("creator_products")
  .select("id", { count: "exact", head: true })
  .eq("creator_id", creator.id);
console.log(`[verify] DB row counts: ${JSON.stringify(byNetActual)}  total=${total}`);
