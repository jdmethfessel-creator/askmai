/**
 * Retrieval core (B3).
 *
 * parseQuery: deterministic query parser. No model call, no I/O.
 *   Extracts colors, category, price ceiling from raw text using the
 *   fixed taxonomies in ./taxonomy. Remaining words become freeText.
 *
 * searchProducts: hard-filtered SQL against creator_products.
 *   Structured attributes are HARD filters (creator, category, colors,
 *   price). Text similarity only ranks what survives the filters.
 *   When strict filters return fewer than 3 results, a relaxed pass
 *   (category kept, color dropped) is run and its rows come back
 *   flagged nearest: true. Exact and nearest are never silently mixed.
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

/**
 * Parse a raw user query into hard filters + freeText. Deterministic.
 *
 * The denim/dark-wash rule: if either token appears WITHOUT a jeans-
 * category token, the parser still promotes it into the blue family
 * so a search like "denim jacket" filters correctly on jacket +
 * blue; when jeans is present it counts as color=blue.
 */
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

  // Category detection: scan multi-word synonyms first, then singles.
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

  // Denim/dark-wash special-case: whether or not category was set,
  // ensure blue-family coverage sits in the color filter.
  const rawLower = q.toLowerCase();
  if (/\bdenim\b/.test(rawLower) || /\bdark[-\s]?wash\b/.test(rawLower)) {
    for (const c of BLUE_FAMILY) colors.add(c);
    // Denim implies jeans only when no other category was identified.
    if (!category && /\bdenim\b/.test(rawLower)) {
      // If jeans wasn't the token, keep category null so the caller
      // can still see freeText contributions.
    }
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

export type SearchResult = SearchProduct & { nearest?: boolean };

export type SearchArgs = {
  creatorSlug: string;
  category?: Category | null;
  colors?: Color[];
  priceMax?: number | null;
  freeText?: string;
  limit?: number;
};

/**
 * Hard-filtered search against creator_products. Falls back to a
 * relaxed pass (color dropped, category kept) when the strict pass
 * returns fewer than 3 rows.
 *
 * Degrades gracefully:
 *   - If the `attributes` column doesn't exist, retries without the
 *     color/category filters and returns text-similarity results
 *     scoped only by creator and price. Rows still come back valid.
 *   - If search_text tsvector doesn't exist, ILIKE fallback covers
 *     the freeText term.
 */
export async function searchProducts(args: SearchArgs): Promise<SearchResult[]> {
  const sb = supabaseAdmin();
  const creator = await sb
    .from("creators")
    .select("id")
    .eq("slug", args.creatorSlug)
    .maybeSingle();
  if (!creator.data) return [];
  const creatorId = creator.data.id;

  const limit = args.limit ?? 40;

  const runStrict = async (dropColors: boolean) => {
    const rows = await runQuery({
      sb,
      creatorId,
      category: args.category ?? null,
      colors: dropColors ? [] : args.colors ?? [],
      priceMax: args.priceMax ?? null,
      freeText: args.freeText ?? "",
      limit,
    });
    return rows;
  };

  const exact = await runStrict(false);
  if (exact.length >= 3 || !(args.colors && args.colors.length > 0)) {
    return exact.map((r) => ({ ...r, nearest: false }));
  }

  const relaxed = await runStrict(true);
  const nearest = relaxed.filter((r) => !exact.find((e) => e.id === r.id));
  return [
    ...exact.map((r) => ({ ...r, nearest: false })),
    ...nearest.map((r) => ({ ...r, nearest: true })),
  ];
}

type RunQueryArgs = {
  sb: ReturnType<typeof supabaseAdmin>;
  creatorId: string;
  category: Category | null;
  colors: Color[];
  priceMax: number | null;
  freeText: string;
  limit: number;
};

const BASE_COLS =
  "id, creator_id, source_network, product_title, brand, price, price_display, image_url, affiliate_url, product_category, product_subcategory";
const ATTR_COLS = `${BASE_COLS}, attributes`;

async function runQuery(args: RunQueryArgs): Promise<SearchProduct[]> {
  const { sb, creatorId, category, colors, priceMax, freeText, limit } = args;

  const primary = await tryQuery(sb, {
    cols: ATTR_COLS,
    creatorId,
    category,
    colors,
    priceMax,
    freeText,
    limit,
  });
  if (primary.ok) return primary.rows;

  // Attribute columns missing (fresh env). Fall back to a text-only
  // scoped search.
  const fallback = await tryQuery(sb, {
    cols: BASE_COLS,
    creatorId,
    category: null,
    colors: [],
    priceMax,
    freeText,
    limit,
  });
  return fallback.rows;
}

type TryArgs = {
  cols: string;
  creatorId: string;
  category: Category | null;
  colors: Color[];
  priceMax: number | null;
  freeText: string;
  limit: number;
};

async function tryQuery(
  sb: ReturnType<typeof supabaseAdmin>,
  args: TryArgs
): Promise<{ ok: boolean; rows: SearchProduct[] }> {
  let q = sb
    .from("creator_products")
    .select(args.cols)
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
    // ILIKE on product_title. Cheap, robust, doesn't require the
    // tsvector column to exist yet. Once search_text is populated the
    // caller-side ranking is stable enough.
    q = q.ilike("product_title", `%${args.freeText}%`);
  }
  q = q.order("created_at", { ascending: false });
  const { data, error } = await q;
  if (error) {
    if ((error as { code?: string }).code === "42703") {
      return { ok: false, rows: [] };
    }
    console.warn("[search] query error:", error.message);
    return { ok: true, rows: [] };
  }
  return {
    ok: true,
    rows: (data as unknown as SearchProduct[] | null) ?? [],
  };
}
