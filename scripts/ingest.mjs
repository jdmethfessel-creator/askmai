// Ingests Cass DiMicco's product feeds into the products table.
//
// Runs every supported source it can; today that's:
//   - ShopMy collection 3711656 (public API)
//
// Other sources (Shopbop hearts, Revolve favorites, FWRD wishlist) require
// browser/auth to fetch. We log them as SKIPPED so you know to hand-add later.
//
// Run with: npm run ingest

import { createClient } from "@supabase/supabase-js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing Supabase env vars.");
  process.exit(1);
}
const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const SOURCES = {
  shopmy_collection_3711656: { network: "shopmy", kind: "shopmy_collection", id: "3711656" },
  shopbop_hearts: { network: "shopbop", kind: "manual_required", note: "Behind Amazon login; needs auth cookie" },
  revolve_favorites: { network: "revolve", kind: "manual_required", note: "Blocked by WAF / timeout" },
  fwrd_wishlist: { network: "fwrd", kind: "manual_required", note: "Blocked by WAF / timeout" },
};

async function ensureSchema() {
  const probe = await sb.from("products").select("image_url").limit(1);
  if (probe.error && /image_url.*does not exist/.test(probe.error.message)) {
    console.error(
      "\nMissing column products.image_url. Run this SQL in the Supabase SQL editor:\n"
    );
    console.error("    ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url text;\n");
    console.error("Then re-run `npm run ingest`.");
    process.exit(1);
  }
}

async function getCass() {
  const { data, error } = await sb
    .from("creators")
    .select("id, slug")
    .eq("slug", "cass")
    .maybeSingle();
  if (error || !data) throw new Error("Creator slug 'cass' not found.");
  return data;
}

function normalizeAffiliateUrl(raw, creatorSlug) {
  if (!raw) return null;
  // ShopMy template field <custom_id> is a u1 sub-affiliate placeholder.
  return raw.replaceAll("<custom_id>", `askmai-${creatorSlug}`);
}

function mapShopMyCategory(p) {
  const industry = (p.product?.Industry_name || "").toLowerCase();
  const department = (p.product?.Department_name || "").toLowerCase();
  if (industry.includes("beauty") || department.includes("beauty"))
    return "beauty";
  if (industry.includes("fashion") || department.includes("clothing"))
    return "fashion";
  if (department.includes("accessories") || department.includes("footwear") || department.includes("bag"))
    return "accessories";
  if (industry.includes("home") || industry.includes("living")) return "lifestyle";
  if (industry.includes("travel")) return "travel";
  return "fashion";
}

async function fetchShopMyCollection(collectionId, creatorSlug) {
  const res = await fetch(
    `https://api.shopmy.us/api/Collections/${collectionId}`,
    { headers: { "User-Agent": UA } }
  );
  if (!res.ok) {
    console.warn(`  shopmy collection ${collectionId}: HTTP ${res.status}`);
    return [];
  }
  const json = await res.json();
  const pins = Array.isArray(json.pins) ? json.pins : [];
  console.log(
    `  shopmy collection ${collectionId}: "${json.name}" — ${pins.length} pins`
  );

  return pins
    .filter((pin) => !pin.isHidden && pin.product && pin.affiliate_link)
    .map((pin) => {
      const name = (pin.product?.title || pin.title || "").trim();
      const brand = (pin.product?.AllBrand_name || "").trim() || null;
      return {
        name,
        brand,
        category: mapShopMyCategory(pin),
        price: pin.product?.fallbackPrice ?? null,
        affiliate_url: normalizeAffiliateUrl(pin.affiliate_link, creatorSlug),
        network: "shopmy",
        image_url:
          pin.image ||
          pin.original_image ||
          pin.product?.image ||
          null,
        external_key: `shopmy:pin:${pin.id}`,
      };
    })
    .filter((p) => p.name && p.affiliate_url);
}

async function upsertProducts(creator_id, items) {
  if (items.length === 0) return { inserted: 0, skipped: 0 };
  const rows = items.map((it) => ({
    creator_id,
    name: it.name,
    brand: it.brand,
    category: it.category,
    price: it.price,
    affiliate_url: it.affiliate_url,
    network: it.network,
    image_url: it.image_url,
  }));

  // Avoid duplicate inserts by checking existing affiliate_url per creator.
  const { data: existing } = await sb
    .from("products")
    .select("affiliate_url")
    .eq("creator_id", creator_id);
  const seen = new Set((existing ?? []).map((r) => r.affiliate_url));
  const fresh = rows.filter((r) => !seen.has(r.affiliate_url));

  if (fresh.length === 0) return { inserted: 0, skipped: rows.length };

  const { error } = await sb.from("products").insert(fresh);
  if (error) throw new Error(`insert failed: ${error.message}`);
  return { inserted: fresh.length, skipped: rows.length - fresh.length };
}

async function countByNetwork(creator_id) {
  const { data } = await sb
    .from("products")
    .select("network")
    .eq("creator_id", creator_id);
  const counts = {};
  for (const r of data ?? []) {
    counts[r.network ?? "unknown"] = (counts[r.network ?? "unknown"] ?? 0) + 1;
  }
  return counts;
}

async function main() {
  await ensureSchema();
  const cass = await getCass();
  console.log(`Creator: cass (id=${cass.id})`);

  const summary = { sources: {} };

  // ShopMy
  console.log("\n[shopmy] fetching collections…");
  const shopmyItems = await fetchShopMyCollection("3711656", cass.slug);
  const shopmy = await upsertProducts(cass.id, shopmyItems);
  summary.sources.shopmy = {
    extracted: shopmyItems.length,
    inserted: shopmy.inserted,
    skipped_duplicates: shopmy.skipped,
  };
  console.log(
    `  → extracted ${shopmyItems.length}, inserted ${shopmy.inserted}, skipped ${shopmy.skipped} duplicates`
  );

  // Sources we can't programmatically fetch today.
  for (const [src, cfg] of Object.entries(SOURCES)) {
    if (cfg.kind !== "manual_required") continue;
    summary.sources[cfg.network] = {
      extracted: 0,
      inserted: 0,
      status: "SKIPPED",
      reason: cfg.note,
    };
    console.log(`  [${cfg.network}] SKIPPED — ${cfg.note}`);
  }

  console.log("\n--- products by network ---");
  const counts = await countByNetwork(cass.id);
  for (const [net, n] of Object.entries(counts)) {
    console.log(`  ${net}: ${n}`);
  }

  console.log("\nSummary:", JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error("\nINGEST FAILED:", e.message);
  process.exit(1);
});
