/**
 * One-off: fix Madison's taste_profile (strip stale "no products yet"
 * notes) + delete + re-import her ShopMy catalog with the new category
 * normalizer applied at import time.
 *
 * Safe to re-run: products are wiped before re-insert, taste_profile
 * is a deterministic JSON merge.
 *
 * Run with: node --env-file=.env.local scripts/reimport-madisonwaller.mjs
 */

import { createClient } from "@supabase/supabase-js";
import { connector as shopmyConnector } from "./import/connectors/shopmy.mjs";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing Supabase env vars.");
  process.exit(1);
}
const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const SLUG = "madisonwaller";

const NEW_FASHION_PHILOSOPHY =
  "Travel-friendly basics with one statement piece. Reformation dresses " +
  "for restaurant nights, Enza Costa tees and Citizens of Humanity denim " +
  "for the in-between, lululemon for movement and travel days, Tony Bianco " +
  "shoes that actually walk. One Cult Gaia or 12th Tribe bag does the heavy " +
  "lifting. Always a stack of fine jewelry from Ring Concierge or " +
  "diamondaupair to dress the rest up.";

const NEW_BEAUTY_FOCUS =
  "Travel-routine first. Skincare, fragrance, and makeup she's stress-tested " +
  "across timezones — serums, a daily SPF, a flush of blush, Dior compacts " +
  "for the plane. Her ShopMy feed has the full live rotation of products " +
  "she actually packs.";

// 1) Fetch + rewrite taste_profile
const creator = await sb
  .from("creators")
  .select("id, taste_profile")
  .eq("slug", SLUG)
  .maybeSingle();
if (creator.error || !creator.data) {
  console.error("Madison row not found:", creator.error?.message);
  process.exit(1);
}
const creatorId = creator.data.id;
const tp = { ...creator.data.taste_profile };
tp.fashion = { ...(tp.fashion ?? {}), style_philosophy: NEW_FASHION_PHILOSOPHY };
tp.beauty = { ...(tp.beauty ?? {}), focus: NEW_BEAUTY_FOCUS };

console.log("Updating taste_profile (fashion.style_philosophy + beauty.focus)…");
const upd = await sb
  .from("creators")
  .update({ taste_profile: tp })
  .eq("id", creatorId);
if (upd.error) {
  console.error("taste_profile update failed:", upd.error.message);
  process.exit(1);
}
console.log("  OK\n");

// 2) Wipe existing products for this creator. The runner doesn't
// upsert today, so a re-run without a wipe would duplicate every row.
console.log("Deleting existing Madison products…");
const del = await sb.from("products").delete().eq("creator_id", creatorId);
if (del.error) {
  console.error("delete failed:", del.error.message);
  process.exit(1);
}
console.log("  OK\n");

// 3) Re-import via the connector + insert.
console.log("Fetching from ShopMy…");
const products = await shopmyConnector.fetchProducts({ identifier: SLUG });
console.log(`  connector returned ${products.length} candidates\n`);

const valid = products.filter((p) => {
  if (!p.affiliate_url || !p.name) return false;
  try {
    const host = new URL(p.affiliate_url).hostname;
    return shopmyConnector.isAttributingHost(host);
  } catch {
    return false;
  }
});
console.log(`Inserting ${valid.length} valid rows…`);

const rows = valid.map((p) => ({
  creator_id: creatorId,
  name: p.name,
  brand: p.brand,
  category: p.category,
  price: parsePrice(p.price),
  image_url: p.image_url,
  affiliate_url: p.affiliate_url,
  network: p.network,
}));
const ins = await sb.from("products").insert(rows).select("id");
if (ins.error) {
  console.error("insert failed:", ins.error.message);
  process.exit(1);
}
console.log(`  inserted ${ins.data?.length ?? 0} rows\n`);

// 4) Report category distribution post-normalization.
const after = await sb
  .from("products")
  .select("category")
  .eq("creator_id", creatorId);
const byCat = {};
for (const p of after.data) {
  const k = p.category ?? "(null)";
  byCat[k] = (byCat[k] || 0) + 1;
}
console.log("Category distribution after normalization:");
for (const [c, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)} × ${c}`);
}

function parsePrice(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{1,5}(?:,\d{3})*(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}
