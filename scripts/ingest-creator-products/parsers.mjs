// Network-agnostic ingestion parsers. Each parser takes the source URL
// + the fetched HTML and returns a normalized array of products. All
// affiliate URL composition lives here, in one place per network, so a
// future audit of "what query params survived" is reading one file.
//
// THE STORED affiliate_url IS BYTE-FOR-BYTE WHAT THE PHASE 2 SHOP
// BUTTON OPENS. Do not normalize, sort, or strip query params anywhere
// downstream of this file. The test at
// scripts/ingest-creator-products/test-affiliate-preservation.mjs
// asserts this invariant per source page.
//
// Network detection:
//   detectNetwork(url) returns one of 'shopbop' | 'revolve' | 'fwrd' |
//   'shopmy' | null. Drives the dispatch in parsers/parse().

import { fetchHtml } from "./fetch.mjs";
import { deriveSubcategory } from "./categorize.mjs";

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

// Pluck the affiliate-relevant query params from a page URL. The
// per-network parsers each declare which params on the page URL
// represent the creator's attribution (Shopbop's LinkShare bundle,
// Revolve/FWRD's ambassador/utm bundle). Anything outside that set is
// ignored so we don't bloat product links with stale referrers.
function pickPageParams(pageUrl, keepKeys) {
  const u = new URL(pageUrl);
  const out = new URLSearchParams();
  for (const key of keepKeys) {
    const vals = u.searchParams.getAll(key);
    for (const v of vals) out.append(key, v);
  }
  return out;
}

// Compose a product affiliate URL by joining an origin + product path
// with the page-level affiliate params. Per-product hrefs may already
// carry context (Revolve's siplt on the card link, for example);
// page-level params are appended without removing the existing ones,
// matching the user's "never strip" rule.
function composeAffiliateUrl(origin, productPath, pageParams) {
  // Decode entities the parsers may pass through from raw HTML.
  const cleanPath = productPath.replaceAll("&amp;", "&");
  const full = new URL(cleanPath, origin);
  // Append page params one-by-one so duplicates are preserved exactly.
  for (const [k, v] of pageParams.entries()) full.searchParams.append(k, v);
  return full.toString();
}

