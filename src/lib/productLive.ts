/**
 * Live product link resolution via Serper Shopping API.
 *
 * Behavior matrix:
 *
 *   brand                                   | Serper called? | result
 *   --------------------------------------- | -------------- | -----------------
 *   luxury (in LUXURY_BRANDS)               | NO             | (caller routes
 *                                                              to Mytheresa)
 *   mass brand (in BRAND_DOMAINS) with      | YES            | real product URL
 *     Serper hit on brand's own domain                         + price + image
 *   mass brand, Serper hit NOT on brand     | YES            | brand-own-site
 *     domain                                                   search URL
 *                                                              (per user rule:
 *                                                              never link a
 *                                                              random reseller)
 *   unknown brand, Serper has results       | YES            | first result
 *   unknown brand, Serper empty/failed      | YES (failed)   | Google Shopping
 *
 * Caching: in-memory Map (7-day TTL) + optional Supabase persistence.
 * Cache key is the normalized lowercased query so distinct chats sharing the
 * same product don't re-hit Serper.
 */

import { supabaseAdmin } from "./supabase";
import {
  BRAND_DOMAINS,
  LUXURY_BRANDS,
  brandOwnDomainHost,
  fallbackSearchUrl,
  normalizeBrand,
} from "./affiliateBrands";

export type LiveProduct = {
  realUrl: string | null;
  realPrice: string | null;
  realImage: string | null;
  /** True when the URL is on the brand's own canonical site. */
  brandMatched: boolean;
  /** Where the URL came from for debugging/auditing. */
  source: "serper" | "brand-search-fallback" | "google-shopping-fallback" | "luxury-skipped";
};

const SERPER_ENDPOINT = "https://google.serper.dev/shopping";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type CacheRow = { product: LiveProduct; expiresAt: number };
const memCache = new Map<string, CacheRow>();
const inflight = new Map<string, Promise<LiveProduct>>();

function cacheKey(brand: string | undefined, productName: string): string {
  return `${normalizeBrand(brand)}|${(productName ?? "").trim().toLowerCase()}`;
}

async function readPersistentCache(key: string): Promise<LiveProduct | null> {
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("product_link_cache")
      .select("real_url, real_price, real_image, brand_matched, source, created_at")
      .eq("query", key)
      .maybeSingle();
    if (error || !data) return null;
    const age = Date.now() - new Date(data.created_at as string).getTime();
    if (age > CACHE_TTL_MS) return null;
    return {
      realUrl: (data.real_url as string | null) ?? null,
      realPrice: (data.real_price as string | null) ?? null,
      realImage: (data.real_image as string | null) ?? null,
      brandMatched: Boolean(data.brand_matched),
      source:
        (data.source as LiveProduct["source"]) ?? "serper",
    };
  } catch {
    return null;
  }
}

async function writePersistentCache(key: string, p: LiveProduct) {
  try {
    const sb = supabaseAdmin();
    await sb.from("product_link_cache").upsert(
      {
        query: key,
        real_url: p.realUrl,
        real_price: p.realPrice,
        real_image: p.realImage,
        brand_matched: p.brandMatched,
        source: p.source,
        created_at: new Date().toISOString(),
      },
      { onConflict: "query" }
    );
  } catch {
    // Missing table or any other error — fine, in-memory cache covers us.
  }
}

type SerperItem = {
  title?: string;
  source?: string;
  link?: string;
  price?: string;
  imageUrl?: string;
};

