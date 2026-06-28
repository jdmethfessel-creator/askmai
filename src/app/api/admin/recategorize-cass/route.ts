/**
 * POST /api/admin/recategorize-cass
 *
 * ONE-OFF admin route to fix two data-only bugs on Cass's
 * creator_products rows without requiring a local re-seed.
 *
 * Why server-side: the standard fix is to re-run
 * scripts/ingest-creator-products/seed-cass.mjs --apply from a local
 * shell with HF_API_TOKEN + OPENAI_API_KEY + SUPABASE_* in env. JD
 * doesn't want to paste keys into a local file. This route lives in
 * production where those env vars already exist as Sensitive Vercel
 * env vars, so it just runs there with the existing service-role
 * client.
 *
 * Why NOT re-fetch from upstream: both fixes are pure transforms on
 * already-stored data. No HF/OpenAI/upstream calls needed.
 *   - Shopbop image_url: prefix bug. Insert "/p/" between "/Shopbop/"
 *     and "/prod/" in every shopbop row's image_url. The parser bug
 *     is fixed in scripts/ingest-creator-products/parsers.mjs but the
 *     stored URLs were never refreshed.
 *   - ShopMy product_subcategory: the 1600 ShopMy rows landed mostly
 *     in "other" because the old code used keyword inference on the
 *     title alone, missing many cleanly-tagged categories. ShopMy
 *     stores the rich Category_name (e.g. "Heels", "Bodysuits") in
 *     creator_products.raw.shopmyCategory. Re-map each row's
 *     subcategory using SHOPMY_CATEGORY_NAME_MAP (mirrors the map in
 *     parsers.mjs added in commit e6700a0).
 *
 * Idempotent: running it twice yields the same result. shopbop URL
 * replacement only fires when the source pattern is present;
 * shopmy mapping only updates rows whose mapped value differs from
 * the current value.
 *
 * Auth: header `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`.
 * Reuses the existing prod secret rather than adding a new env var.
 * Anyone with the service-role key already has full DB access via
 * the Supabase admin client, so this route does not expand the
 * blast radius.
 *
 * Returns:
 *   200 { ok: true, shopbop_updated, shopmy_updated, totals, sample_urls }
 *   401 { error: "unauthorized" }
 *   500 { error: "<msg>" }
 */

import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const CREATOR_SLUG = "cass";