function parsePriceNumber(display) {
  if (!display) return null;
  const m = String(display).replace(/[, ]/g, "").match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

// Loose category guess used as a last resort when the source page
// doesn't expose a taxonomy. The chat pipeline's category vocabulary
// is 'fashion' | 'beauty' | 'accessories' | 'lifestyle' | 'travel' |
// 'dining' — defaulting to 'fashion' for these creators since hearts /
// wishlists are clothing-led.
function inferCategory({ titleHint = "", brandHint = "" } = {}) {
  const h = `${titleHint} ${brandHint}`.toLowerCase();
  if (/(serum|cream|moisturizer|sunscreen|spf|lipstick|mascara|fragrance|perfume)/.test(h))
    return "beauty";
  if (/(bag|tote|clutch|earring|necklace|ring|bracelet|sunglass|belt|hat|scarf|wallet)/.test(h))
    return "accessories";
  if (/(candle|vase|throw|pillow|towel|sheet|mug|tray|home|kitchen)/.test(h))
    return "lifestyle";
  return "fashion";
}

// ---------------------------------------------------------------------
// Shopbop hearts
//
// The hearts page ships a hydration JSON blob in a script tag
// (window.__shopbop_sca_hydrate__). The product list lives under the
// react-query cache at:
//
//   dehydratedState.frameworkState.dd.renderTree.topLevelSlots
//     .plp-main.content.slotConfiguration.squareState
//     .props.dehydratedState.queries[1].state.data.data.products
//
// The path is brittle to upstream layout changes, so the parser
// walks the JSON for "products with .product.shortDescription" rather
// than hard-coding the path.
//
// Page-level affiliate params: extid, cvosrc, affuid, sharedid, subid1
// (Shopbop's LinkShare/Rakuten bundle).
// ---------------------------------------------------------------------

const SHOPBOP_AFFILIATE_KEYS = ["extid", "cvosrc", "affuid", "sharedid", "subid1"];
const SHOPBOP_ORIGIN = "https://www.shopbop.com";
const SHOPBOP_IMAGE_ORIGIN = "https://m.media-amazon.com/images/I"; // unused
const SHOPBOP_PRODUCT_IMAGE_ORIGIN = "https://m.media-amazon.com/images/G/01/Shopbop";

function extractHydrateBlob(html) {
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
  let scriptText = null;
  let m;
  while ((m = scriptRe.exec(html)) !== null) {
    if (m[1].includes("__shopbop_sca_hydrate__") && m[1].includes("shortDescription")) {
      scriptText = m[1];
      break;
    }
  }
  if (!scriptText) throw new Error("Shopbop: hydrate blob not found");
  const idx = scriptText.indexOf("window.__shopbop_sca_hydrate__=");
  const afterEq = scriptText.slice(idx + "window.__shopbop_sca_hydrate__=".length);
  // Balanced-brace extraction; string-aware so a `}` inside a string
  // doesn't trick us.
  let depth = 0,
    end = -1,
    inStr = false,
    esc = false;
  for (let i = 0; i < afterEq.length; i++) {
    const c = afterEq[i];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c === "\\") {
        esc = true;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) throw new Error("Shopbop: hydrate blob unbalanced");
  return JSON.parse(afterEq.slice(0, end));
}

function walkForProducts(o, depth = 0, found = []) {
  // Shopbop's dehydrated react-query cache nests the products list ~17
  // levels deep (dehydratedState → frameworkState → dd → renderTree →
  // topLevelSlots → plp-main → content → slotConfiguration →
  // squareState → props → dehydratedState → queries → [n] → state →
  // data → data → products). Keep this limit generous.
  if (depth > 24 || !o) return found;
  if (Array.isArray(o)) {
    if (o[0]?.product?.shortDescription) found.push(o);
    o.forEach((v) => walkForProducts(v, depth + 1, found));
    return found;
  }
  if (typeof o === "object") {
    for (const v of Object.values(o)) walkForProducts(v, depth + 1, found);
  }
  return found;
}

export function parseShopbop({ html, pageUrl }) {
  const json = extractHydrateBlob(html);
  // The first qualifying array IS the hearts list. If the page ever
  // grows a "you might also like" rail driven by the same shape we'd
  // need to disambiguate; today there is only one such array.
  const arrays = walkForProducts(json);
  if (arrays.length === 0)
    throw new Error("Shopbop: no products array found in hydrate cache");
  const products = arrays[0];

  const pageParams = pickPageParams(pageUrl, SHOPBOP_AFFILIATE_KEYS);

  return products.map((row) => {
    const p = row.product;
    const color = (p.colors && p.colors[0]) || null;
    const imgEntry = color?.imagesWithMetadata?.[0]?.src;
    const image_url = imgEntry
      ? `${SHOPBOP_PRODUCT_IMAGE_ORIGIN}${imgEntry}`
      : null;
    const priceDisplay = p.retailPrice?.price ?? null;
    const priceNum = p.retailPrice?.usdPrice ?? parsePriceNumber(priceDisplay);

    const affiliate_url = composeAffiliateUrl(
      SHOPBOP_ORIGIN,
      p.productDetailUrl,
      pageParams
    );

    const product_category = inferCategory({
      titleHint: p.shortDescription,
      brandHint: p.designerName,
    });
    return {
      source_network: "shopbop",
      source_external_id: String(p.productSin),
      product_title: p.shortDescription,
      brand: p.designerName || null,
      price: priceNum,
      price_display: priceDisplay,
      image_url,
      affiliate_url,
      product_category,
      product_subcategory: deriveSubcategory({
        title: p.shortDescription,
        brand: p.designerName,
        topLevelCategory: product_category,
      }),
      raw: { productCode: p.productCode, productSin: p.productSin },
      ingested_from: pageUrl,
    };
  });
}

// ---------------------------------------------------------------------
// Revolve favorites
//
// Server-rendered HTML. Each product is a <a class="...product-link"
// href="/.../dp/SKU/?d=...&siplt=...">, with siblings holding
// .js-plp-name (title), .js-plp-brand (brand), .price__retail
// (display price), and an image at
// is4.revolveassets.com/images/p4/n/tv/SKU_V1.jpg.
//
// The card href already carries `siplt=296d0` (the ambassador's
// session ID). The full ambassador attribution also wants the page-
// level utm_source=rev_ambassador / utm_medium / utm_campaign bundle,
// so we append those.
// ---------------------------------------------------------------------

const REVOLVE_AFFILIATE_KEYS = [
  "source",
  "siplt",
  "utm_source",
  "utm_medium",
  "utm_campaign",
];
const REVOLVE_ORIGIN = "https://www.revolve.com";
const REVOLVE_IMAGE_ORIGIN = "https://is4.revolveassets.com/images/p4/n/tv";

export function parseRevolve({ html, pageUrl }) {
  // Match each product-link anchor; capture href + SKU. The anchor
  // wraps name/brand/price inside its own block, so we read forward
  // until the closing </a> for each match.
  const cardRe =
    /<a\s+href="(\/[^"]+\/dp\/([A-Z]+-[A-Z0-9]+)\/[^"]*)"[^>]*class="[^"]*product-link[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const pageParams = pickPageParams(pageUrl, REVOLVE_AFFILIATE_KEYS);

  const out = [];
  let m;
  while ((m = cardRe.exec(html)) !== null) {
    const [, href, sku, inner] = m;
    const name = inner.match(/class="[^"]*js-plp-name[^"]*"[^>]*>([^<]+)</)?.[1]?.trim();
    const brand = inner.match(/class="[^"]*js-plp-brand[^"]*"[^>]*>([^<]+)</)?.[1]?.trim();
    const priceDisplay =
      inner.match(/class="[^"]*price__retail[^"]*"[^>]*>([^<]+)</)?.[1]?.trim() ||
      inner.match(/class="[^"]*plp_price[^"]*"[^>]*>([^<]+)</)?.[1]?.trim();
    if (!name) continue;

    const affiliate_url = composeAffiliateUrl(REVOLVE_ORIGIN, href, pageParams);
    const image_url = `${REVOLVE_IMAGE_ORIGIN}/${sku}_V1.jpg`;

    const product_category = inferCategory({ titleHint: name, brandHint: brand });
    out.push({
      source_network: "revolve",
      source_external_id: sku,
      product_title: name,
      brand: brand || null,
      price: parsePriceNumber(priceDisplay),
      price_display: priceDisplay || null,
      image_url,
      affiliate_url,
      product_category,
      product_subcategory: deriveSubcategory({
        title: name,
        brand,
        topLevelCategory: product_category,
      }),
      raw: { sku, href: href.replaceAll("&amp;", "&") },
      ingested_from: pageUrl,
    });
  }
  return out;
}

// ---------------------------------------------------------------------
// FWRD wishlist (PublicWishListView.jsp)
//
// Server-rendered HTML. Each wishlist entry is a <div
// class="grid__col u-margin-t--xxl"> containing:
//   - <a href="/fw/DisplayProduct.jsp?code=SKU"> (image link)
//   - .product-titles__brand  (brand)
//   - .product-titles__name--sm (title)
//   - .prices__retail (display price)
//   - Some items also have a button with data-name / data-price /
//     data-imageUrl / data-brandName / data-url / data-cat1 — we read
//     those when present because they're the most reliable signal
//     (full product URL slug rather than the DisplayProduct.jsp
//     redirect).
//
// FWRD product hrefs are bare — `/fw/DisplayProduct.jsp?code=SKU` or
// `/product-slug/SKU/?d=Womens`. The page-level affiliate context
// (source=siplt&siplt=296d0&utm_source=rev_ambassador&utm_medium=
// ambassador&utm_campaign=glob_b_296d0) is what gives Cass credit at
// click time. Append the full bundle.
// ---------------------------------------------------------------------

const FWRD_AFFILIATE_KEYS = [
  "source",
  "siplt",
  "utm_source",
  "utm_medium",
  "utm_campaign",
];
const FWRD_ORIGIN = "https://www.fwrd.com";
const FWRD_IMAGE_ORIGIN = "https://is4.fwrdassets.com/images/p/fw/p";

export function parseFwrd({ html, pageUrl }) {
  // Each wishlist cell. Stop at the next grid__col or end of section.
  const cellRe =
    /<div class="grid__col u-margin-t--xxl">([\s\S]*?)(?=<div class="grid__col u-margin-t--xxl">|<\/section>|<footer)/g;
  const pageParams = pickPageParams(pageUrl, FWRD_AFFILIATE_KEYS);

  const out = [];
  let m;
  while ((m = cellRe.exec(html)) !== null) {
    const inner = m[1];
    const code = inner.match(/DisplayProduct\.jsp\?code=([A-Z0-9-]+)/)?.[1];
    if (!code) continue;

    // Prefer the button's data-attrs when present (more reliable URL).
    const btnUrl = inner.match(/data-url="([^"]+)"/)?.[1];
    const btnName = inner.match(/data-name="([^"]+)"/)?.[1];
    const btnBrand = inner.match(/data-brandName="([^"]+)"/)?.[1];
    const btnImage = inner.match(/data-imageUrl="([^"]+)"/)?.[1];
    const btnPrice = inner.match(/data-price="([^"]+)"/)?.[1];
    const btnCat1 = inner.match(/data-cat1="([^"]+)"/)?.[1];

    const title =
      btnName ||
      inner.match(/class="product-titles__name--sm[^"]*"[^>]*>([^<]+)</)?.[1]?.trim();
    const brand =
      btnBrand ||
      inner.match(/class="product-titles__brand[^"]*"[^>]*>([^<]+)</)?.[1]?.trim();
    const priceDisplay = inner
      .match(/class="prices__retail[^"]*"[^>]*>([^<]+)</)?.[1]
      ?.trim();
    if (!title) continue;

    // Build product path. The button's data-url is the canonical slug
    // path (`/product-jordan-road-...-bangle-set-.../JORF-WL116/?d=Womens`);
    // fall back to the DisplayProduct redirect URL.
    const productPath = btnUrl || `/fw/DisplayProduct.jsp?code=${code}`;
    const affiliate_url = composeAffiliateUrl(FWRD_ORIGIN, productPath, pageParams);
    const image_url = btnImage || `${FWRD_IMAGE_ORIGIN}/${code}_V1.jpg`;

    const product_category = btnCat1
      ? mapFwrdCategory(btnCat1)
      : inferCategory({ titleHint: title, brandHint: brand });
    out.push({
      source_network: "fwrd",
      source_external_id: code,
      product_title: title,
      brand: brand || null,
      price: parsePriceNumber(btnPrice || priceDisplay),
      price_display: priceDisplay || (btnPrice ? `$${btnPrice}` : null),
      image_url,
      affiliate_url,
      product_category,
      product_subcategory: deriveSubcategory({
        title,
        brand,
        fwrdCat1: btnCat1,
        topLevelCategory: product_category,
      }),
      raw: { code, cat1: btnCat1 || null },
      ingested_from: pageUrl,
    });
  }
  return out;
}

