/**
 * GET /api/tryon-grid/[slug]/products
 *
 * Paginated, filterable product list for the try-on grid.
 * Read-only; no auth required. (The gated action is POST /api/render
 * via the Try-On button; that endpoint runs its own session check.)
 *
 * Query params:
 *   limit       (default 40, max 100) page size
 *   cursor      ISO string from a previous response's nextCursor; rows
 *               with created_at < cursor. Omit on first page.
 *   subcategory exact match against creator_products.product_subcategory
 *               ('dresses', 'tops', ...). Special value 'all' or absent
 *               means no category filter. This comes from the pill bar
 *               and ALWAYS WINS over a subcategory parsed from `q`.
 *   q           free-text query. Parsed into structured signals
 *               (subcategory, maxPrice, descriptors) by
 *               src/lib/tryonGridSearch. Filler / unknown words are
 *               ignored (not ILIKE'd). See that module for the parse
 *               rules and the relaxation ladder.
 *
 * Returns:
 *   200 {
 *     products: Product[],
 *     nextCursor: string | null,
 *     interpreted: {
 *       subcategory: string | null,
 *       maxPrice: number | null,
 *       descriptors: string[],
 *       relaxed: 'none' | 'descriptors' | 'price' | 'subcategory' | 'all',
 *       caption: string | null,    // e.g. "Tops under $300"
 *     } | null,                    // null when q was empty
 *   }
 *   404 { error: 'creator_not_found' }
 */

import { supabaseAdmin } from "@/lib/supabase";
import { describeFilters, parseQuery, type ParsedQuery } from "@/lib/tryonGridSearch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;

type PageOpts = {
  creatorId: string;
  limit: number;
  cursor: string | null;
  pillSubcategory: string | null;
  parsedSubcategory: string | null;
  maxPrice: number | null;
  descriptors: string[];
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const url = new URL(request.url);
  const rawLimit = Number(url.searchParams.get("limit") || DEFAULT_LIMIT);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : DEFAULT_LIMIT)
  );
  const cursor = url.searchParams.get("cursor");
  const pillRaw = url.searchParams.get("subcategory");
  const pillSubcategory = pillRaw && pillRaw !== "all" ? pillRaw : null;
  const rawQ = (url.searchParams.get("q") || "").trim();

  const admin = supabaseAdmin();

  const { data: creator } = await admin
    .from("creators")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (!creator) {
    return Response.json({ error: "creator_not_found" }, { status: 404 });
  }

  // No query: the existing simple path. Pagination + pill filter only.
  if (!rawQ) {
    const { rows, nextCursor } = await fetchPage({
      creatorId: creator.id,
      limit,
      cursor,
      pillSubcategory,
      parsedSubcategory: null,
      maxPrice: null,
      descriptors: [],
    });
    return Response.json({
      products: rows,
      nextCursor,
      interpreted: null,
    });
  }

  // Query present: parse into structured signals.
  const parsed = parseQuery(rawQ);

  // The pill ALWAYS WINS over the parsed subcategory when both exist.
  // This keeps the contract obvious: a user-selected pill is an
  // explicit lock; the parsed sub is best-effort inference.
  const effectiveSubcategory = pillSubcategory ?? parsed.subcategory;

  // Relaxation ladder. Try full filter set first; if empty, drop the
  // weakest signal one rung at a time so the user sees the broadest
  // honest result instead of "no products."
  //
  // Order:
  //   1. (sub + price + descriptors)   the full intent
  //   2. drop descriptors              they're the noisiest (color
  //                                    rarely appears in product titles)
  //   3. drop price                    keep just the category
  //   4. drop parsed subcategory       only if pill didn't pin one
  //                                    (a pinned pill is a hard
  //                                    user lock; never drop it)
  //   5. give up                       return empty + caption
  const attempts: Array<{ key: "none" | "descriptors" | "price" | "subcategory" | "all"; opts: PageOpts }> = [
    {
      key: "none",
      opts: makeOpts(creator.id, limit, cursor, pillSubcategory, parsed, true, true),
    },
    {
      key: "descriptors",
      opts: makeOpts(creator.id, limit, cursor, pillSubcategory, parsed, false, true),
    },
    {
      key: "price",
      opts: makeOpts(creator.id, limit, cursor, pillSubcategory, parsed, false, false),
    },
  ];
  // Only add the "drop subcategory" rung when the parser inferred one
  // AND the pill didn't pin one. A pinned pill always survives.
  if (!pillSubcategory && parsed.subcategory) {
    attempts.push({
      key: "subcategory",
      opts: {
        ...makeOpts(creator.id, limit, cursor, null, parsed, false, false),
        parsedSubcategory: null,
      },
    });
  }

  let chosen: { key: typeof attempts[number]["key"]; rows: Product[]; nextCursor: string | null } | null = null;
  for (const attempt of attempts) {
    const { rows, nextCursor } = await fetchPage(attempt.opts);
    if (rows.length > 0) {
      chosen = { key: attempt.key, rows, nextCursor };
      break;
    }
  }

  if (!chosen) {
    return Response.json({
      products: [],
      nextCursor: null,
      interpreted: {
        subcategory: effectiveSubcategory,
        maxPrice: parsed.maxPrice,
        descriptors: parsed.descriptors,
        relaxed: "all" as const,
        caption: describeFilters({
          subcategory: effectiveSubcategory,
          maxPrice: parsed.maxPrice,
          descriptors: parsed.descriptors,
        }),
      },
    });
  }

  // Reflect the actually-applied filters back to the client so the
  // caption matches reality (e.g. "Tops" when we dropped the price).
  const appliedSub =
    chosen.key === "subcategory" ? null : effectiveSubcategory;
  const appliedPrice =
    chosen.key === "price" || chosen.key === "subcategory"
      ? null
      : parsed.maxPrice;
  const appliedDescriptors =
    chosen.key === "none" ? parsed.descriptors : [];

  return Response.json({
    products: chosen.rows,
    nextCursor: chosen.nextCursor,
    interpreted: {
      subcategory: appliedSub,
      maxPrice: appliedPrice,
      descriptors: appliedDescriptors,
      relaxed: chosen.key,
      caption: describeFilters({
        subcategory: appliedSub,
        maxPrice: appliedPrice,
        descriptors: appliedDescriptors,
      }),
    },
  });
}