async function callSerper(query: string): Promise<SerperItem[]> {
  const key = process.env.SERPER_API_KEY;
  if (!key) return [];
  try {
    const res = await fetch(SERPER_ENDPOINT, {
      method: "POST",
      headers: {
        "X-API-KEY": key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q: query, gl: "us" }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { shopping?: SerperItem[] };
    return Array.isArray(data.shopping) ? data.shopping : [];
  } catch {
    return [];
  }
}

function urlHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function isOnBrandDomain(
  link: string | undefined,
  brand: string
): boolean {
  if (!link) return false;
  const host = urlHost(link);
  if (!host) return false;
  const brandHost = brandOwnDomainHost(brand);
  if (!brandHost) return false;
  return host === brandHost || host.endsWith(`.${brandHost}`);
}

/**
 * Public API. Returns the live product info for an off-feed mass-brand
 * recommendation. Returns null for luxury brands (caller should route to
 * Mytheresa).
 */
export async function resolveProductLive(
  brand: string | undefined,
  productName: string
): Promise<LiveProduct> {
  const normalized = normalizeBrand(brand);
  const fallback = (
    source: LiveProduct["source"]
  ): LiveProduct => ({
    realUrl: fallbackSearchUrl(brand, productName),
    realPrice: null,
    realImage: null,
    brandMatched: false,
    source,
  });

  if (normalized && LUXURY_BRANDS.has(normalized)) {
    return {
      realUrl: null,
      realPrice: null,
      realImage: null,
      brandMatched: false,
      source: "luxury-skipped",
    };
  }

  const key = cacheKey(brand, productName);
  const now = Date.now();
  const mem = memCache.get(key);
  if (mem && mem.expiresAt > now) return mem.product;
  const existing = inflight.get(key);
  if (existing) return existing;

  const p = (async () => {
    const persisted = await readPersistentCache(key);
    if (persisted) {
      memCache.set(key, { product: persisted, expiresAt: now + CACHE_TTL_MS });
      return persisted;
    }

    const query = [brand, productName].filter(Boolean).join(" ").trim();
    const results = await callSerper(query);

    let chosen: SerperItem | null = null;
    const hasBrandDomain =
      !!normalized && Boolean(BRAND_DOMAINS[normalized]);

    if (hasBrandDomain) {
      chosen =
        results.find((r) => isOnBrandDomain(r.link, normalized)) ?? null;
      if (!chosen) {
        // Per luxury guardrail / mass-brand rule: never link a random
        // reseller. Fall back to the brand's own searchable site.
        const product: LiveProduct = fallback("brand-search-fallback");
        memCache.set(key, { product, expiresAt: now + CACHE_TTL_MS });
        await writePersistentCache(key, product);
        return product;
      }
    } else {
      chosen = results[0] ?? null;
    }

    if (!chosen || !chosen.link) {
      const product = fallback("google-shopping-fallback");
      memCache.set(key, { product, expiresAt: now + CACHE_TTL_MS });
      await writePersistentCache(key, product);
      return product;
    }

    // Reject base64 data: image URLs — they can't go through /api/img
    // (which only accepts http/https). Null lets the client fall back to
    // the lazy Bing lookup, which usually finds a clean http image anyway.
    const serperImg = typeof chosen.imageUrl === "string" ? chosen.imageUrl : null;
    const realImage =
      serperImg && /^https?:\/\//i.test(serperImg) ? serperImg : null;

    const product: LiveProduct = {
      realUrl: chosen.link,
      realPrice: chosen.price ?? null,
      realImage,
      brandMatched: isOnBrandDomain(chosen.link, normalized),
      source: "serper",
    };
    memCache.set(key, { product, expiresAt: now + CACHE_TTL_MS });
    await writePersistentCache(key, product);
    return product;
  })();
  inflight.set(key, p);
  p.finally(() => inflight.delete(key));
  return p;
}

/**
 * Returns the URL unwrapped. The platform no longer routes off-catalog
 * merchant URLs through any affiliate aggregator: creators keep 100% of
 * affiliate revenue via their own feed-tier URLs, and AskMai monetizes
 * on user subscriptions. The function signature is retained as a no-op
 * so call sites continue to compile; `wrapped` is always false.
 */
export function wrapIfInNetwork(url: string, _creatorSlug: string): {
  url: string;
  wrapped: boolean;
} {
  return { url, wrapped: false };
}