function mapFwrdCategory(cat1) {
  const c = cat1.toLowerCase();
  if (c.startsWith("jewelry") || c.includes("bag") || c.includes("shoe") || c.includes("accessor"))
    return "accessories";
  if (c.includes("beauty")) return "beauty";
  if (c.includes("home")) return "lifestyle";
  return "fashion";
}

// ---------------------------------------------------------------------
// CSV ingestion. Format: header row with these required columns:
//
//   product_title, image_url, affiliate_url
//
// Optional: brand, price, price_display, product_category,
// source_external_id, source_network (defaults to "csv").
//
// The affiliate_url column is stored EXACTLY as written — the CSV is
// the user's authoritative input. Wrap fields with double quotes if
// they contain commas; we do not interpret backslash escapes (RFC 4180
// double-quote escaping only).
// ---------------------------------------------------------------------

export function parseCsv({ text, sourceLabel = "csv" }) {
  const rows = csvToRows(text);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  const required = ["product_title", "image_url", "affiliate_url"];
  for (const r of required) {
    if (!header.includes(r))
      throw new Error(`CSV missing required column: ${r}`);
  }
  const ix = Object.fromEntries(header.map((h, i) => [h, i]));
  return rows.slice(1).map((cells) => {
    const get = (k) => (ix[k] != null ? (cells[ix[k]] || "").trim() : "");
    const priceDisplay = get("price_display") || get("price");
    const title = get("product_title");
    const brand = get("brand") || null;
    const product_category =
      get("product_category") || inferCategory({ titleHint: title, brandHint: brand });
    return {
      source_network: get("source_network") || "csv",
      source_external_id: get("source_external_id") || null,
      product_title: title,
      brand,
      price: parsePriceNumber(get("price") || priceDisplay),
      price_display: priceDisplay || null,
      image_url: get("image_url"),
      affiliate_url: get("affiliate_url"),
      product_category,
      product_subcategory:
        get("product_subcategory") ||
        deriveSubcategory({ title, brand, topLevelCategory: product_category }),
      raw: null,
      ingested_from: sourceLabel,
    };
  });
}

