/**
 * GET /api/tryon-grid/[slug]/products
 *
 * Paginated, filterable product list for the try-on grid.
 * Read-only; no auth required. (The gated action is POST /api/render
 * via the Try-On button; that endpoint runs its own session check.)
 *
 * Ordering: round-robin across source_networks (fwrd, shopbop, revolve,
 * shopmy) so every screen surfaces a mix. The first page contains at
 * least one row from each non-empty network (assuming a creator has
 * 4+ rows). Within each network, rows are ordered DESC by
 * (created_at, id) so same-timestamp seed-chunk batches don't drop
 * rows across pages.
 *
 * Why round-robin: the seed ingest inserts each network in chunks of
 * 200 rows, each chunk getting the same created_at via Postgres'
 * now() default. A naive ORDER BY created_at DESC therefore buries
 * the smaller networks at the END of pagination (e.g. shopbop+revolve
 * ended up after ~840 fwrd rows). Interleaving fixes the symptom
 * without rewriting seed timestamps or breaking pagination.
 *
 * Query params:
 *   limit       (default 40, max 100) page size
 *   cursor      base64url-encoded JSON: per-network { ts, id } tuple
 *               recording the last-served (created_at, id) per network.
 *               Old-shape cursors (bare ISO string) decode to "no
 *               cursor" — clients refresh-friendly without errors.
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
 *       relaxed: 'none' | 'descriptors' | 'subcategory' | 'all',
 *       caption: string | null,    // e.g. "Tops under $300"
 *     } | null,                    // null when q was empty
 *
 * Price is a hard ceiling: when the user types "under $250" we
 * filter to price <= 250 (exact, no headroom) and never relax that
 * filter even if it zeros the result set. Returning $495 dresses
 * for a $250 query is worse than returning none.
 *   }
 *   404 { error: 'creator_not_found' }
 */

import { supabaseAdmin } from "@/lib/supabase";
import {
  describeFilters,
  describeRelaxedFilters,
  parseQuery,
  type ParsedQuery,
} from "@/lib/tryonGridSearch";

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
  /** Curated-edit opt-in. When true, filter to featured=true rows
   *  (with fallback to the full catalog if the creator has no
   *  featured rows yet). When false (the default), serve the full
   *  catalog sorted tryable-first then recency. */
  curated: boolean;
};

// Subcategories that get sorted FIRST in the default view. Items
// in these buckets show a Try-On button and should dominate the
// fold. Mirrors TRYON_ELIGIBLE_CATEGORIES in
// src/app/_tryon/TryOnGrid.tsx (keep these two in sync; a divergent
// client list would still get sorted correctly on the server, but
// a card would show up high without a Try-On affordance, which
// reads as a UX bug). Non-tryable items (bags / shoes / jewelry /
// accessories / beauty / home / swim / other) fall to the back of
// the order.
const TRYABLE_FIRST_BUCKETS = new Set<string>([
  "tops",
  "bottoms",
  "dresses",
  "outerwear",
]);

