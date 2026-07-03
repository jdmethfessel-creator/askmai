/**
 * Retrieval core (B3, fixed).
 *
 * parseQuery: deterministic query parser. No model call, no I/O.
 * searchProducts: hard-filtered SQL against creator_products.
 *   Structured attributes are HARD filters. Text similarity only
 *   ranks what survives.
 *
 * Load-bearing fix from the previous version: when the attributes
 * column doesn't exist yet OR any structured filter (category,
 * colors, priceMax) is set, we NEVER silently drop the filter and
 * fall back to a filter-less scan. That was returning the whole
 * catalog for a "jeans" query. The new fallback:
 *   - If attributes column missing AND caller passed structured
 *     filters, return empty exact (honest: we cannot honor the
 *     ask), so callers render the "no true X in this closet" copy.
 *   - Only fall back to unfiltered text search when the caller
 *     asked for freeText-only with no structured filters.
 */

import { supabaseAdmin } from "./supabase";
import {
  BLUE_FAMILY,
  CATEGORY_SYNONYMS,
  COLOR_SYNONYMS,
  type Category,
  type Color,
} from "./taxonomy";

export type ParsedQuery = {
  category: Category | null;
  colors: Color[];
  priceMax: number | null;
  freeText: string;
  raw: string;
};

const PRICE_PATTERNS: RegExp[] = [
  /\bunder\s*\$?\s*(\d{1,4})\b/i,
  /\bless\s+than\s*\$?\s*(\d{1,4})\b/i,
  /\bsub\s*\$?\s*(\d{1,4})\b/i,
  /\b\$?\s*(\d{1,4})\s*(?:or|and)\s*(?:under|less)\b/i,
  /\b(?:below|beneath)\s*\$?\s*(\d{1,4})\b/i,
  /\b\$\s*(\d{1,4})\s*(?:ceiling|max|cap)\b/i,
];

const STOP_WORDS = new Set([
  "the","a","an","some","any","of","and","or","for","with","to","in","on",
  "at","by","from","that","these","those","is","are","be","would","should",
  "could","have","has","i","me","my","you","your","she","he","her","him",
  "his","its","it","we","us","our","them","they","this","piece","pieces",
]);

function normalizeToken(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

export function parseQuery(raw: string): ParsedQuery {
  const q = String(raw ?? "").trim();
  let remaining = q;

  let priceMax: number | null = null;
  for (const rx of PRICE_PATTERNS) {
    const m = remaining.match(rx);
    if (m) {
      priceMax = Number(m[1]);
      remaining = remaining.replace(rx, " ");
      break;
    }
  }

  let category: Category | null = null;
  const lower = remaining.toLowerCase();
  const multiWordSynonyms = Object.keys(CATEGORY_SYNONYMS)
    .filter((k) => k.includes(" "))
    .sort((a, b) => b.length - a.length);
  for (const key of multiWordSynonyms) {
    if (lower.includes(key)) {
      category = CATEGORY_SYNONYMS[key];
      const rx = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      remaining = remaining.replace(rx, " ");
      break;
    }
  }

  const tokens = remaining
    .split(/[\s,]+/)
    .map(normalizeToken)
    .filter((t) => t.length > 0);

  const colors = new Set<Color>();
  const consumed = new Set<number>();

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!category) {
      const cat = CATEGORY_SYNONYMS[t];
      if (cat) {
        category = cat;
        consumed.add(i);
        continue;
      }
    }
    const color = COLOR_SYNONYMS[t];
    if (color) {
      colors.add(color);
      consumed.add(i);
    }
  }

  const rawLower = q.toLowerCase();
  if (/\bdenim\b/.test(rawLower) || /\bdark[-\s]?wash\b/.test(rawLower)) {
    for (const c of BLUE_FAMILY) colors.add(c);
  }

  const freeText = tokens
    .filter((_, i) => !consumed.has(i))
    .filter((t) => !STOP_WORDS.has(t))
    .join(" ")
    .trim();

  return {
    category,
    colors: Array.from(colors),
    priceMax,
    freeText,
    raw: q,
  };
}

export type SearchProduct = {
  id: string;
  creator_id: string;
  source_network: string;
  product_title: string;
  brand: string | null;
  price: number | null;
  price_display: string | null;
  image_url: string;
  affiliate_url: string;
  product_category: string | null;
  product_subcategory: string | null;
  attributes?: {
    category?: string | null;
    colors?: string[];
    materials?: string[];
    styles?: string[];
  } | null;
};

export type AppliedFilters = {
  category: Category | null;
  colors: Color[];
  priceMax: number | null;
};

export type SearchResult = SearchProduct & { nearest?: boolean };

export type SearchResponse = {
  exact: SearchResult[];
  nearest: SearchResult[];
  applied: AppliedFilters;
  is_relaxed: boolean;
  attributes_available: boolean;
};

export type SearchArgs = {
  creatorSlug: string;
  category?: Category | null;
  colors?: Color[];
  priceMax?: number | null;
  freeText?: string;
  limit?: number;
};

/**
 * Hard-filtered search. Returns SearchResponse so the caller can
 * render chips for the filters actually APPLIED (which is category
 * on exact, plus color when the strict pass produced >= 3, and
 * priceMax always), and knows whether the closet has an attributes
 * column at all.
 */