// ShopMy Category_name -> canonical subcategory. MUST stay in sync
// with SHOPMY_CATEGORY_NAME_MAP in scripts/ingest-creator-products/parsers.mjs.
// Duplicated here because this route can't import from scripts/ (.mjs
// outside src/ is not bundled into the Next.js route). One-off; the
// map evolves on parser changes and this route only needs to run
// until everyone is on the new path.
const SHOPMY_CATEGORY_NAME_MAP = new Map<string, string>([
  // dresses
  ["Dresses", "dresses"],
  ["Bodysuits", "tops"],
  ["Jumpsuits & Playsuits", "dresses"],
  ["Matching Sets", "dresses"],
  // tops
  ["Tops", "tops"],
  ["Sweaters", "tops"],
  ["Sweatshirts & Hoodies", "tops"],
  ["Cardigans", "tops"],
  ["Bralettes", "tops"],
  ["Pajamas & Loungewear", "tops"],
  ["Robes", "tops"],
  ["Sports Bras", "tops"],
  ["Men's Tops", "tops"],
  ["Lingerie & Intimates", "tops"],
  // bottoms
  ["Skirts", "bottoms"],
  ["Pants", "bottoms"],
  ["Jeans", "bottoms"],
  ["Shorts", "bottoms"],
  ["Skorts", "bottoms"],
  ["Leggings", "bottoms"],
  ["Sweatpants & Joggers", "bottoms"],
  ["Tights", "bottoms"],
  ["Running & Bike Shorts", "bottoms"],
  // outerwear
  ["Jackets", "outerwear"],
  ["Coats", "outerwear"],
  ["Blazers", "outerwear"],
  ["Vests", "outerwear"],
  // shoes
  ["Heels", "shoes"],
  ["Boots", "shoes"],
  ["Sandals", "shoes"],
  ["Flats", "shoes"],
  ["Loafers", "shoes"],
  ["Sneakers", "shoes"],
  ["Mules", "shoes"],
  ["Slippers", "shoes"],
  ["Men's Loafers", "shoes"],
  ["Men's Sneakers", "shoes"],
  ["Baby & Kids Shoes", "shoes"],
  // bags
  ["Crossbody & Shoulder Bags", "bags"],
  ["Tote Bags", "bags"],
  ["Clutches", "bags"],
  ["Mini Bags", "bags"],
  ["Wallets", "bags"],
  ["Makeup & Toiletry Bags", "bags"],
  ["Jewelry Storage", "bags"],
  ["Bag Charms & Keychains", "bags"],
  // jewelry
  ["Earrings", "jewelry"],
  ["Necklaces", "jewelry"],
  ["Bracelets", "jewelry"],
  ["Rings", "jewelry"],
  ["Watches", "jewelry"],
  // accessories
  ["Sunglasses", "accessories"],
  ["Belts", "accessories"],
  ["Scarves & Wraps", "accessories"],
  ["Hats", "accessories"],
  ["Glasses", "accessories"],
  ["Hair Clips & Pins", "accessories"],
  ["Hair Ties & Scrunchies", "accessories"],
  ["Combs", "accessories"],
  ["Fashion Tape & Pasties", "accessories"],
  ["Sleep Masks", "accessories"],
  ["Gloves & Mittens", "accessories"],
  ["Headphones & Accessories", "accessories"],
  // swim
  ["Swimwear", "swim"],
  ["Cover-Ups & Sarongs", "swim"],
  // beauty
  ["Makeup Brushes & Applicators", "beauty"],
  ["Blush", "beauty"],
  ["Moisturizers", "beauty"],
  ["Body Self-Tanner", "beauty"],
  ["Serums", "beauty"],
  ["Lip Balm", "beauty"],
  ["Hair Brushes", "beauty"],
  ["Hair Oils & Serums", "beauty"],
  ["Brow Gels & Waxes", "beauty"],
  ["Setting Powders", "beauty"],
  ["Concealers & Color Correctors", "beauty"],
  ["Face Sunscreen", "beauty"],
  ["Foundation & Tinted Moisturizers", "beauty"],
  ["Dry Shampoo", "beauty"],
  ["Lip Liner", "beauty"],
  ["Makeup Gift Sets", "beauty"],
  ["Hair Masks", "beauty"],
  ["Mascara", "beauty"],
  ["Shampoo", "beauty"],
  ["Cleansers", "beauty"],
  ["Scalp Scrubs & Treatments", "beauty"],
  ["Bronzer & Contour", "beauty"],
  ["Skincare Tools & Devices", "beauty"],
  ["Eyeliners", "beauty"],
  ["Eyeshadows", "beauty"],
  ["Treatments", "beauty"],
  ["Face Mists", "beauty"],
  ["Eye Drops", "beauty"],
  ["Brow Pencils", "beauty"],
  ["Setting Sprays", "beauty"],
  ["Body Sponges & Brushes", "beauty"],
  ["Lash Curlers", "beauty"],
  ["Brow & Lash Serums", "beauty"],
  ["Eye Creams", "beauty"],
  ["Exfoliants, Peels & Scrubs", "beauty"],
  ["Hair Towels", "beauty"],
  ["Curling Irons, Wands & Wavers", "beauty"],
  ["Flat Irons", "beauty"],
  ["Hair Treatments", "beauty"],
  ["Styling Sprays", "beauty"],
  ["Styling Creams", "beauty"],
  ["Conditioner", "beauty"],
  ["Highlighter", "beauty"],
  ["Face Primers", "beauty"],
  ["Lip Gloss", "beauty"],
  ["Lipstick", "beauty"],
  ["Hair Dryers", "beauty"],
  ["Face Masks", "beauty"],
  ["Skincare Gift Sets", "beauty"],
  ["Hand Creams & Treatments", "beauty"],
  ["Toners & Essences", "beauty"],
  ["Face Self-Tanner", "beauty"],
  ["Face Oils", "beauty"],
  ["Lip Masks & Treatments", "beauty"],
  ["Eyeshadow Palettes", "beauty"],
  ["Deodorants & Body Wipes", "beauty"],
  ["Blow Dry Brushes", "beauty"],
  ["Hair Gift Sets", "beauty"],
  ["Hand Soap", "beauty"],
  ["Fragrance", "beauty"],
  ["Body Wash", "beauty"],
  ["Body Lotion", "beauty"],
  // home
  ["Throw Blankets", "home"],
  ["Bath Towels", "home"],
  ["Tumblers & Water Bottles", "home"],
  ["Tea Cups & Coffee Mugs", "home"],
  ["Coffee Makers & Accessories", "home"],
  ["Aerators & Decanters", "home"],
  ["Pillows", "home"],
  ["Vases & Planters", "home"],
  ["Candles & Waxes", "home"],
  ["Duvets, Comforters & Covers", "home"],
  ["Indoor & Outdoor Rugs", "home"],
  ["Bookcases & Storage Cabinets", "home"],
  ["Desks & Desk Chairs", "home"],
  ["Bar & Counter Stools", "home"],
  ["Patio Furniture & Decor", "home"],
  ["Floor & Table Lamps", "home"],
  ["Floor & Wall Mirrors", "home"],
  ["Speakers & Soundbars", "home"],
  ["Art & Prints", "home"],
  ["Serveware", "home"],
  ["Bed Sheets & Sets", "home"],
  ["Accent Chairs & Benches", "home"],
  ["Candleholders", "home"],
  ["Artificial Plants & Flowers", "home"],
  ["Beds, Bed Frames & Headboards", "home"],
  ["Coffee Table Books", "home"],
  ["Games", "home"],
  ["Detergents, Boosters & Softeners", "home"],
  // other
  ["Suitcases", "other"],
  ["Journals & Notebooks", "other"],
  ["Cameras, Lenses & Film", "other"],
  ["Car Seats", "other"],
  ["Kids Clothes & Accessories", "other"],
  ["Vitamins & Supplements", "other"],
  ["Edibles & Tinctures", "other"],
  ["Medicines & Treatments", "other"],
  ["Travel Containers", "other"],
  ["Mouth Tape", "other"],
  ["Books", "other"],
  ["Stationery", "other"],
]);