function tryableRank(subcategory: string | null): 0 | 1 {
  return subcategory && TRYABLE_FIRST_BUCKETS.has(subcategory) ? 0 : 1;
}

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
  // Default behavior: full catalog (sorted tryable-first then
  // recency). The page lands full and active with zero curation
  // required.
  //
  // `?curated=1`: opt-in to the creator's featured edit (the
  // starred set). If the creator has no featured rows yet, falls
  // back to the full catalog so the page never goes blank.
  //
  // Legacy `?all=1` is preserved as a no-op (it used to flip from
  // featured-default to full-catalog; that flip is now the default,
  // so the param is silently ignored). No old links break.
  const curated = url.searchParams.get("curated") === "1";

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
      curated,
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
  //   3. drop parsed subcategory       only if pill didn't pin one
  //                                    (price stays; descriptors
  //                                    already dropped at rung 2)
  //   4. give up                       return empty + caption
  //
  // Price is NEVER dropped. A user who types "under $250" expects
  // results <= $250 or nothing; quietly upgrading them past their
  // stated cap is a worse UX than an honest "no matches" empty
  // state. (Earlier versions had a "drop price" rung at #3 which
  // silently surfaced $495 / $990 dresses for a "$250" query when
  // the lower-priced catalog rows had null price columns.)
  const attempts: Array<{ key: "none" | "descriptors" | "subcategory" | "all"; opts: PageOpts }> = [
    {
      key: "none",
      opts: makeOpts(creator.id, limit, cursor, pillSubcategory, parsed, true, true, curated),
    },
    {
      key: "descriptors",
      opts: makeOpts(creator.id, limit, cursor, pillSubcategory, parsed, false, true, curated),
    },
  ];
  // Only add the "drop subcategory" rung when the parser inferred one
  // AND the pill didn't pin one. A pinned pill always survives.
  // Price stays applied here too.
  if (!pillSubcategory && parsed.subcategory) {
    attempts.push({
      key: "subcategory",
      opts: {
        ...makeOpts(creator.id, limit, cursor, null, parsed, false, true, curated),
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
    const wanted = {
      subcategory: effectiveSubcategory,
      maxPrice: parsed.maxPrice,
      descriptors: parsed.descriptors,
    };
    return Response.json({
      products: [],
      nextCursor: null,
      interpreted: {
        subcategory: effectiveSubcategory,
        maxPrice: parsed.maxPrice,
        descriptors: parsed.descriptors,
        relaxed: "all" as const,
        caption: `No ${describeFilters(wanted).toLowerCase()}`,
        wanted,
      },
    });
  }

  // Reflect the actually-applied filters back to the client so the
  // caption matches reality. Price is always applied (never relaxed)
  // so it just echoes the parsed value. Subcategory and descriptors
  // can be relaxed per the ladder above.
  const appliedSub =
    chosen.key === "subcategory" ? null : effectiveSubcategory;
  const appliedPrice = parsed.maxPrice;
  const appliedDescriptors =
    chosen.key === "none" ? parsed.descriptors : [];

  // Caption: when we relaxed anything, say so explicitly ("No black
  // tops under $300, showing all tops under $300") instead of
  // silently returning a different filter set. The user asked for X
  // and we're showing Y; they should be told.
  const caption =
    chosen.key === "none"
      ? describeFilters({
          subcategory: appliedSub,
          maxPrice: appliedPrice,
          descriptors: appliedDescriptors,
        })
      : describeRelaxedFilters({
          wanted: {
            subcategory: effectiveSubcategory,
            maxPrice: parsed.maxPrice,
            descriptors: parsed.descriptors,
          },
          applied: {
            subcategory: appliedSub,
            maxPrice: appliedPrice,
            descriptors: appliedDescriptors,
          },
        });

  return Response.json({
    products: chosen.rows,
    nextCursor: chosen.nextCursor,
    interpreted: {
      subcategory: appliedSub,
      maxPrice: appliedPrice,
      descriptors: appliedDescriptors,
      relaxed: chosen.key,
      caption,
      // Echo the parser's original signals too so the client (and
      // operators inspecting via curl) can see what we interpreted
      // before relaxation. Helpful for debugging "why did this query
      // not find the obvious match" without a server log dive.
      wanted: {
        subcategory: effectiveSubcategory,
        maxPrice: parsed.maxPrice,
        descriptors: parsed.descriptors,
      },
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
  withPrice: boolean,
  curated: boolean
): PageOpts {
  return {
    creatorId,
    limit,
    cursor,
    pillSubcategory,
    parsedSubcategory: pillSubcategory ? null : parsed.subcategory,
    maxPrice: withPrice ? parsed.maxPrice : null,
    descriptors: withDescriptors ? parsed.descriptors : [],
    curated,
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
  featured: boolean | null;
};

// Networks the round-robin visits, in priority order. Picking from
// left to right each pass means the first row of every page comes
// from `fwrd` (largest catalog), then `shopbop`, etc. Adding a new
// network is a one-line append here; the cursor shape adapts
// automatically.
const ROUND_ROBIN_NETWORKS = ["fwrd", "shopbop", "revolve", "shopmy"] as const;
type Network = (typeof ROUND_ROBIN_NETWORKS)[number];
type NetworkCursor = { ts: string; id: string };
type InterleaveCursor = Partial<Record<Network, NetworkCursor>>;

const SELECT_COLS =
  "id, source_network, product_title, brand, price, price_display, image_url, affiliate_url, product_category, product_subcategory, featured, created_at";

// Server-side rewrite of the known-bad Shopbop CDN URL pattern.
// Background: the parser was historically writing image_urls
// missing the "/p/" segment between "/Shopbop/" and "/prod/", e.g.
// .../Shopbop/prod/products/X.jpg (404)
// when the working URL is
// .../Shopbop/p/prod/products/X.jpg (200)
// The parser is fixed in scripts/ingest-creator-products/parsers.mjs
// (SHOPBOP_PRODUCT_IMAGE_ORIGIN includes "/p/") and the
// /api/admin/recategorize-cass route backfills existing rows.
//
// Rewriting on read here so the API output is ALWAYS correct
// regardless of DB state: any row whose stored image_url still
// has the bad pattern is silently fixed before going to the
// client. Eliminates the dependency on the admin curl having run.
// Cost: a single string check + replace per row, negligible.
const SHOPBOP_BAD_PREFIX = "/Shopbop/prod/";
const SHOPBOP_GOOD_PREFIX = "/Shopbop/p/prod/";

function fixImageUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== "string") return null;
  if (url.includes(SHOPBOP_BAD_PREFIX)) {
    return url.replace(SHOPBOP_BAD_PREFIX, SHOPBOP_GOOD_PREFIX);
  }
  return url;
}

// Server-side rewrite of mis-bucketed subcategories. Same pattern
// as fixImageUrl: an inline correction on every read so the API
// output is always right regardless of what the DB stored. The
// underlying categorize.mjs rule was plural-blind for a long time
// (\bjean\b matched "Jean" but not "Jeans"), so many Shopbop and
// FWRD rows with plural titles ("Leena Jeans", "501 Jeans", "High
// Baggy Shorts") fell through to "other" or got hit by an unrelated
// fallback like "accessories" via Shopbop's topLevelCategory. The
// source rule is fixed in scripts/ingest-creator-products/
// categorize.mjs; this is the runtime backfill.
//
// Only triggers when the stored value is the catch-all "other" or
// the off-target "accessories"; properly-bucketed rows pass through
// unchanged. Rule order mirrors categorize.mjs so a Midi Skirt
// (matches both dresses and bottoms in the source) lands as
// bottoms, not dresses.
const SUBCATEGORY_REWRITE_RULES: Array<{ sub: string; re: RegExp }> = [
  { sub: "swim", re: /\b(bikinis?|swim(suits?|wear)?|monokinis?|tankinis?|trunks?)\b/i },
  { sub: "outerwear", re: /\b(blazers?|coats?|jackets?|trench(es)?|parkas?|puffers?|capes?|ponchos?|vests?|overcoats?)\b/i },
  { sub: "shoes", re: /\b(shoes?|sneakers?|boots?|booties?|heels?|pumps?|sandals?|flats?|loafers?|mules?|slippers?|wedges?|espadrilles?|clogs?|slides?)\b/i },
  { sub: "bags", re: /\b(bags?|totes?|clutch(es)?|hobos?|satchels?|crossbody|backpacks?|wallets?|wristlets?|baguette|handbags?|purses?)\b/i },
  { sub: "jewelry", re: /\b(earrings?|necklaces?|rings?|bracelets?|bangles?|anklets?|pendants?|chokers?)\b/i },
  // bottoms BEFORE dresses so "Midi Skirt" routes here, not dresses
  { sub: "bottoms", re: /\b(pants?|jeans?|trousers?|shorts?|skirts?|leggings?|denim|chinos?|cargos?|joggers?)\b/i },
  // dresses only when the noun is unambiguous (no bare "midi" /
  // "mini" / "maxi" since those decorate skirts too)
  { sub: "dresses", re: /\b(dress(es)?|gowns?|sundress(es)?|jumpsuits?|rompers?)\b/i },
  { sub: "tops", re: /\b(tops?|tees?|tanks?|shirts?|blouses?|sweaters?|knits?|polos?|camis?|bodysuits?|halters?|tunics?|pullovers?|hoodies?|sweatshirts?)\b/i },
];

function fixSubcategory(
  current: string | null,
  title: string | null,
  brand: string | null
): string | null {
  // Only correct rows that are in the catch-alls. Properly-bucketed
  // rows (tops/bottoms/dresses/shoes/bags/etc.) keep their value.
  if (current !== "other" && current !== "accessories") return current;
  const hay = `${title ?? ""} ${brand ?? ""}`;
  for (const rule of SUBCATEGORY_REWRITE_RULES) {
    if (rule.re.test(hay)) return rule.sub;
  }
  return current;
}

function decodeInterleaveCursor(raw: string | null): InterleaveCursor {
  if (!raw) return {};
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== "object") return {};
    const out: InterleaveCursor = {};
    for (const net of ROUND_ROBIN_NETWORKS) {
      const v = (obj as Record<string, unknown>)[net];
      if (
        v &&
        typeof v === "object" &&
        typeof (v as NetworkCursor).ts === "string" &&
        typeof (v as NetworkCursor).id === "string"
      ) {
        out[net] = { ts: (v as NetworkCursor).ts, id: (v as NetworkCursor).id };
      }
    }
    return out;
  } catch {
    // Old-shape cursors (bare ISO string from the pre-interleave API)
    // land here. Treat as "no cursor" so the next request restarts the
    // round-robin from the top; better than a 500.
    return {};
  }
}

function encodeInterleaveCursor(c: InterleaveCursor): string | null {
  if (Object.keys(c).length === 0) return null;
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

/**
 * Per-network fetch. Pulls up to `limit` rows in DESC (created_at, id)
 * order, applying the same subcategory / price / descriptor filters as
 * the overall request. The tuple-cursor `(ts, id) < (cursor.ts, cursor.id)`
 * is exact: same-timestamp rows that the seed inserts as a batch are
 * paginated cleanly across pages, no drops, no dupes. (The pre-
 * interleave code used `lt(created_at)` only, which silently dropped
 * up to ~3 rows per chunk boundary.)
 */
async function fetchOneNetwork(args: {
  creatorId: string;
  network: Network;
  perLimit: number;
  cursor: NetworkCursor | undefined;
  effectiveSubcategory: string | null;
  maxPrice: number | null;
  descriptors: string[];
  featuredOnly: boolean;
}): Promise<{ rows: Array<Product & { created_at: string }>; mayHaveMore: boolean }> {
  const admin = supabaseAdmin();
  let query = admin
    .from("creator_products")
    .select(SELECT_COLS)
    .eq("creator_id", args.creatorId)
    .eq("source_network", args.network)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(args.perLimit);

  // Curated-view filter. fetchPage computes featuredOnly as "the
  // caller passed ?curated=1 AND the creator has at least one
  // featured row." Default view is the full catalog, so this is
  // off unless the user opted in.
  if (args.featuredOnly) {
    query = query.eq("featured", true);
  }

  if (args.cursor) {
    // Tuple cursor (created_at, id) < (cursor.ts, cursor.id). PostgREST
    // doesn't expose row-value comparison; we expand it as
    //   created_at < cursor.ts  OR  (created_at = cursor.ts AND id < cursor.id)
    // The .or() string treats commas as separators, so the AND clause
    // is wrapped in and(...) per PostgREST syntax.
    query = query.or(
      `created_at.lt.${args.cursor.ts},and(created_at.eq.${args.cursor.ts},id.lt.${args.cursor.id})`
    );
  }

  if (args.effectiveSubcategory) {
    query = query.eq("product_subcategory", args.effectiveSubcategory);
  }

  if (args.maxPrice != null) {
    // Hard ceiling. Typed into the search bar, a price cap is exact
    // ("under $250" means <= 250, not <= 275). The chat layer can
    // still apply its own budget-target padding; this is a filter
    // box, not a conversation. Note: the relaxation ladder also
    // never drops this filter (see attempts[] above), so the user
    // never sees a price > their stated cap.
    query = query.lte("price", args.maxPrice);
  }

  // Descriptors match each against title OR brand OR affiliate_url
  // with word/path boundaries (POSIX imatch). See top-level docs.
  if (args.descriptors.length) {
    for (const d of args.descriptors) {
      const safe = d.replace(/[^a-z0-9]/gi, "").slice(0, 40);
      if (!safe) continue;
      query = query.or(
        `product_title.imatch.\\m${safe}\\M,brand.imatch.\\m${safe}\\M,affiliate_url.imatch.[-/]${safe}[-/?]`
      );
    }
  }

  const { data, error } = await query;
  if (error) {
    console.error(
      `[tryon-grid/products] ${args.network} fetch error:`,
      error
    );
    return { rows: [], mayHaveMore: false };
  }
  const rows = (data ?? []) as Array<Product & { created_at: string }>;
  // If the fetch hit the per-network limit, DB may still have more
  // rows of this network past the last one fetched.
  return { rows, mayHaveMore: rows.length === args.perLimit };
}

async function fetchPage(opts: PageOpts): Promise<{
  rows: Product[];
  nextCursor: string | null;
}> {
  const cursor = decodeInterleaveCursor(opts.cursor);
  const effectiveSubcategory =
    opts.pillSubcategory ?? opts.parsedSubcategory ?? null;

  // Compute featuredOnly: only when the user opted into the
  // curated view AND the creator has any featured rows. If they
  // opted in but no rows are starred yet, featuredOnly stays
  // false and we serve the full catalog (the page never goes
  // blank). Default (curated=false) is always the full catalog.
  let featuredOnly = false;
  if (opts.curated) {
    const admin = supabaseAdmin();
    const { count } = await admin
      .from("creator_products")
      .select("id", { count: "exact", head: true })
      .eq("creator_id", opts.creatorId)
      .eq("featured", true);
    featuredOnly = (count ?? 0) > 0;
  }

  // Per-network overfetch budget. The round-robin pulls one row from
  // each network in rotation, so each network contributes roughly
  // `limit / networks` rows per page. Multiply by 1.5 and add 1 so a
  // network that runs short doesn't starve the page; the extras stay
  // in memory for this request and inform mayHaveMore.
  const perLimit =
    Math.ceil((opts.limit * 1.5) / ROUND_ROBIN_NETWORKS.length) + 1;

  // Fire all per-network queries in parallel.
  const results = await Promise.all(
    ROUND_ROBIN_NETWORKS.map((net) =>
      fetchOneNetwork({
        creatorId: opts.creatorId,
        network: net,
        perLimit,
        cursor: cursor[net],
        effectiveSubcategory,
        maxPrice: opts.maxPrice,
        descriptors: opts.descriptors,
        featuredOnly,
      }).then((r) => ({ net, ...r }))
    )
  );
  const state = new Map<
    Network,
    { rows: Array<Product & { created_at: string }>; mayHaveMore: boolean }
  >();
  for (const r of results) {
    state.set(r.net, { rows: r.rows, mayHaveMore: r.mayHaveMore });
  }

  // Round-robin pick. Visit each network in priority order; if the
  // queue has rows, pop one. Continue passes until we hit the page
  // limit or every queue is empty.
  const picked: Array<Product & { created_at: string }> = [];
  const advanced: InterleaveCursor = {};
  outer: while (picked.length < opts.limit) {
    let progress = false;
    for (const net of ROUND_ROBIN_NETWORKS) {
      const s = state.get(net);
      if (!s || s.rows.length === 0) continue;
      const row = s.rows.shift()!;
      picked.push(row);
      advanced[net] = { ts: row.created_at, id: row.id };
      progress = true;
      if (picked.length === opts.limit) break outer;
    }
    if (!progress) break;
  }

  // Tryable-first re-sort. Round-robin already mixes networks for
  // visual variety; layered on top, sort the picked set so
  // try-on-eligible items dominate the fold. Within each rank,
  // preserve created_at DESC (recency tiebreak). The cursor logic
  // is unchanged; the cursor records the per-network (ts, id)
  // boundary regardless of our cosmetic re-sort here.
  //
  // Note: this is a re-sort of the page-sized window. If page 1
  // returns 40 items with 30 tryable + 10 non-tryable, the user
  // sees 30 tryable up front then 10 non-tryable. Page 2 pulls the
  // next 40 with its own tryable-first re-sort. Across pages the
  // pattern repeats — predictable from the user's POV.
  picked.sort((a, b) => {
    const ra = tryableRank(a.product_subcategory);
    const rb = tryableRank(b.product_subcategory);
    if (ra !== rb) return ra - rb;
    // Same tryable_rank: keep recency DESC.
    if (a.created_at !== b.created_at) {
      return a.created_at < b.created_at ? 1 : -1;
    }
    return a.id < b.id ? 1 : -1;
  });

  // Build next cursor: carry forward each network's input cursor,
  // overlaid with any advances from this page. A network that did not
  // advance keeps its prior position so the next page picks up exactly
  // where it left off (or never started, for empty networks).
  const newCursor: InterleaveCursor = { ...cursor, ...advanced };

  // A network has more if its queue still has unconsumed rows OR if
  // its initial fetch hit perLimit (DB likely has more past the last
  // fetched row). When every network is exhausted, nextCursor=null and
  // the grid stops paginating.
  const anyMore = ROUND_ROBIN_NETWORKS.some((net) => {
    const s = state.get(net);
    if (!s) return false;
    return s.rows.length > 0 || s.mayHaveMore;
  });

  // Strip created_at + apply runtime rewrites before handing rows
  // to the client:
  //   - fixImageUrl: repairs the Shopbop "/Shopbop/prod/" missing
  //     "/p/" prefix bug.
  //   - fixSubcategory: re-derives subcategory for rows stuck in
  //     "other" or "accessories" because the source categorizer's
  //     regex was plural-blind. Both fixes also exist at ingest
  //     time; the runtime layer makes the API output correct
  //     regardless of DB state.
  const rows = picked.map(({ created_at: _c, ...rest }) => {
    const fixedUrl = fixImageUrl(rest.image_url);
    const fixedSub = fixSubcategory(
      rest.product_subcategory,
      rest.product_title,
      rest.brand
    );
    return {
      ...rest,
      image_url: fixedUrl ?? rest.image_url,
      product_subcategory: fixedSub,
    } as Product;
  });
  return {
    rows,
    nextCursor: anyMore ? encodeInterleaveCursor(newCursor) : null,
  };
}