function makeOpts(
  creatorId: string,
  limit: number,
  cursor: string | null,
  pillSubcategory: string | null,
  parsed: ParsedQuery,
  withDescriptors: boolean,
  withPrice: boolean
): PageOpts {
  return {
    creatorId,
    limit,
    cursor,
    pillSubcategory,
    parsedSubcategory: pillSubcategory ? null : parsed.subcategory,
    maxPrice: withPrice ? parsed.maxPrice : null,
    descriptors: withDescriptors ? parsed.descriptors : [],
  };
}

type Product = {
  id: string;
  source_network: string;
  product_title: string;
  brand: string | null;
  price: number | null;
  price_display: string | null;
  image_url: string;
  affiliate_url: string;
  product_category: string | null;
  product_subcategory: string | null;
};

async function fetchPage(opts: PageOpts): Promise<{
  rows: Product[];
  nextCursor: string | null;
}> {
  const admin = supabaseAdmin();
  let query = admin
    .from("creator_products")
    .select(
      "id, source_network, product_title, brand, price, price_display, image_url, affiliate_url, product_category, product_subcategory, created_at"
    )
    .eq("creator_id", opts.creatorId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(opts.limit + 1);

  if (opts.cursor) query = query.lt("created_at", opts.cursor);

  // Pill wins when set; otherwise fall back to parsed subcategory.
  const effectiveSubcategory =
    opts.pillSubcategory ?? opts.parsedSubcategory ?? null;
  if (effectiveSubcategory) {
    query = query.eq("product_subcategory", effectiveSubcategory);
  }

  if (opts.maxPrice != null) {
    // Honor the chat app's budget-target convention: a stated price
    // is a soft ceiling and 10% over is fine. Without this the parser
    // ceiling would be stricter than the chat experience.
    const softCeiling = Math.round(opts.maxPrice * 1.1);
    query = query.lte("price", softCeiling);
  }

  // Descriptors: ILIKE each against title OR brand. Multiple
  // descriptors AND together (a "black silk top" should require BOTH
  // black AND silk somewhere in the title/brand).
  if (opts.descriptors.length) {
    for (const d of opts.descriptors) {
      const safe = d.replace(/[,()*]/g, " ").slice(0, 40);
      query = query.or(
        `product_title.ilike.%${safe}%,brand.ilike.%${safe}%`
      );
    }
  }

  const { data, error } = await query;
  if (error) {
    console.error("[tryon-grid/products] query error:", error);
    return { rows: [], nextCursor: null };
  }
  const data2 = data ?? [];
  const hasMore = data2.length > opts.limit;
  const page = hasMore ? data2.slice(0, opts.limit) : data2;
  const nextCursor = hasMore ? page[page.length - 1].created_at : null;
  const rows = page.map(({ created_at: _c, ...rest }) => rest) as Product[];
  return { rows, nextCursor };
}