const SHOPBOP_BAD_PREFIX = "/Shopbop/prod/";
const SHOPBOP_GOOD_PREFIX = "/Shopbop/p/prod/";

export async function POST(request: Request) {
  // Bearer auth: must equal SUPABASE_SERVICE_ROLE_KEY (the same secret
  // the admin client uses internally; reusing rather than adding a new
  // env var). Anyone with this key already has full DB access via the
  // admin client elsewhere.
  const expected = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!expected) {
    return Response.json(
      { error: "service role key not configured" },
      { status: 500 }
    );
  }
  const auth = request.headers.get("authorization") || "";
  const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!presented || presented !== expected) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = supabaseAdmin();

  const { data: creator } = await admin
    .from("creators")
    .select("id, slug")
    .eq("slug", CREATOR_SLUG)
    .maybeSingle();
  if (!creator) {
    return Response.json(
      { error: `creator slug "${CREATOR_SLUG}" not found` },
      { status: 500 }
    );
  }

  // --- 1. Shopbop URL fix ------------------------------------------
  // Read all shopbop rows (63 today, well under PostgREST 1000 cap),
  // compute the new image_url, batch upsert only the rows that need it.
  const { data: shopbopRows, error: sbErr } = await admin
    .from("creator_products")
    .select("id, image_url")
    .eq("creator_id", creator.id)
    .eq("source_network", "shopbop");
  if (sbErr) {
    return Response.json(
      { error: `shopbop read failed: ${sbErr.message}` },
      { status: 500 }
    );
  }
  const shopbopUpdates: Array<{ id: string; image_url: string }> = [];
  for (const row of shopbopRows ?? []) {
    const oldUrl = row.image_url as string | null;
    if (!oldUrl || !oldUrl.includes(SHOPBOP_BAD_PREFIX)) continue;
    const newUrl = oldUrl.replace(SHOPBOP_BAD_PREFIX, SHOPBOP_GOOD_PREFIX);
    if (newUrl === oldUrl) continue;
    shopbopUpdates.push({ id: row.id as string, image_url: newUrl });
  }
  if (shopbopUpdates.length > 0) {
    // PostgREST batch update via upsert on the primary key.
    const { error: sbUpdErr } = await admin
      .from("creator_products")
      .upsert(shopbopUpdates, { onConflict: "id" });
    if (sbUpdErr) {
      return Response.json(
        { error: `shopbop update failed: ${sbUpdErr.message}` },
        { status: 500 }
      );
    }
  }

  // --- 2. ShopMy subcategory remap ---------------------------------
  // Paginate read in 1000-row chunks (Cass has 1600 shopmy rows;
  // PostgREST hard-caps SELECT at 1000 regardless of .range()).
  const CHUNK = 1000;
  const shopmyUpdates: Array<{ id: string; product_subcategory: string }> = [];
  let unmappedCategories = new Map<string, number>();
  for (let offset = 0; ; offset += CHUNK) {
    const { data, error } = await admin
      .from("creator_products")
      .select("id, product_subcategory, raw")
      .eq("creator_id", creator.id)
      .eq("source_network", "shopmy")
      .range(offset, offset + CHUNK - 1);
    if (error) {
      return Response.json(
        { error: `shopmy read at offset ${offset} failed: ${error.message}` },
        { status: 500 }
      );
    }
    const rows = data ?? [];
    for (const row of rows) {
      const raw = (row.raw ?? {}) as { shopmyCategory?: string | null };
      const cat = raw?.shopmyCategory ?? null;
      if (!cat) continue;
      const mapped = SHOPMY_CATEGORY_NAME_MAP.get(cat);
      if (!mapped) {
        unmappedCategories.set(cat, (unmappedCategories.get(cat) ?? 0) + 1);
        continue;
      }
      if (mapped === row.product_subcategory) continue; // already correct
      shopmyUpdates.push({
        id: row.id as string,
        product_subcategory: mapped,
      });
    }
    if (rows.length < CHUNK) break;
  }
  // Batch upsert in chunks (PostgREST payload size matters for 1k+ rows).
  let shopmyUpdated = 0;
  const UPSERT_CHUNK = 200;
  for (let i = 0; i < shopmyUpdates.length; i += UPSERT_CHUNK) {
    const slice = shopmyUpdates.slice(i, i + UPSERT_CHUNK);
    const { error } = await admin
      .from("creator_products")
      .upsert(slice, { onConflict: "id" });
    if (error) {
      return Response.json(
        {
          error: `shopmy upsert at offset ${i} failed: ${error.message}`,
          shopmy_updated_so_far: shopmyUpdated,
        },
        { status: 500 }
      );
    }
    shopmyUpdated += slice.length;
  }

  // --- 3. Post-fix verification + summary --------------------------
  const totals: Record<string, number> = {};
  for (const net of ["shopbop", "revolve", "fwrd", "shopmy"]) {
    const { count } = await admin
      .from("creator_products")
      .select("id", { count: "exact", head: true })
      .eq("creator_id", creator.id)
      .eq("source_network", net);
    totals[net] = count ?? 0;
  }
  const { count: grandTotal } = await admin
    .from("creator_products")
    .select("id", { count: "exact", head: true })
    .eq("creator_id", creator.id);

  // Three sample shopbop URLs to spot-check
  const { data: sampleRows } = await admin
    .from("creator_products")
    .select("image_url")
    .eq("creator_id", creator.id)
    .eq("source_network", "shopbop")
    .limit(3);
  const sampleUrls = (sampleRows ?? []).map(
    (r) => r.image_url as string | null
  );

  return Response.json({
    ok: true,
    shopbop_updated: shopbopUpdates.length,
    shopmy_updated: shopmyUpdated,
    totals,
    grand_total: grandTotal,
    sample_shopbop_image_urls: sampleUrls,
    unmapped_shopmy_categories:
      unmappedCategories.size > 0
        ? Object.fromEntries(unmappedCategories.entries())
        : null,
  });
}
