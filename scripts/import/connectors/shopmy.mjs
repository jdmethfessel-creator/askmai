/**
 * ShopMy connector.
 *
 * Discovery (one-time): Playwright revealed that shopmy.us is a CRA SPA
 * which fetches the storefront from
 *   GET https://apiv3.shopmy.us/api/Shop/products
 *       ?Curator_username=<handle>
 *       &tab=latest
 *       &limit=12
 *       &page=N
 * The endpoint accepts public requests with `Origin: https://shopmy.us`
 * and `Referer: https://shopmy.us/shop/<handle>` (no auth header), and
 * returns { success, results: [...] } where each result row carries the
 * product metadata. The storefront's product tile href is constructed
 * client-side as
 *   https://shopmy.us/shop/product/<Product_id>?Curator_id=<curator>
 * which is ShopMy's attributing URL: the host is shopmy.us, the
 * Curator_id parameter records the click against the creator, and
 * ShopMy's server forwards the user to the retailer with her affiliate
 * tracking attached.
 *
 * We use direct fetch here instead of Playwright — same payloads, no
 * browser startup, easier to schedule. Playwright stays as a dev
 * dependency for future connectors that need real DOM (e.g. LTK).
 */

const API = "https://apiv3.shopmy.us";
const SHOP_ORIGIN = "https://shopmy.us";

// ShopMy → AskMai category enum mapping.
//
// ShopMy tags products at three levels:
//   Industry_name   "Fashion & Accessories", "Beauty", "Home", ...
//   Department_name "Apparel", "Footwear", "Jewelry", "Skincare", ...
//   Category_name   "Dresses", "Sandals", "Necklaces", "Serums", ...
//
// AskMai's chat route filters loadCatalog by an IN check against
// fashion/beauty/accessories/dining/travel/lifestyle. Without this
// remap every imported row carries a granular ShopMy value (e.g.
// "Dresses") and the IN filter rejects all of it.
//
// Resolution order: try Category_name (most specific), then
// Department_name, then Industry_name. Anything that doesn't match
// falls through to null — better to drop a product from category-
// filtered queries than to dump it under a wrong bucket and have the
// model recommend a candle for a dress request.

const CATEGORY_MAP = {
  // Apparel
  dresses: "fashion",
  tops: "fashion",
  pants: "fashion",
  jeans: "fashion",
  denim: "fashion",
  coats: "fashion",
  jackets: "fashion",
  blazers: "fashion",
  sweaters: "fashion",
  knits: "fashion",
  cardigans: "fashion",
  shorts: "fashion",
  skirts: "fashion",
  swimwear: "fashion",
  leggings: "fashion",
  "sports bras": "fashion",
  "lingerie & intimates": "fashion",
  rompers: "fashion",
  jumpsuits: "fashion",
  activewear: "fashion",
  loungewear: "fashion",
  outerwear: "fashion",
  vests: "fashion",
  suits: "fashion",
  // Footwear, bags, jewelry, eyewear, hats
  heels: "accessories",
  sandals: "accessories",
  sneakers: "accessories",
  boots: "accessories",
  flats: "accessories",
  loafers: "accessories",
  mules: "accessories",
  clogs: "accessories",
  slides: "accessories",
  pumps: "accessories",
  slippers: "accessories",
  bags: "accessories",
  clutches: "accessories",
  totes: "accessories",
  backpacks: "accessories",
  crossbody: "accessories",
  satchels: "accessories",
  handbags: "accessories",
  wallets: "accessories",
  necklaces: "accessories",
  bracelets: "accessories",
  earrings: "accessories",
  rings: "accessories",
  jewelry: "accessories",
  watches: "accessories",
  sunglasses: "accessories",
  hats: "accessories",
  belts: "accessories",
  scarves: "accessories",
  gloves: "accessories",
  // Beauty
  fragrance: "beauty",
  perfume: "beauty",
  cologne: "beauty",
  serums: "beauty",
  moisturizers: "beauty",
  cleansers: "beauty",
  toners: "beauty",
  "face masks": "beauty",
  sunscreen: "beauty",
  spf: "beauty",
  "lip balm": "beauty",
  "lip gloss": "beauty",
  lipstick: "beauty",
  blush: "beauty",
  bronzer: "beauty",
  highlighter: "beauty",
  mascara: "beauty",
  eyeliner: "beauty",
  eyeshadow: "beauty",
  foundation: "beauty",
  concealer: "beauty",
  "makeup brushes & applicators": "beauty",
  makeup: "beauty",
  skincare: "beauty",
  "hair care": "beauty",
  shampoo: "beauty",
  conditioner: "beauty",
  "nail polish": "beauty",
  "body care": "beauty",
  // Home / lifestyle
  "candles & waxes": "lifestyle",
  candles: "lifestyle",
  serveware: "lifestyle",
  dinnerware: "lifestyle",
  glassware: "lifestyle",
  kitchenware: "lifestyle",
  bedding: "lifestyle",
  bath: "lifestyle",
  decor: "lifestyle",
  furniture: "lifestyle",
  lighting: "lifestyle",
  art: "lifestyle",
  rugs: "lifestyle",
  pillows: "lifestyle",
  vases: "lifestyle",
  "vitamins & supplements": "lifestyle",
  wellness: "lifestyle",
  fitness: "lifestyle",
  books: "lifestyle",
  stationery: "lifestyle",
  // Travel-specific
  luggage: "travel",
  suitcases: "travel",
  "travel accessories": "travel",
};