export async function searchProducts(args: SearchArgs): Promise<SearchResponse> {
  const sb = supabaseAdmin();
  const creator = await sb
    .from("creators")
    .select("id")
    .eq("slug", args.creatorSlug)
    .maybeSingle();
  const requestedFilters: AppliedFilters = {
    category: args.category ?? null,
    colors: args.colors ?? [],
    priceMax: args.priceMax ?? null,
  };
  if (!creator.data) {
    return {
      exact: [],
      nearest: [],
      applied: requestedFilters,
      is_relaxed: false,
      attributes_available: false,
    };
  }
  const creatorId = creator.data.id;
  const limit = args.limit ?? 40;

  const hasStructured = Boolean(
    args.category || (args.colors && args.colors.length > 0)
  );

  const attributesAvailable = await probeAttributes(sb, creatorId);

  if (!attributesAvailable) {
    if (hasStructured) {
      return {
        exact: [],
        nearest: [],
        applied: requestedFilters,
        is_relaxed: false,
        attributes_available: false,
      };
    }
    const rows = await runTextOnly({
      sb,
      creatorId,
      priceMax: args.priceMax ?? null,
      freeText: args.freeText ?? "",
      limit,
    });
    return {
      exact: rows.map((r) => ({ ...r, nearest: false })),
      nearest: [],
      applied: {
        category: null,
        colors: [],
        priceMax: args.priceMax ?? null,
      },
      is_relaxed: false,
      attributes_available: false,
    };
  }

  const exactRows = await runStructured({
    sb,
    creatorId,
    category: args.category ?? null,
    colors: args.colors ?? [],
    priceMax: args.priceMax ?? null,
    freeText: args.freeText ?? "",
    limit,
  });

  const strictSufficient = exactRows.length >= 3;
  if (strictSufficient || !(args.colors && args.colors.length > 0)) {
    return {
      exact: exactRows.map((r) => ({ ...r, nearest: false })),
      nearest: [],
      applied: requestedFilters,
      is_relaxed: false,
      attributes_available: true,
    };
  }

  const relaxedRows = await runStructured({
    sb,
    creatorId,
    category: args.category ?? null,
    colors: [],
    priceMax: args.priceMax ?? null,
    freeText: args.freeText ?? "",
    limit,
  });
  const nearest = relaxedRows.filter(
    (r) => !exactRows.find((e) => e.id === r.id)
  );

  return {
    exact: exactRows.map((r) => ({ ...r, nearest: false })),
    nearest: nearest.map((r) => ({ ...r, nearest: true })),
    applied: {
      category: args.category ?? null,
      colors: [],
      priceMax: args.priceMax ?? null,
    },
    is_relaxed: true,
    attributes_available: true,
  };
}

const BASE_COLS =
  "id, creator_id, source_network, product_title, brand, price, price_display, image_url, affiliate_url, product_category, product_subcategory";
const ATTR_COLS = `${BASE_COLS}, attributes`;

const attributesCache = new Map<string, boolean>();

async function probeAttributes(
  sb: ReturnType<typeof supabaseAdmin>,
  creatorId: string
): Promise<boolean> {
  const cached = attributesCache.get(creatorId);
  if (typeof cached === "boolean") return cached;
  const { error } = await sb
    .from("creator_products")
    .select("attributes")
    .eq("creator_id", creatorId)
    .limit(1);
  const ok = !error;
  if (!ok && (error as { code?: string }).code !== "42703") {
    console.warn("[search] attribute probe error:", error?.message);
  }
  attributesCache.set(creatorId, ok);
  return ok;
}

type StructuredArgs = {
  sb: ReturnType<typeof supabaseAdmin>;
  creatorId: string;
  category: Category | null;
  colors: Color[];
  priceMax: number | null;
  freeText: string;
  limit: number;
};

async function runStructured(args: StructuredArgs): Promise<SearchProduct[]> {
  let q = args.sb
    .from("creator_products")
    .select(ATTR_COLS)
    .eq("creator_id", args.creatorId)
    .limit(args.limit);
  if (args.category) {
    q = q.eq("attributes->>category", args.category);
  }
  if (args.colors.length > 0) {
    q = q.overlaps("attributes->colors", args.colors);
  }
  if (args.priceMax != null) {
    q = q.lte("price", args.priceMax);
  }
  if (args.freeText) {
    q = q.ilike("product_title", `%${args.freeText}%`);
  }
  q = q.order("created_at", { ascending: false });
  const { data, error } = await q;
  if (error) {
    console.warn("[search] structured query error:", error.message);
    return [];
  }
  return (data as unknown as SearchProduct[] | null) ?? [];
}

type TextOnlyArgs = {
  sb: ReturnType<typeof supabaseAdmin>;
  creatorId: string;
  priceMax: number | null;
  freeText: string;
  limit: number;
};

async function runTextOnly(args: TextOnlyArgs): Promise<SearchProduct[]> {
  let q = args.sb
    .from("creator_products")
    .select(BASE_COLS)
    .eq("creator_id", args.creatorId)
    .limit(args.limit);
  if (args.priceMax != null) {
    q = q.lte("price", args.priceMax);
  }
  if (args.freeText) {
    q = q.ilike("product_title", `%${args.freeText}%`);
  }
  q = q.order("created_at", { ascending: false });
  const { data, error } = await q;
  if (error) {
    console.warn("[search] text-only query error:", error.message);
    return [];
  }
  return (data as unknown as SearchProduct[] | null) ?? [];
}
