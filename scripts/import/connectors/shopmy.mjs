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

function normalizeOne(r, curatorId) {
  const name = (r.title || "").toString().trim();
  if (!name) return null;
  const productId = r.id ?? r.Product_id;
  if (productId == null) return null;

  const affiliateUrl =
    `https://shopmy.us/shop/product/${encodeURIComponent(productId)}` +
    `?Curator_id=${encodeURIComponent(curatorId)}`;

  // Image: prefer the curated `image` field; fall back to the first
  // cover image in `images[]`.
  let image_url = r.image && typeof r.image === "string" ? r.image : null;
  if (!image_url && Array.isArray(r.images)) {
    const cover = r.images.find((i) => i?.isCover) ?? r.images[0];
    if (cover?.image && typeof cover.image === "string") image_url = cover.image;
  }

  // Category: prefer the most specific level ShopMy gives us.
  const category =
    r.Category_name ||
    r.Department_name ||
    r.Industry_name ||
    null;

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