const DEPARTMENT_MAP = {
  apparel: "fashion",
  clothing: "fashion",
  outerwear: "fashion",
  footwear: "accessories",
  shoes: "accessories",
  jewelry: "accessories",
  bags: "accessories",
  handbags: "accessories",
  accessories: "accessories",
  eyewear: "accessories",
  skincare: "beauty",
  makeup: "beauty",
  fragrance: "beauty",
  hair: "beauty",
  "hair care": "beauty",
  "body care": "beauty",
  wellness: "lifestyle",
  home: "lifestyle",
  "home decor": "lifestyle",
  kitchen: "lifestyle",
  "kitchen & dining": "lifestyle",
  bedroom: "lifestyle",
  bath: "lifestyle",
  fitness: "lifestyle",
  travel: "travel",
};

const INDUSTRY_MAP = {
  "fashion & accessories": "fashion",
  fashion: "fashion",
  beauty: "beauty",
  home: "lifestyle",
  lifestyle: "lifestyle",
  wellness: "lifestyle",
  "food & drink": "lifestyle",
  travel: "travel",
};

function normalizeCategory(r) {
  const cat = (r.Category_name || "").toString().trim().toLowerCase();
  if (cat && CATEGORY_MAP[cat]) return CATEGORY_MAP[cat];
  const dept = (r.Department_name || "").toString().trim().toLowerCase();
  if (dept && DEPARTMENT_MAP[dept]) return DEPARTMENT_MAP[dept];
  // Industry "Fashion & Accessories" is ambiguous — if we reached
  // this line without matching a category or department we still
  // know it's apparel-adjacent and "fashion" is the safer bucket
  // than null. Same logic for the other industries.
  const industry = (r.Industry_name || "").toString().trim().toLowerCase();
  if (industry && INDUSTRY_MAP[industry]) return INDUSTRY_MAP[industry];
  return null;
}

export const connector = {
  network: "shopmy",

  isAttributingHost(host) {
    const h = host.toLowerCase();
    return h === "shopmy.us" || h === "www.shopmy.us";
  },

  async fetchProducts({ identifier }) {
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "application/json",
      Origin: SHOP_ORIGIN,
      Referer: `${SHOP_ORIGIN}/shop/${encodeURIComponent(identifier)}`,
    };

    const LIMIT = 12;
    let page = 1;
    const all = [];
    const seenIds = new Set();
    let curatorId = null;

    // Each request also gets a searchRequestId from the first page to
    // mirror what the SPA does. Not strictly required by the API, but
    // it keeps our requests indistinguishable from the storefront's
    // and avoids any anti-scrape heuristics that might tighten later.
    let searchRequestId = null;

    while (true) {
      const params = new URLSearchParams({
        Curator_username: identifier,
        tab: "latest",
        limit: String(LIMIT),
        page: String(page),
        searchVariant: "similar-products-v1",
      });
      if (searchRequestId) params.set("searchRequestId", searchRequestId);

      const res = await fetch(`${API}/api/Shop/products?${params}`, {
        headers,
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        throw new Error(
          `ShopMy API page ${page} returned ${res.status}: ${await res.text().catch(() => "")}`
        );
      }
      const body = await res.json();
      if (!body.success || !Array.isArray(body.results)) {
        throw new Error(`Unexpected ShopMy response on page ${page}`);
      }
      if (page === 1 && body.searchRequestId) {
        searchRequestId = body.searchRequestId;
      }
      const results = body.results;
      if (results.length === 0) break;

      for (const r of results) {
        if (!r || typeof r !== "object") continue;
        if (seenIds.has(r.id)) continue;
        seenIds.add(r.id);

        // Curator_id: pull from the curators[] array. The storefront
        // username -> Curator_id mapping is the same for every row
        // (since we filtered by Curator_username), so we lock it in
        // on the first row we see.
        if (curatorId == null) {
          const c = Array.isArray(r.curators) ? r.curators[0] : null;
          if (c && typeof c.id === "number") curatorId = c.id;
        }

        all.push(r);
      }

      if (results.length < LIMIT) break; // last page
      page += 1;

      // Tiny throttle so we play nice with their API.
      await new Promise((res) => setTimeout(res, 120));
    }

    if (curatorId == null) {
      throw new Error(
        `Could not resolve Curator_id for ShopMy username "${identifier}". ` +
          "Without it we'd produce un-attributed links — refusing to insert anything."
      );
    }

    // Normalize. affiliate_url is built deterministically from
    // Product_id + curator id, matching the storefront tile href.
    const normalized = all
      .map((r) => normalizeOne(r, curatorId))
      .filter((p) => p !== null);

    return normalized;
  },
};