function csvToRows(text) {
  const out = [];
  let row = [];
  let cell = "";
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        inQuote = false;
      } else {
        cell += c;
      }
    } else {
      if (c === '"') inQuote = true;
      else if (c === ",") {
        row.push(cell);
        cell = "";
      } else if (c === "\r") {
        // skip
      } else if (c === "\n") {
        row.push(cell);
        out.push(row);
        row = [];
        cell = "";
      } else {
        cell += c;
      }
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    out.push(row);
  }
  return out.filter((r) => r.some((c) => c.length > 0));
}

// ---------------------------------------------------------------------
// ShopMy. The existing scripts/ingest.mjs already pulls ShopMy public
// collections via /api/Collections/<id>. OAuth is documented but not
// implemented here; that's a Phase 1.5 follow-up that doesn't block
// the parallel try-on grid demo. For now, accept a collection id and
// reuse the public endpoint.
// ---------------------------------------------------------------------

const SHOPMY_API = "https://api.shopmy.us/api/Collections";

export async function fetchShopMyCollection({ collectionId, creatorSlug }) {
  const res = await fetch(`${SHOPMY_API}/${collectionId}`);
  if (!res.ok) throw new Error(`ShopMy ${collectionId}: HTTP ${res.status}`);
  const json = await res.json();
  const pins = Array.isArray(json.pins) ? json.pins : [];
  return pins
    .filter((p) => !p.isHidden && p.product && p.affiliate_link)
    .map((p) => {
      const affiliate_url = p.affiliate_link.replaceAll(
        "<custom_id>",
        `askmai-${creatorSlug || "creator"}`
      );
      const title = (p.product?.title || p.title || "").trim();
      const brand = (p.product?.AllBrand_name || "").trim() || null;
      const product_category = inferCategory({ titleHint: title, brandHint: brand });
      return {
        source_network: "shopmy",
        source_external_id: String(p.id),
        product_title: title,
        brand,
        price: p.product?.fallbackPrice ?? null,
        price_display: p.product?.fallbackPrice
          ? `$${p.product.fallbackPrice}`
          : null,
        image_url: p.image_url || p.product?.image_url || null,
        affiliate_url,
        product_category,
        product_subcategory: deriveSubcategory({
          title,
          brand,
          topLevelCategory: product_category,
        }),
        raw: { pinId: p.id },
        ingested_from: `shopmy:${collectionId}`,
      };
    });
}

// ---------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------

export function detectNetwork(url) {
  try {
    const h = new URL(url).hostname;
    if (h.endsWith("shopbop.com")) return "shopbop";
    if (h.endsWith("revolve.com")) return "revolve";
    if (h.endsWith("fwrd.com")) return "fwrd";
    if (h.endsWith("shopmy.us")) return "shopmy";
  } catch {}
  return null;
}

export async function ingestUrl(url) {
  const net = detectNetwork(url);
  if (!net) throw new Error(`Unknown network for URL: ${url}`);
  const html = await fetchHtml(url);
  switch (net) {
    case "shopbop":
      return parseShopbop({ html, pageUrl: url });
    case "revolve":
      return parseRevolve({ html, pageUrl: url });
    case "fwrd":
      return parseFwrd({ html, pageUrl: url });
    default:
      throw new Error(`No HTML parser for network: ${net}`);
  }
}