/**
 * Rewrite a ShopMy product image URL so it's publicly addressable.
 *
 *   production-shopmyshelf-uploads.s3*.amazonaws.com/<key>
 *     -> static.shopmy.us/uploads/<key>
 *   production-shopmyshelf-pins.s3*.amazonaws.com/<key>
 *     -> static.shopmy.us/pins/<key>
 *
 * All other URLs (retailer CDNs like cdn.shopify.com,
 * images.lululemon.com, www.sephora.com, ringconcierge.com, etc.) are
 * already publicly readable and pass through unchanged.
 */
function publicShopMyImage(url) {
  if (!url || typeof url !== "string") return url;
  let u;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const host = u.hostname.toLowerCase();
  const key = u.pathname.replace(/^\/+/, "");
  if (
    /^production-shopmyshelf-uploads\.s3(?:[.-]us-east-2)?\.amazonaws\.com$/.test(
      host
    )
  ) {
    return `https://static.shopmy.us/uploads/${key}`;
  }
  if (
    /^production-shopmyshelf-pins\.s3(?:[.-]us-east-2)?\.amazonaws\.com$/.test(
      host
    )
  ) {
    return `https://static.shopmy.us/pins/${key}`;
  }
  return url;
}

function normalizeOne(r, curatorId) {
  const name = (r.title || "").toString().trim();
  if (!name) return null;
  const productId = r.id ?? r.Product_id;
  if (productId == null) return null;

  const affiliateUrl =
    `https://shopmy.us/shop/product/${encodeURIComponent(productId)}` +
    `?Curator_id=${encodeURIComponent(curatorId)}`;

  // Image selection. ShopMy stores cover images on a PRIVATE S3
  // bucket (production-shopmyshelf-uploads / -pins), so the URLs they
  // give us in `r.image` and the `isCover=1` row of `r.images[]` 403
  // on any direct GET — including our /api/img proxy. The same files
  // ARE served publicly through `static.shopmy.us/<bucket-path>/<key>`,
  // which is ShopMy's own CDN mirror of those buckets. We pick the
  // cover image (best quality, photographer-curated) and rewrite the
  // host through publicShopMyImage() so the URL we store actually
  // loads in a browser.
  let image_url = null;
  if (r.image && typeof r.image === "string") image_url = r.image;
  if (!image_url && Array.isArray(r.images)) {
    const cover = r.images.find((i) => i?.isCover) ?? r.images[0];
    if (cover?.image && typeof cover.image === "string") {
      image_url = cover.image;
    }
  }
  image_url = publicShopMyImage(image_url);

  // Map ShopMy's granular Category_name / Department_name /
  // Industry_name into our enum so loadCatalog's IN-filter can find
  // them. Without this every product lands on a granular value like
  // "Dresses" or "Sandals" and the chat route's IN filter rejects
  // them. See normalizeCategory below for the table.
  const category = normalizeCategory(r);

  // Price: ShopMy stores fallbackPrice as a number in USD (per data
  // inspection). Keep as a stringified dollar amount so the runner's
  // parser hits the leading-$ shape it uses elsewhere.
  const price =
    typeof r.fallbackPrice === "number"
      ? `$${r.fallbackPrice}`
      : r.fallbackPrice != null
      ? String(r.fallbackPrice)
      : null;

  const brand = r.AllBrand_name
    ? String(r.AllBrand_name).trim()
    : null;

  return {
    name,
    brand,
    category: category ? category.toString() : null,
    price,
    image_url,
    affiliate_url: affiliateUrl,
    network: "shopmy",
  };
}
