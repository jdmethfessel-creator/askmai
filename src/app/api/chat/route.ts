import Anthropic from "@anthropic-ai/sdk";
import { supabaseAdmin } from "@/lib/supabase";
import { resolveLink } from "@/lib/resolveLink";
import { generateAggregatorLink } from "@/lib/affiliateLinks";
import { LUXURY_BRANDS } from "@/lib/affiliateBrands";
import { bingLookup } from "@/lib/bingImage";
import type { ChatMessage, Creator, Rec } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODEL = "claude-sonnet-4-6";
// Output token budget. Heavy multi-part queries (2+ outfits + multiple
// places + per-rec JSON with long image / place URLs) routinely run
// 1200-1600 output tokens. 1024 was clipping the RECS block mid-prose
// on those queries — zero cards rendered. 2048 leaves clear headroom.
const MAX_TOKENS = 2048;
const MAX_HISTORY = 20;

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json(
      { error: "Server missing ANTHROPIC_API_KEY" },
      { status: 500 }
    );
  }

  let body: { slug?: string; message?: string; history?: ChatMessage[] };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const slug = body.slug?.trim();
  const message = body.message?.trim();
  if (!slug || !message) {
    return Response.json(
      { error: "slug and message are required" },
      { status: 400 }
    );
  }

  const { data, error } = await supabaseAdmin()
    .from("creators")
    .select("id, slug, name, bio, voice_prompt, taste_profile")
    .eq("slug", slug)
    .maybeSingle();

  if (error || !data) {
    return Response.json({ error: "Creator not found" }, { status: 404 });
  }

  const creator = data as Pick<
    Creator,
    "id" | "slug" | "name" | "bio" | "voice_prompt" | "taste_profile"
  >;
  const creatorId = creator.id;

  const catalog = await loadCatalog(creatorId, message);
  const knownProducts = buildKnownProducts(catalog, creator.taste_profile);
  const creatorRef = {
    id: creatorId,
    slug: creator.slug,
    taste_profile: creator.taste_profile,
  };
  const budgetCeiling = extractBudgetCeiling(message);
  const systemPrompt = buildSystemPrompt(creator, catalog, budgetCeiling);
  const history = sanitizeHistory(body.history ?? []);

  const client = new Anthropic();

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages: [...history, { role: "user", content: message }],
  });

  const encoder = new TextEncoder();
  const RECS_MARKER = "---RECS---";

  const readable = new ReadableStream({
    async start(controller) {
      let pending = ""; // pre-marker tail we haven't decided about yet
      let proseText = ""; // everything we've actually emitted as prose
      let pastMarker = false;
      let buffered = ""; // post-marker text (to be enriched)
      const HOLD = RECS_MARKER.length - 1;
      try {
        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            const text = event.delta.text;
            if (pastMarker) {
              buffered += text;
              continue;
            }
            const combined = pending + text;
            const markerIdx = combined.indexOf(RECS_MARKER);
            if (markerIdx !== -1) {
              const before = combined.slice(0, markerIdx);
              proseText += before;
              if (before.length > 0) {
                controller.enqueue(encoder.encode(before));
              }
              buffered = combined.slice(markerIdx + RECS_MARKER.length);
              pastMarker = true;
              pending = "";
            } else {
              // Hold back the last (markerLen - 1) chars in case the marker
              // straddles this and the next chunk.
              const safeEnd = Math.max(0, combined.length - HOLD);
              const safe = combined.slice(0, safeEnd);
              pending = combined.slice(safeEnd);
              proseText += safe;
              if (safe.length > 0) controller.enqueue(encoder.encode(safe));
            }
          }
        }

        if (!pastMarker && pending.length > 0) {
          proseText += pending;
          controller.enqueue(encoder.encode(pending));
        }

        const baseRecs = pastMarker
          ? await enrichRecsBlock(buffered, creatorRef, budgetCeiling)
          : [];
        const catalogAugmented = await augmentWithMissingMentions(
          baseRecs,
          proseText,
          knownProducts,
          creatorRef,
          budgetCeiling
        );
        const offCatalogAugmented = await augmentWithOffCatalogMentions(
          catalogAugmented,
          proseText,
          creatorRef,
          budgetCeiling
        );
        // Place-prose scanner: when the model names a place + city in
        // prose but skips the JSON rec, synthesize a place card and route
        // it through the place tier. Same safety net products already
        // get from augmentWithOffCatalogMentions.
        const finalRecs = await augmentWithProsePlaces(
          offCatalogAugmented,
          proseText,
          creatorRef
        );
        // Server-side image prefetch. Non-synth aggregator items often
        // arrive without image_url (Serper failed, or returned a
        // brand-search fallback with no realImage). The visual-board
        // gate runs at partition time, so without this pass those items
        // would never count toward eligibility — even though the lazy
        // client lookup would fill them in for the eventual render.
        const enrichedRecs = await prefetchAggregatorImages(finalRecs);
        if (enrichedRecs.length > 0) {
          controller.enqueue(
            encoder.encode(`\n${RECS_MARKER}\n${JSON.stringify(enrichedRecs)}`)
          );
        }
        // Log truncation diagnostics so we can spot recurring max_tokens
        // hits before users do.
        try {
          const final = await stream.finalMessage();
          if (final.stop_reason === "max_tokens" && !pastMarker) {
            console.warn(
              `[chat] response hit max_tokens BEFORE reaching ---RECS--- marker. ` +
                `creator=${creator.slug} prose_chars=${proseText.length} ` +
                `recs_emitted=${finalRecs.length}. Raise MAX_TOKENS or shorten prose.`
            );
          }
        } catch {
          // finalMessage may not be available — non-fatal.
        }
        controller.close();
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Stream failed";
        controller.enqueue(encoder.encode(`\n\n[error: ${msg}]`));
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Parses a per-item or per-outfit budget ceiling from the user's message.
 * Returns the number of dollars as the per-item card-filter ceiling.
 *
 * Per-outfit phrasing ("outfit under $200") still produces a per-item filter
 * because a single piece priced above the outfit total is, by construction,
 * over-budget for that outfit. Conservative on purpose.
 */
function extractBudgetCeiling(message: string): number | null {
  if (!message) return null;
  const patterns = [
    /\bunder\s+\$?(\d{2,5})\b/i,
    /\b(?:max(?:imum)?|up to|no more than)\s+\$?(\d{2,5})\b/i,
    /\$(\d{2,5})\s*(?:each|max|ceiling|limit|total|or less|or under)\b/i,
    /\bbudget\s+(?:of\s+|around\s+|about\s+)?\$?(\d{2,5})\b/i,
    /\baround\s+\$?(\d{2,5})\b/i,
    /\b(?:keep it )?under\s+a?\s*\$?(\d{2,5})\b/i,
  ];
  for (const re of patterns) {
    const m = message.match(re);
    if (m) {
      const n = Number(m[1]);
      if (n >= 20 && n <= 50000) return n;
    }
  }
  return null;
}

function parsePriceNumber(s: string | undefined): number | null {
  if (!s) return null;
  const m = String(s).match(/(\d{1,5}(?:,\d{3})*(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Reads taste_profile.identity.own_brand_no_catalog (string[]) — brands that
 * are the creator's OWN line but have no live storefront connected. The
 * platform blocks fabricated SKU cards under these brands.
 */
function collectOwnBrandNoCatalog(taste: unknown): Set<string> {
  const out = new Set<string>();
  if (!taste || typeof taste !== "object") return out;
  const id = (taste as Record<string, unknown>).identity;
  if (!id || typeof id !== "object") return out;
  const list = (id as Record<string, unknown>).own_brand_no_catalog;
  if (Array.isArray(list)) {
    for (const v of list) {
      if (typeof v === "string" && v.trim()) {
        out.add(v.trim().toLowerCase());
      }
    }
  }
  return out;
}

function overBudget(price: string | undefined, ceiling: number | null): boolean {
  if (ceiling == null) return false;
  const n = parsePriceNumber(price);
  if (n == null) return false; // unknown price — let it through, the model can be vague
  return n > ceiling;
}

async function enrichRecsBlock(
  raw: string,
  creator: { id: string; slug: string; taste_profile?: unknown },
  budgetCeiling: number | null
): Promise<Rec[]> {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const recs: Rec[] = parsed
    .filter((r): r is Rec => r && typeof r === "object" && "name" in r)
    .map((r) => ({
      name: String(r.name ?? ""),
      brand: r.brand ? String(r.brand) : undefined,
      category: String(r.category ?? "").toLowerCase(),
      price: r.price ? String(r.price) : undefined,
      why: String(r.why ?? ""),
      location:
        "location" in r && r.location ? String(r.location) : undefined,
      product_id:
        "product_id" in r && r.product_id ? String(r.product_id) : undefined,
      merchant_url:
        "merchant_url" in r && r.merchant_url
          ? String(r.merchant_url)
          : undefined,
      reservable:
        "reservable" in r && typeof r.reservable === "boolean"
          ? r.reservable
          : undefined,
    }));

  // First budget pass + own-brand-no-catalog guardrail. Drop recs whose
  // brand is the creator's own brand WHEN that brand has no catalog
  // entries (no live storefront connected). The model may mention these
  // in prose but must not fabricate a SKU + price.
  const ownBrandNoCatalog = collectOwnBrandNoCatalog(creator.taste_profile);
  const preFiltered = recs.filter((r) => {
    if (r.category === "travel" || r.category === "dining") return true;
    if (overBudget(r.price, budgetCeiling)) return false;
    const recBrand = (r.brand ?? "").trim().toLowerCase();
    if (recBrand && ownBrandNoCatalog.has(recBrand)) {
      console.warn(
        `[shoppability] dropping fabricated own-brand card: brand="${r.brand}" name="${r.name}" (no catalog connected)`
      );
      return false;
    }
    return true;
  });

  // Resilience: each rec's resolveLink runs in its own try/catch and any
  // failure degrades to a search-link card instead of dropping the rec or
  // collapsing the whole array. A product should NEVER fail to card just
  // because link resolution hiccuped.
  const enriched = await Promise.all(
    preFiltered.map(async (rec) => {
      try {
        const resolved = await resolveLink(rec, creator);
        if (
          (resolved.tier === "feed" || resolved.tier === "owned_feed") &&
          resolved.feed_product
        ) {
          const fp = resolved.feed_product;
          return {
            ...rec,
            name: fp.name,
            brand: fp.brand ?? rec.brand,
            price: fp.price ?? rec.price,
            image_url: fp.image_url ?? rec.image_url,
            affiliate_url: resolved.url,
            tier: resolved.tier,
            product_id: resolved.matched_product_id,
          };
        }
        const { product_id: _ignored, ...rest } = rec;
        void _ignored;
        let base: Rec = {
          ...rest,
          affiliate_url: resolved.url,
          tier: resolved.tier,
        };
        if (resolved.tier === "aggregator" && resolved.live_product) {
          const lp = resolved.live_product;
          base = {
            ...base,
            price: lp.realPrice ?? base.price,
            image_url: lp.realImage ?? base.image_url,
          };
        }
        if (resolved.tier === "place" && resolved.place_links) {
          return {
            ...base,
            // OSM resolves the authoritative neighborhood; only override
            // when present so an OSM miss keeps the model's hint.
            location: resolved.resolved_location ?? base.location,
            reservable: resolved.place_links.reservable,
            directions_url: resolved.place_links.directions,
            menu_url: resolved.place_links.menu,
          };
        }
        return base;
      } catch (err) {
        return degradeRec(rec, creator.slug, err);
      }
    })
  );

  // Second budget pass: feed-tier overrides may have replaced the model's
  // claimed price with the catalog's real price (e.g. model said $180,
  // catalog has $220). Drop anything that's now over the ceiling.
  return enriched.filter((r) => {
    if (r.category === "travel" || r.category === "dining") return true;
    return !overBudget(r.price, budgetCeiling);
  });
}

type CatalogRow = {
  id: string;
  name: string;
  brand: string | null;
  category: string | null;
  price: number | null;
};

type KnownProduct = {
  /** Lowercased phrase to search for in the model's prose. */
  match: string;
  /** Skeleton rec to feed through resolveLink when matched. */
  template: {
    name: string;
    brand?: string;
    category: string;
    price?: string;
    product_id?: string;
  };
};

/**
 * Two-token brand prefixes from the seeded taste profiles. Anything not in
 * this list collapses to a single-token brand. Cheap, predictable, easy to
 * extend per creator if we add more two-word brands.
 */
const TWO_TOKEN_BRANDS = [
  "U Beauty",
  "Ole Henriksen",
  "Summer Fridays",
  "Augustinus Bader",
  "Sisley Paris",
  "Westman Atelier",
  "Tower 28",
  "Saint Laurent",
  "The Row",
  "The Frankie Shop",
  "Isabel Marant",
  "Acne Studios",
  "Dion Lee",
  "By Far",
  "Paris Texas",
];

function splitBrandAndName(s: string): { brand?: string; name: string } {
  const trimmed = s.trim();
  if (!trimmed) return { name: trimmed };
  for (const prefix of TWO_TOKEN_BRANDS) {
    if (trimmed.toLowerCase().startsWith(prefix.toLowerCase() + " ")) {
      return {
        brand: prefix,
        name: trimmed.slice(prefix.length).trim() || trimmed,
      };
    }
  }
  const idx = trimmed.indexOf(" ");
  if (idx === -1) return { name: trimmed };
  return { brand: trimmed.slice(0, idx), name: trimmed.slice(idx + 1).trim() };
}

function buildKnownProducts(
  catalog: CatalogRow[],
  taste: Creator["taste_profile"]
): KnownProduct[] {
  const out: KnownProduct[] = [];
  const seen = new Set<string>();
  const add = (k: KnownProduct) => {
    const key = k.match;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(k);
  };

  // Catalog rows: match on the full product name. We only auto-add catalog
  // items the model fully names, never on brand-only mentions.
  for (const p of catalog) {
    if (!p.name) continue;
    add({
      match: p.name.toLowerCase(),
      template: {
        product_id: p.id,
        name: p.name,
        brand: p.brand ?? undefined,
        category: (p.category ?? "fashion").toLowerCase(),
        price: p.price != null ? `$${p.price}` : undefined,
      },
    });
  }

  // taste_profile.beauty product lists: skincare / makeup / sleep_wellness.
  // These are all phrased as specific products by the seeder.
  if (taste && typeof taste === "object") {
    const t = taste as Record<string, unknown>;
    const beauty = t.beauty as Record<string, unknown> | undefined;
    if (beauty) {
      for (const list of ["skincare", "makeup", "sleep_wellness"]) {
        const arr = beauty[list];
        if (!Array.isArray(arr)) continue;
        for (const item of arr) {
          if (typeof item !== "string" || !item.trim()) continue;
          const { brand, name } = splitBrandAndName(item);
          add({
            match: item.toLowerCase(),
            template: {
              name: brand ? name : item,
              brand,
              category: "beauty",
            },
          });
        }
      }
    }
  }

  return out;
}

/**
 * Looks for product names mentioned in prose that aren't already in the
 * structured recs block. For each match, build a synthetic rec and run it
 * through resolveLink so it gets a real affiliate URL. This closes the gap
 * where the model casually names a product (e.g. "U Beauty in the morning")
 * but forgets to also emit it in the JSON block.
 */
async function augmentWithMissingMentions(
  enriched: Rec[],
  proseText: string,
  known: KnownProduct[],
  creator: { id: string; slug: string },
  budgetCeiling: number | null
): Promise<Rec[]> {
  if (!proseText || known.length === 0) return enriched;
  const prose = proseText.toLowerCase();

  const seenNames = new Set<string>();
  const seenIds = new Set<string>();
  for (const r of enriched) {
    if (r.name) seenNames.add(r.name.toLowerCase());
    if (r.product_id) seenIds.add(r.product_id);
  }

  const additions: Rec[] = [];
  for (const k of known) {
    if (!prose.includes(k.match)) continue;
    if (
      k.template.product_id &&
      seenIds.has(k.template.product_id)
    )
      continue;
    if (seenNames.has(k.template.name.toLowerCase())) continue;
    // Also skip if any existing rec name already contains this match phrase
    // (e.g. the catalog name overlaps a taste-profile entry).
    let overlaps = false;
    for (const existing of seenNames) {
      if (existing.includes(k.match) || k.match.includes(existing)) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) continue;

    // Budget filter: skip catalog items that exceed the user's stated
    // ceiling. A prose mention of an over-budget piece is allowed as a
    // reference, but it must not generate a card.
    if (
      k.template.category !== "travel" &&
      k.template.category !== "dining" &&
      overBudget(k.template.price, budgetCeiling)
    ) {
      continue;
    }

    const synth: Rec = {
      name: k.template.name,
      brand: k.template.brand,
      category: k.template.category,
      price: k.template.price,
      product_id: k.template.product_id,
      why: "Named in her routine above.",
    };
    let resolved;
    try {
      resolved = await resolveLink(synth, creator, {
        source: "auto_augment",
      });
    } catch (err) {
      additions.push(degradeRec(synth, creator.slug, err));
      seenNames.add(k.template.name.toLowerCase());
      continue;
    }

    if (
      (resolved.tier === "feed" || resolved.tier === "owned_feed") &&
      resolved.feed_product
    ) {
      const fp = resolved.feed_product;
      additions.push({
        ...synth,
        name: fp.name,
        brand: fp.brand ?? synth.brand,
        price: fp.price ?? synth.price,
        image_url: fp.image_url ?? undefined,
        affiliate_url: resolved.url,
        tier: resolved.tier,
        product_id: resolved.matched_product_id,
      });
      seenIds.add(resolved.matched_product_id ?? synth.product_id ?? "");
    } else {
      const { product_id: _ignored, ...rest } = synth;
      void _ignored;
      additions.push({
        ...rest,
        affiliate_url: resolved.url,
        tier: resolved.tier,
      });
    }
    seenNames.add(k.template.name.toLowerCase());
  }

  return [...enriched, ...additions];
}

/**
 * Off-catalog prose scanner.
 *
 * The model sometimes describes specific purchasable pieces in prose
 * ("a Mango slip dress", "Zara strappy heels") but skips them in the
 * structured RECS block — usually on hedged "Brand A or Brand B"
 * mentions. augmentWithMissingMentions only catches CATALOG items, so
 * those off-catalog pieces silently disappear. This scanner detects
 * `<Brand> ... <piece-noun>` patterns for the Skimlinks-network brands
 * we already recommend, synthesizes recs, and routes them through
 * resolveLink so every named purchasable piece gets a card.
 */
const OFF_CATALOG_BRANDS = [
  // Mass fashion
  "Mango",
  "Zara",
  "H&M",
  "& Other Stories",
  "COS",
  "Reformation",
  "Aritzia",
  "Madewell",
  "Sezane",
  "Sézane",
  "Everlane",
  "Abercrombie",
  "Free People",
  "Anthropologie",
  "J.Crew",
  "Banana Republic",
  "Uniqlo",
  // Contemporary
  "Nili Lotan",
  "AGOLDE",
  "ABLE",
  "Steve Madden",
  "Sam Edelman",
  "Loeffler Randall",
  "Mejuri",
  "Catbird",
  "Veja",
  "New Balance",
  // Home / lifestyle
  "West Elm",
  "Pottery Barn",
  "Article",
  "Target",
  "Wayfair",
  "IKEA",
  "Crate & Barrel",
  "Crate and Barrel",
  "CB2",
  "Lulu and Georgia",
  "Lulu & Georgia",
  "Rejuvenation",
  "Schoolhouse",
  "McGee & Co",
  "Burke Decor",
  "Lamps Plus",
  "Chairish",
];

const OFF_CATALOG_NOUNS = {
  beauty: [
    "serum",
    "moisturizer",
    "cream",
    "cleanser",
    "sunscreen",
    "spf",
    "mask",
    "toner",
    "lipstick",
    "balm",
    "gloss",
    "foundation",
    "concealer",
    "mascara",
    "blush",
    "bronzer",
    "palette",
  ],
  home: [
    "lamp",
    "sofa",
    "couch",
    "chair",
    "armchair",
    "table",
    "rug",
    "pillow",
    "throw",
    "vase",
    "bowl",
    "tray",
    "basket",
    "mirror",
    "cabinet",
    "dresser",
    "shelf",
    "sconce",
    "bed",
    "headboard",
    "nightstand",
    "wallpaper",
    "curtain",
    "frame",
    "artwork",
  ],
  accessories: [
    "heels",
    "heel",
    "sandal",
    "sandals",
    "sneakers",
    "boots",
    "boot",
    "flats",
    "loafers",
    "mules",
    "pumps",
    "slingbacks",
    "clogs",
    "bag",
    "tote",
    "purse",
    "clutch",
    "handbag",
    "backpack",
    "crossbody",
    "necklace",
    "earrings",
    "earring",
    "bracelet",
    "ring",
    "belt",
    "sunglasses",
    "scarf",
    "watch",
  ],
  fashion: [
    "dress",
    "midi",
    "maxi",
    "mini",
    "slip",
    "gown",
    "jumpsuit",
    "romper",
    "top",
    "blouse",
    "shirt",
    "tee",
    "t-shirt",
    "tank",
    "bodysuit",
    "cami",
    "camisole",
    "sweater",
    "cardigan",
    "knit",
    "pullover",
    "hoodie",
    "pants",
    "trouser",
    "trousers",
    "jeans",
    "denim",
    "shorts",
    "skirt",
    "jacket",
    "blazer",
    "coat",
    "trench",
    "vest",
  ],
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Stop-words / connectors / articles / possessive remnants that should
// NEVER appear inside a synthesized product name. If the regex captures
// any of these, the captured phrase is grammatical glue between two
// thoughts, not a real product description — drop the synth card.
const PIECE_STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "for",
  "with",
  "of",
  "in",
  "on",
  "at",
  "to",
  "by",
  "from",
  "into",
  "onto",
  "as",
  "your",
  "her",
  "his",
  "their",
  "my",
  "our",
  "some",
  "any",
  "this",
  "that",
  "these",
  "those",
  "all",
  "more",
  "less",
  "than",
  "so",
  "if",
  "is",
  "are",
  "be",
]);

/**
 * Validate a captured piece phrase before synthesizing a card.
 * Rejects grammatical connectors ("and coffee table"), possessive
 * remnants ("'s wallpaper" → "s wallpaper"), and 1-2 char fragments.
 * These all produced garbage cards before this filter existed —
 * "Shelves And Coffee Table" with brand=Target, etc.
 */
function isValidPiecePhrase(pieceRaw: string): boolean {
  const trimmed = pieceRaw.trim();
  if (!trimmed) return false;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 0) return false;
  for (const t of tokens) {
    const norm = t.toLowerCase().replace(/[^\w-]/g, "");
    if (!norm) return false;
    if (PIECE_STOP_WORDS.has(norm)) return false;
    if (norm.length <= 2 && !/^\d/.test(norm)) return false;
  }
  return true;
}

function titleCasePhrase(s: string): string {
  return s
    .split(/\s+/)
    .map((w) =>
      w.length > 0 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w
    )
    .join(" ")
    .trim();
}

function categoryForPieceNoun(noun: string): string {
  const n = noun.toLowerCase();
  if (OFF_CATALOG_NOUNS.beauty.includes(n)) return "beauty";
  if (OFF_CATALOG_NOUNS.home.includes(n)) return "home";
  if (OFF_CATALOG_NOUNS.accessories.includes(n)) return "accessories";
  return "fashion";
}

async function augmentWithOffCatalogMentions(
  enriched: Rec[],
  proseText: string,
  creator: { id: string; slug: string },
  budgetCeiling: number | null
): Promise<Rec[]> {
  if (!proseText || !proseText.trim()) return enriched;

  const allNouns = [
    ...OFF_CATALOG_NOUNS.beauty,
    ...OFF_CATALOG_NOUNS.home,
    ...OFF_CATALOG_NOUNS.accessories,
    ...OFF_CATALOG_NOUNS.fashion,
  ]
    .map(escapeRegex)
    .join("|");

  const seenKeys = new Set<string>();
  for (const r of enriched) {
    if (r.name) {
      seenKeys.add(
        `${(r.brand ?? "").toLowerCase()}|${r.name.toLowerCase()}`
      );
    }
  }

  const additions: Rec[] = [];

  for (const brand of OFF_CATALOG_BRANDS) {
    const bEscaped = escapeRegex(brand);
    // Match: brand, optional ≤ ~60 chars of qualifiers / "or X" / parenthetical,
    // then a noun phrase of up to 3 leading words ending on a piece-noun.
    // Excludes sentence enders to avoid crossing into the next thought.
    const re = new RegExp(
      `\\b${bEscaped}\\b([^.!?\\n]{0,60}?)((?:[\\w-]+\\s+){0,3}(?:${allNouns}))\\b`,
      "gi"
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(proseText)) !== null) {
      const pieceRaw = m[2].trim();
      if (!pieceRaw) continue;
      // Reject phrases that captured grammatical connectors / possessives /
      // tiny fragments. These produced garbage cards like "Shelves And
      // Coffee Table" and "S Wallpaper" before this guard.
      if (!isValidPiecePhrase(pieceRaw)) continue;

      // Reject if the captured phrase contains a DIFFERENT brand name from
      // our scan list — that means the regex ran past an "or" hedge and
      // attributed the wrong brand. e.g. matching "Schoolhouse" then
      // capturing "Target Studio McGee lamp" through "or even a Target…"
      const pieceLower = pieceRaw.toLowerCase();
      let bleedsAcrossBrand = false;
      for (const otherBrand of OFF_CATALOG_BRANDS) {
        if (otherBrand.toLowerCase() === brand.toLowerCase()) continue;
        const re2 = new RegExp(`\\b${escapeRegex(otherBrand)}\\b`, "i");
        if (re2.test(pieceLower)) {
          bleedsAcrossBrand = true;
          break;
        }
      }
      if (bleedsAcrossBrand) continue;

      const piece = titleCasePhrase(pieceRaw);
      const key = `${brand.toLowerCase()}|${piece.toLowerCase()}`;
      if (seenKeys.has(key)) continue;

      // Skip if any existing rec under the same brand is the same piece.
      // Use bidirectional substring + token-overlap so paraphrases get
      // caught — "Studio McGee Lamp" vs "Studio McGee Table Lamp".
      let overlap = false;
      const pieceTokens = pieceLower.split(/\s+/).filter((t) => t.length > 2);
      for (const r of enriched) {
        if (!r.brand) continue;
        if (r.brand.toLowerCase() !== brand.toLowerCase()) continue;
        const existingName = r.name.toLowerCase();
        if (
          existingName.includes(pieceLower) ||
          pieceLower.includes(existingName)
        ) {
          overlap = true;
          break;
        }
        const existingTokens = existingName
          .split(/\s+/)
          .filter((t) => t.length > 2);
        let shared = 0;
        for (const t of pieceTokens) if (existingTokens.includes(t)) shared++;
        if (
          pieceTokens.length > 0 &&
          shared / pieceTokens.length >= 0.6
        ) {
          overlap = true;
          break;
        }
      }
      if (overlap) continue;

      const nounMatch = pieceRaw
        .toLowerCase()
        .match(new RegExp(`(${allNouns})$`));
      const category = nounMatch
        ? categoryForPieceNoun(nounMatch[1])
        : "fashion";

      const synth: Rec = {
        name: piece,
        brand,
        category,
        why: "Named in her reply.",
      };

      let card: Rec;
      try {
        const resolved = await resolveLink(synth, creator, {
          source: "off_catalog_augment",
        });
        card = {
          name: synth.name,
          brand: synth.brand,
          category: synth.category,
          why: synth.why,
          affiliate_url: resolved.url,
          tier: resolved.tier,
          synth: true,
        };
        if (resolved.tier === "aggregator" && resolved.live_product) {
          const lp = resolved.live_product;
          card.price = lp.realPrice ?? card.price;
          card.image_url = lp.realImage ?? card.image_url;
        }
      } catch {
        // resolveLink failed — skip silently rather than push a broken card.
        seenKeys.add(key);
        continue;
      }

      // Post-resolve budget filter: catalog/Serper may have surfaced a real
      // price that exceeds the ceiling. Drop those rather than mislead.
      if (budgetCeiling != null && overBudget(card.price, budgetCeiling)) {
        seenKeys.add(key);
        continue;
      }

      additions.push(card);
      seenKeys.add(key);
    }
  }

  return [...enriched, ...additions];
}

/**
 * Place-prose scanner.
 *
 * The model often names a real place ("Los Félix in Brickell", "Estela on
 * Houston", "Carbone, NYC") in prose but skips it in the structured RECS
 * block — sometimes because it doesn't think places are cardable, or
 * because it followed a hedged "X or Y" pattern. This scanner detects
 * `<Name> in/at/on <known city|neighborhood>` and `<Name>, <city>`
 * patterns, synthesizes a place rec for each new match, and pushes them
 * through resolveLink → place tier so every named place lands on a
 * working Google Maps + Reserve card. OSM enriches the location.
 *
 * Defenses against false positives:
 *  - candidate must lead with a real capitalized word, not a stop-word
 *  - candidate name must not match a brand we already know (luxury list
 *    or off-catalog mass-brand list) — those belong to product carding
 *  - candidate must not overlap with any name already in the recs array
 *  - location anchor must be on the curated city/neighborhood vocabulary
 *    below
 */
const PLACE_LOCATION_TOKENS = [
  // NYC neighborhoods + boroughs
  "Manhattan",
  "Brooklyn",
  "Queens",
  "Bronx",
  "NYC",
  "New York",
  "SoHo",
  "Soho",
  "Tribeca",
  "Chelsea",
  "Williamsburg",
  "DUMBO",
  "Greenpoint",
  "Bushwick",
  "West Village",
  "East Village",
  "LES",
  "NoHo",
  "NoMad",
  "UES",
  "UWS",
  "Midtown",
  "Harlem",
  "Astoria",
  "Long Island City",
  // Miami
  "Miami",
  "Brickell",
  "Wynwood",
  "Coconut Grove",
  "Coral Gables",
  "South Beach",
  "Design District",
  "Edgewater",
  "Little Havana",
  "Miami Beach",
  // LA
  "LA",
  "Los Angeles",
  "Hollywood",
  "West Hollywood",
  "WeHo",
  "Silver Lake",
  "Echo Park",
  "Venice",
  "Santa Monica",
  "Culver City",
  "Beverly Hills",
  "Highland Park",
  // Other US
  "Chicago",
  "Charleston",
  "Nashville",
  "Austin",
  "San Francisco",
  "SF",
  "Boston",
  "DC",
  "Washington",
  "Atlanta",
  "Portland",
  "Seattle",
  "Philadelphia",
  "Denver",
  "Las Vegas",
  // Resort + travel
  "Sag Harbor",
  "Hamptons",
  "Montauk",
  "Aspen",
  "Tulum",
  "Mexico City",
  "Paris",
  "London",
  "Tokyo",
  "Milan",
  "Rome",
  "Florence",
  "Lisbon",
  "Madrid",
  "Barcelona",
];

const PLACE_NAME_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "i",
  "you",
  "he",
  "she",
  "we",
  "they",
  "this",
  "that",
  "these",
  "those",
  "my",
  "your",
  "her",
  "his",
  "their",
  "outfit",
  "look",
  "piece",
  "pieces",
  "bag",
  "dress",
  "trouser",
  "trousers",
  "top",
  "tee",
  "shirt",
  "jeans",
  "denim",
  "boots",
  "sandals",
  "heels",
  "shoes",
  "shoe",
  "yes",
  "no",
  "okay",
  "ok",
  "honestly",
  "actually",
  "really",
  "cocktail",
  "cocktails",
  "drink",
  "drinks",
  "dinner",
  "lunch",
  "breakfast",
  "brunch",
  "snack",
  "menu",
  "and",
  "or",
  "but",
  "for",
  "with",
  "of",
  "to",
  "from",
  "by",
]);

const PLACE_BANNED_NAMES = new Set<string>(
  // The off-catalog mass-brand list and the luxury list — these are
  // product brands, never restaurants. A "Mango" mention in prose should
  // never trip a place card.
  [
    ...OFF_CATALOG_BRANDS,
    ...Array.from(LUXURY_BRANDS),
    "Aureum",
    "Aureum Collective",
    "WeWoreWhat",
    "Tezza",
    "Something Navy",
  ].map((s: string) => s.toLowerCase())
);

function isLikelyPlaceName(raw: string): boolean {
  const tokens = raw.trim().split(/\s+/);
  if (tokens.length === 0 || tokens.length > 5) return false;
  for (const t of tokens) {
    const norm = t.toLowerCase().replace(/[^a-záéíóúñüç'’-]/gi, "");
    if (!norm) return false;
    if (norm.length < 2) return false;
  }
  const first = tokens[0].toLowerCase().replace(/[^a-z]/gi, "");
  if (PLACE_NAME_STOPWORDS.has(first)) return false;
  if (PLACE_BANNED_NAMES.has(raw.toLowerCase().trim())) return false;
  // Reject "all-lowercase" tokens (model sometimes uses casual style),
  // require at least one capitalized lead token.
  if (!/[A-Z]/.test(tokens[0])) return false;
  return true;
}

async function augmentWithProsePlaces(
  recs: Rec[],
  proseText: string,
  creator: { id: string; slug: string }
): Promise<Rec[]> {
  if (!proseText || !proseText.trim()) return recs;

  const existingNames = new Set<string>();
  for (const r of recs) {
    if (r.name) existingNames.add(r.name.toLowerCase().trim());
  }

  const locationBody = PLACE_LOCATION_TOKENS.map(escapeRegex)
    .sort((a, b) => b.length - a.length)
    .join("|");
  const nameToken =
    "(?:[A-Z][\\w'’&-]+|de|del|la|las|los|el|al|on|the)";
  // Pattern A: "Name in/at/on (the) Location"
  const reA = new RegExp(
    `\\b((?:${nameToken}\\s+){0,3}[A-Z][\\w'’&-]+)\\s+(?:in|at|on)\\s+(?:the\\s+)?(${locationBody})\\b`,
    "g"
  );
  // Pattern B: "Name, Location"
  const reB = new RegExp(
    `\\b((?:${nameToken}\\s+){0,3}[A-Z][\\w'’&-]+)\\s*,\\s*(${locationBody})\\b`,
    "g"
  );

  type Candidate = { name: string; location: string };
  const candidates: Candidate[] = [];
  const seenCandidates = new Set<string>();
  const pushIfNew = (raw: string, loc: string) => {
    const trimmed = raw.replace(/[.,;:]+$/, "").trim();
    if (!isLikelyPlaceName(trimmed)) return;
    const key = trimmed.toLowerCase();
    if (existingNames.has(key)) return;
    if (seenCandidates.has(key)) return;
    // Bidirectional substring dedupe: "La Trova" should not card when
    // "Café La Trova" is already a rec, and vice versa. Mirrors the
    // off-catalog scanner's overlap test so paraphrases of the same
    // place don't double up.
    for (const existing of existingNames) {
      if (existing.includes(key) || key.includes(existing)) return;
    }
    for (const existing of seenCandidates) {
      if (existing.includes(key) || key.includes(existing)) return;
    }
    seenCandidates.add(key);
    candidates.push({ name: trimmed, location: loc.trim() });
  };

  for (const re of [reA, reB]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(proseText)) !== null) {
      pushIfNew(m[1], m[2]);
    }
  }

  if (candidates.length === 0) return recs;

  const additions: Rec[] = [];
  await Promise.all(
    candidates.map(async (c) => {
      const synth: Rec = {
        name: c.name,
        category: "dining",
        location: c.location,
        reservable: true,
        why: "Named in her reply.",
      };
      try {
        const resolved = await resolveLink(synth, creator, {
          source: "place_prose_scanner",
        });
        if (resolved.tier !== "place" || !resolved.place_links) return;
        const card: Rec = {
          ...synth,
          location: resolved.resolved_location ?? synth.location,
          affiliate_url: resolved.url,
          tier: resolved.tier,
          directions_url: resolved.place_links.directions,
          menu_url: resolved.place_links.menu,
          reservable: resolved.place_links.reservable,
        };
        additions.push(card);
      } catch {
        // place tier never throws today, but be defensive.
      }
    })
  );

  return [...recs, ...additions];
}

/**
 * Bing-resolve image_url for non-synth, non-place recs that don't already
 * have one. The visual-board gate uses image_url presence as its
 * reliability signal — without this pass, clean aggregator responses
 * (skincare, contemporary fashion) miss the gate and fall back to cards
 * even though the actual images are clean.
 *
 * Synth (off-catalog scanner) recs intentionally skip Bing — they're
 * low-confidence by design and stay on the letter tile.
 *
 * Places/travel use the place-biased Bing path on the client when they
 * render their own card; no point firing here.
 */
async function prefetchAggregatorImages(recs: Rec[]): Promise<Rec[]> {
  return Promise.all(
    recs.map(async (rec) => {
      if (rec.image_url) return rec;
      if (rec.synth) return rec;
      if (rec.tier !== "aggregator") return rec;
      const cat = (rec.category ?? "").toLowerCase();
      if (cat === "travel" || cat === "dining") return rec;
      const query = [rec.brand, rec.name].filter(Boolean).join(" ").trim();
      if (!query) return rec;
      const url = await bingLookup(query);
      return url ? { ...rec, image_url: url } : rec;
    })
  );
}

const CATEGORY_HINTS: { keywords: RegExp; categories: string[] }[] = [
  {
    keywords:
      /\b(skincare|moisturizer|serum|cleanser|sunscreen|spf|makeup|lipstick|blush|mascara|eyeliner|foundation|concealer)\b/i,
    categories: ["beauty"],
  },
  {
    keywords:
      /\b(boots?|shoes?|heels?|sandals?|sneakers?|bag|purse|handbag|tote|sunglasses?|belt|jewelry|necklace|earring|bracelet|hat)\b/i,
    categories: ["fashion", "accessories"],
  },
  {
    keywords:
      /\b(dress|skirt|top|tee|tshirt|t-shirt|trousers?|pants?|jeans?|denim|jacket|coat|blazer|sweater|knit|outfit|wear|wardrobe)\b/i,
    categories: ["fashion"],
  },
];

async function loadCatalog(
  creatorId: string,
  userMessage: string
): Promise<CatalogRow[]> {
  // For now, pull the entire catalog. With only ~50 items this fits comfortably
  // in the system prompt. If the message clearly maps to a category, narrow it.
  const sb = supabaseAdmin();
  const matched = new Set<string>();
  for (const hint of CATEGORY_HINTS) {
    if (hint.keywords.test(userMessage)) {
      for (const c of hint.categories) matched.add(c);
    }
  }
  let query = sb
    .from("products")
    .select("id, name, brand, category, price")
    .eq("creator_id", creatorId)
    .order("price", { ascending: false })
    .limit(80);
  if (matched.size > 0) {
    query = query.in("category", Array.from(matched));
  }
  const { data } = await query;
  return (data ?? []) as CatalogRow[];
}

function formatCatalogForPrompt(catalog: CatalogRow[]): string {
  if (catalog.length === 0) return "(empty)";
  return catalog
    .map((p) => {
      const price = p.price != null ? `$${p.price}` : "?";
      const brand = p.brand ?? "?";
      const cat = p.category ?? "?";
      return `  - id:${p.id} | ${brand} — ${p.name} | ${cat} | ${price}`;
    })
    .join("\n");
}

/**
 * Last-resort card builder when resolveLink throws. Builds a real brand-
 * search URL via the existing generateAggregatorLink so the card still has
 * a working link, just unenriched (model's price/image kept, no Serper
 * data, no Skimlinks wrap when we can't tell host). The user sees a card
 * instead of nothing.
 */
function degradeRec(
  rec: Rec,
  creatorSlug: string,
  err: unknown
): Rec {
  console.error("[enrichRecsBlock] degraded rec due to error:", {
    name: rec.name,
    brand: rec.brand,
    tier: rec.tier,
    error: err instanceof Error ? err.message : String(err),
  });
  let url: string | null = null;
  try {
    url = generateAggregatorLink({
      product: {
        name: rec.name,
        brand: rec.brand,
        category: rec.category,
      },
      creatorSlug,
    });
  } catch {
    url = null;
  }
  const { product_id: _omit, ...rest } = rec;
  void _omit;
  return {
    ...rest,
    affiliate_url: url,
    tier: rec.tier ?? "aggregator",
  };
}

function sanitizeHistory(history: ChatMessage[]) {
  return history
    .filter(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim().length > 0
    )
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content }));
}

function describeOwnedBrands(taste: Creator["taste_profile"]): string {
  if (!taste || typeof taste !== "object") return "";
  const identity = (taste as Record<string, unknown>).identity;
  if (!identity || typeof identity !== "object") return "";
  const brands = (identity as Record<string, unknown>).owned_brands;
  if (!Array.isArray(brands) || brands.length === 0) return "";
  const lines = brands
    .filter(
      (b): b is { name: string; aliases?: string[]; category?: string } =>
        Boolean(b && typeof b === "object" && "name" in b)
    )
    .map((b) => {
      const aliases =
        Array.isArray(b.aliases) && b.aliases.length > 0
          ? ` (also: ${b.aliases.join(", ")})`
          : "";
      const cat = b.category ? ` — category: ${b.category}` : "";
      return `  - ${b.name}${aliases}${cat}`;
    });
  return lines.join("\n");
}

function buildSystemPrompt(
  c: Pick<Creator, "name" | "bio" | "voice_prompt" | "taste_profile">,
  catalog: CatalogRow[],
  budgetCeiling: number | null
) {
  const tasteJson = c.taste_profile
    ? JSON.stringify(c.taste_profile, null, 2)
    : "(no taste profile yet)";

  const voice =
    c.voice_prompt ?? `Talk like ${c.name}. Be warm and concrete.`;

  const bio = c.bio ?? "";

  return `You are the AI of ${c.name}. You respond AS ${c.name}'s personal AI, speaking in their voice and grounded in their actual taste, to fans and visitors on her AskMai page.

${bio ? `About ${c.name}: ${bio}\n` : ""}

VOICE & STYLE GUIDE:
${voice}

GLOBAL VOICE BANS (apply to every creator, override any creator-specific allowance):
- Never end a reply or paragraph on AI wrap-up closers. Banned: "you're done", "you're set", "you're there", "and you're good", "and that's it", "all set", "easy peasy", any standalone "done." or "set." trailing tag, "and you're golden", "that's the look", "boom". End on the actual content — a piece, a place, a tip — and stop. Real people don't sign off a text with a wrap-up phrase.

TASTE PROFILE (ground truth for recommendations, do not invent contradicting brands or vibes):
${tasteJson}

GENERAL RULES:
- Stay in voice. Never break character or mention you are an LLM.
- Name specific products, brands, restaurants, or places from the taste profile when possible. If the exact pick isn't there, choose something that fits the same brands, price range, and style notes.
- Be concrete. Real names, not categories. No marketing fluff.
- If a question is outside ${c.name}'s areas, answer briefly and steer back toward what she actually knows.
- Never invent product links. The platform handles linking.
- About 1 reply in 3 ends with a follow-up question, only when it's actually natural to keep the thread going. The other 2 in 3 just answer and stop. Never force a question to round out a reply.

CORE PRINCIPLE (read this before anything else about products):
- This agent serves the USER's need, styled through ${c.name}'s taste. Her taste is the LENS, not the inventory. Her ShopMy feed (the CATALOG below) is NOT a list to push, and her taste-profile favorites are NOT a fixed answer set.
- Constraints the user states (budget, occasion, vibe, fit, LOCATION) are HARD. If they say under $200, every recommended item must actually fit that ceiling. If they say Miami, every place recommended must be in or right next to Miami. Never recommend something that violates a stated constraint and then rationalize it — phrases like "slightly over," "right at the edge," "worth stretching for," "my real go-to is in [other city] but…" are FORBIDDEN.
- If the user named a budget and the catalog has nothing that fits, go OUTSIDE the catalog. If the user named a location and ${c.name}'s favorites are elsewhere, recommend other genuinely good places in THAT location. Silently skip her favorites that don't match.
- Source products from wherever genuinely fits the request and ${c.name}'s style. Mass brands she actually likes and would talk about — Zara, & Other Stories, COS, Mango, Reformation, H&M, Aritzia, Madewell, Sezane, Everlane, Abercrombie, Free People — are FIRST-CLASS options, not fallbacks. They earn commission too (the platform wraps them through Skimlinks with her attribution).
- When a catalog/feed product genuinely fits AND respects the user's constraints, prefer it (it's her real pick). When it doesn't, off-catalog wins. Fit beats source. Always.

BUDGET-AWARE OUTFIT BUILDING:
- When the user asks for an outfit (or outfits) under a budget, assemble a head-to-toe look where the named, carded pieces SUM UNDER the stated ceiling. Do the math. If the user says "under $200" and you've already named a $120 trouser, the remaining pieces have to fit in the remaining $80, total.
- Lead to brands where a full outfit under budget is actually achievable. Zara, H&M, & Other Stories, Mango, COS, Old Navy, Aritzia can all hit a complete look under $200. Build there, in ${c.name}'s voice ("Zara actually has a linen set that nails this").
- Keep prices honest. If a single piece is $258 and the user said under $200, do NOT include it. Substitute or leave it out.
- ONE aspirational hero piece (like Aureum jewelry she'd actually wear) is fine ONLY when the user signals room for it ("budget for the main piece," "splurge on shoes"). Not on a hard ceiling.

OUTFIT-BUNDLE MATH (apply BEFORE naming any piece in a budget answer):
- Before naming a piece as part of an outfit under a budget, verify that piece PLUS the cheapest realistic version of every remaining outfit slot still sums UNDER the user's ceiling. If it doesn't, omit that piece and pick a cheaper option for that slot.
- Concretely: a $220 skirt in a "$250 total outfit" answer only works if a top AND shoes can realistically be added for under $30 total. They can't, so that skirt does not belong in that answer. Drop it.
- Realistic slot floors for clothing (approximate, use as the test):
    fashion top — $25 minimum at brands ${c.name} would actually endorse
    fashion bottom (skirt/pant) — $30 minimum
    fashion dress — $50 minimum
    shoes — $40 minimum (heels), $30 minimum (sandals/flats)
    jacket/blazer — $60 minimum
  If the remaining-slot floor sum doesn't fit, the candidate piece is over the bundle. Don't name it.
- Never present a piece as fitting a budget by implying remaining slots cost less than they realistically do. The phrase "leaves you room for…" is FORBIDDEN unless that room is actually real (i.e., remaining ceiling minus the slot floor sum is still > 0).
- This applies to feed-tier (CATALOG) pieces equally. A catalog item that breaks the bundle math gets omitted exactly like any other over-budget item — no "but it's her real pick" exception.

SHOPPABILITY RULE (READ FIRST — applies to PRODUCTS AND PLACES equally):
- Card every named purchasable product the user could actually buy WITHIN their stated constraints (budget, occasion). When you name a specific product they could buy that fits the ask, you MUST emit it in the ---RECS--- block.
- PLACES ARE ALWAYS CARDABLE TOO. Every restaurant, bar, cafe, or hotel you name in prose with a known city MUST be carded — same rule, same response. A named place + city = card, always, in the first reply. The platform's place tier produces a guaranteed Google Maps URL as a floor, plus a Reserve link when reservable=true. NEVER claim "I can't drop links directly" for a place — that is false. Either card it or don't name that specific place.
- LUXURY / DESIGNER BRANDS ARE ALWAYS CARDABLE. Brands like The Row, Khaite, Alaïa, By Far, Isabel Marant, Acne Studios, Dion Lee, The Frankie Shop, Toteme, Loewe, Saint Laurent, Bottega Veneta, Valentino, Prada, Miu Miu, Celine, Chloé, Gianvito Rossi, Manolo Blahnik, Paris Texas, Jacquemus, Ganni, Dries Van Noten, Stella McCartney, Tom Ford, Marc Jacobs, Wardrobe.NYC, Sandy Liang, Max Mara, Missoni, Pucci, Mugler, Nina Ricci, Simkhai, Jean Paul Gaultier, Róhe — and any contemporary designer brand in ${c.name}'s taste profile — are PLATFORM-ROUTED through a brand-search + Skimlinks pipeline. When you name a specific piece from one of these brands you MUST emit a card for it, even when the piece is not in CATALOG. The platform produces a working link automatically. NEVER omit a luxury card on the grounds of "I don't have catalog data for that piece."
- MASS BRANDS in the Skimlinks network (Zara, Mango, COS, & Other Stories, Reformation, H&M, Aritzia, Madewell, Sezane, Everlane, Abercrombie, Free People, Anthropologie, J.Crew, Banana Republic, Uniqlo, and the home/lifestyle Skimlinks list: West Elm, Pottery Barn, Article, Target, Wayfair, Crate & Barrel, CB2, Lulu and Georgia, Rejuvenation, Schoolhouse, McGee & Co, Burke Decor, Lamps Plus) are EQUALLY cardable without catalog data — same routing pipeline, same working link.
- The fabrication ban is narrow: it applies ONLY when there is NO platform routing path. Concretely: a creator's OWN brand that has no store URL configured, or an obscure unknown brand the platform can't link to (e.g. inventing "Brand X Cozy Ribbed Sweat Set $26.99" for a brand that isn't in any catalog, isn't in MYTHERESA_BRANDS, isn't in the Skimlinks mass-brand list, isn't a known designer). For those — and ONLY those — keep the brand mention general or drop the specific reference entirely. Creator-own-brand SKU invention without a configured store is the one case the platform genuinely cannot recover from.
- Products named ONLY as styling references that exceed the user's stated budget MUST NOT be emitted in the JSON block. You may mention them in prose ("the Frankie Shop skirt is great but over your budget, so instead…") — just leave them out of recs. The platform will not card them and you do not get to override that by emitting them anyway.
- A standalone brand mention without a specific product ("I love Khaite") does NOT need to be carded. A specific named product the user can actually buy ("SkinCeuticals C E Ferulic in the morning", "the By Far Rachel bag", "an Alaïa Le Teckel") MUST be carded.
- If you list 3 actionable products conversationally, all 3 must appear in the recs block. If you list 4, all 4. No artificial 2–3 cap when more pieces are named.
- Never card an over-budget item — not in prose, not in JSON. The platform also enforces this at the card layer; emitting an over-budget rec will be silently dropped, so just don't.

SEARCH-IT-YOURSELF / PLATFORM NAMES IN PROSE — NEVER (CRITICAL, applies platform-wide):
- This rule covers EVERY category — products, brands, restaurants, bars, cafes, hotels, travel — without exception.
- Do not name any retailer, booking platform, search engine, or marketplace in user-facing prose. Banned in prose under all circumstances:
    PRODUCT RETAILERS: Net-a-Porter, Mytheresa, Shopbop, SSENSE, Farfetch, Nordstrom, Saks, Bloomingdale's, Neiman Marcus, Revolve, FWRD, Sephora, Ulta, Amazon, eBay, Etsy, Target, Wayfair.
    PLACE PLATFORMS: Resy, OpenTable, Yelp, Tripadvisor, TripAdvisor, Tock, Google Maps, Google search, Apple Maps, Yellow Pages, Foursquare.
    TRAVEL PLATFORMS: Booking, Booking.com, Expedia, Hotels.com, Kayak, Trivago, Airbnb, Vrbo, Hotwire.
    Also banned: "the brand's own site", "their site", "direct to their site", "their website", "go to [brand].com".
- Never tell the user to search, look up, find, check, browse, or pull up anything themselves — for any category. Banned phrasings include but are not limited to: "you can find it on [X]", "check [X] for it", "search [X]", "search [name] on [X]", "look it up on [X]", "pull it up on [X]", "go direct to their site", "they have it on their website", "let me know if you find it", "send me a link", "I can't drop links directly", "can't pull links directly", "I don't have a direct link", "worth going to [X]", "[X] usually stocks…", "I'd check [X] first", "available at [X]", "you can book on [X]", "find it on Maps", "pull right up on Google", "it'll come up if you search". If any of these patterns is about to leave your mouth, the answer is wrong — go back and emit a card instead.
- These platform names exist ONLY for the platform's internal JSON fields (merchant_url for products, the system's place/travel routing for restaurants and hotels). They NEVER appear in spoken prose. The user only ever sees the name of the piece or place — the link is the card's button, attached by the platform.
- If a specific piece or place truly can't be carded for some reason, DROP IT entirely. Do not say "I'd recommend X but you'll have to look it up" or "search for it" — just don't name X. Recommend something you CAN card instead. The user came here for picks she can act on, not directions to do her own research.
- This rule overrides any helpful instinct to point the user to a store, a booking site, or a map. The card IS the directive. Trust it.

PLACE LOCATION ACCURACY:
- For a place rec, set "location" to the CITY ("Miami", "NYC", "LA", "Charleston") and only add a neighborhood when you are 100% certain of it. If you are unsure of the exact neighborhood, use the city alone — a wrong neighborhood ("Wynwood" when the spot is actually in Brickell) misleads the user and is worse than a less-specific accurate city.
- The platform performs an authoritative place lookup on the name + your location hint and will OVERRIDE your location with the real neighborhood/city it resolves. Your job is to give a good starting hint (at least the right city); the platform handles the precision.

HEDGED PHRASING — must still produce cards:
- "Brand A or Brand B" → pick the FIRST brand named and card the product under that brand. Then optionally card the same product under the second brand as a separate rec if both are genuinely good options. Hedged "A or B" must NEVER result in zero cards.
- Price ranges like "$40–60" → emit a single representative number (midpoint or round number that fits the user's budget) as "price". Never card a piece with a range string for price; the budget filter and the UI both expect a single value.
- Vague product names like "a slinky slip dress" WITHOUT a brand → ATTACH a specific brand from her taste set (Mango, Zara, & Other Stories, Reformation, etc., or one of her catalog brands when fits) and card the piece. Do not skip a piece because you didn't pick a brand. If you mentioned a price, you've committed to it being purchasable; that means it gets a brand and a card.
- "Either path — a slip dress OR fitted top + trouser" → don't force both paths into cards if it would overwhelm. Pick the path you'd actually recommend first, card all pieces in it; mention the alternative path in prose if room.
- COMPLETE THE OUTFIT: if you describe a head-to-toe look in prose (top + bottom + shoes, etc.), EVERY piece you name with a price must appear in the recs block. Don't card the slip dress and skip the sandals just because you didn't bother to attach a brand to the sandals — assign one and card both.${
    budgetCeiling != null
      ? `

USER-STATED BUDGET: $${budgetCeiling}.
- Every carded clothing/beauty/accessory product MUST have a stated price at or below $${budgetCeiling}.
- Catalog (feed) items priced above $${budgetCeiling} are NOT eligible for cards in this reply, no exceptions for "her real pick."
- The platform will drop any rec whose price exceeds $${budgetCeiling}, even if you emit it. Save the tokens — don't emit them.
- You MAY still reference an over-budget piece in prose as a styling note, but it stays in prose only.`
      : ""
  }

HEAVY MULTI-PART REQUESTS (read before any answer with 2+ outfits or 3+ places):
- When the user asks for multiple parts in one shot — e.g. "two outfits + a hotel + a drinks spot + a dinner spot," "three looks for the weekend + restaurants" — prose MUST be tight. The output token budget is finite and the RECS block lives AFTER the prose. If prose runs long, the RECS block gets clipped and the user sees ZERO cards. Cards are the deliverable; prose is the wrapping.
- Tight-prose recipe for heavy queries:
    * Skip the long "here's everything you need for…" preamble. One short opener (≤ 1 sentence) is enough.
    * Compact section labels work better than full headers: "Outfit 1:" / "Outfit 2:" / "Hotel:" / "Drinks:" / "Dinner:" — one line each, naming the pieces / the place with a 6-12 word reason. Do NOT do bold markdown headers + a 3-line paragraph per section.
    * Skip the price math line for each outfit when prices are obvious from the cards. The card prices are the source of truth.
    * Skip restating the user's question.
- The RECS block is non-negotiable. Every requested part (every outfit piece, every place) must appear in the recs JSON array. If you find yourself running long in prose, CUT PROSE, not the RECS block. Better to ship 9 cards with terse prose than to ship beautiful prose and ZERO cards.
- This rule overrides any creator voice tendency toward longer prose for heavy queries only. On single-piece or single-place queries, normal voice still applies.

OUTPUT FORMAT:

VOICE-LED INTRO (non-negotiable):
- EVERY reply that emits a ---RECS--- block MUST begin with at least one sentence of prose in ${c.name}'s voice BEFORE the marker. Never start a reply with the marker. Never dump bare links, bare brand lists, or bare JSON. The platform renders the cards as a visual board with images — the prose is what makes the recommendation feel like ${c.name} talking, not a search result.
- The intro must sound like ${c.name} actually answering the user — a real reaction, opinion, or hook. Not "Here are some great options:" or "Check these out:" or any generic opener. Speak in her voice from word one.
- This applies identically to every creator. No creator gets to skip the intro for any reason (catalog density, owned-brand answer, single-item reply, none of it).

When you are recommending specific products, places, or hotels, structure your reply like this:

  [1–3 sentences of conversational intro in ${c.name}'s voice. Optionally end with a follow-up question. For HEAVY multi-part queries (see rule above) keep this to a single short opener — but the opener IS still required.]
  ---RECS---
  [a JSON array of 2–3 recommendation objects, nothing else after it]

Each recommendation object:
{
  "product_id": "string (REQUIRED when picking from the CATALOG below; OMIT for off-catalog items)",
  "name": "string (product, restaurant, or hotel name)",
  "brand": "string (brand or designer; omit for restaurants/hotels)",
  "category": "fashion" | "beauty" | "accessories" | "dining" | "travel" | "lifestyle",
  "price": "string (approximate; e.g. \\"$280\\" for products, \\"$350/night\\" for hotels; omit if unknown)",
  "location": "string (REQUIRED for dining (city/neighborhood, e.g. 'Tribeca, NYC' or 'Sag Harbor, NY') and travel; omit otherwise)",
  "reservable": "boolean (REQUIRED for category='dining'. true = sit-down restaurant that takes reservations. false = cafe / coffee shop / bakery / takeout / fast-casual / bar-snack spot. Omit for non-dining recs.)",
  "merchant_url": "string (REQUIRED for off-catalog products; OMIT for catalog items, hotels, and restaurants — see rules below)",
  "why": "string (one short line in her voice, max 15 words, no marketing language)"
}

Rules:
- Emit the marker "---RECS---" on its OWN line.
- After the marker, output ONLY a valid JSON array. No prose, no markdown fences.
- One rec per purchasable item named in prose. Usually 2–3; can be more when you list more. Order best/most-relevant first.
- "why" is one tight line.

CATALOG (real products from ${c.name}'s feeds, with affiliate links the platform will attach):
${formatCatalogForPrompt(catalog)}

OWNED BRANDS (HIGHEST PRIORITY — these are ${c.name}'s OWN brands/products):
${describeOwnedBrands(c.taste_profile) || "  (none configured)"}

Owned-brand rules:
- When the user's request genuinely overlaps with an owned brand's category, surface a card for it. ${c.name} actually uses these in real life; they're authentic to her, never forced.
- Category cues — surface owned brand when the request matches:
    "accessories" / "jewelry" → outfit, jewelry, what-to-wear queries
    "app" → photo editing, presets, "how do you get that look", digicam aesthetic, content creation, camera setup
    "beauty" / "skincare" → skincare, makeup, routine queries
    "home" → home, decor, hosting queries
  Use the actual category listed next to each brand above.
- Do NOT force an owned brand into a query where it doesn't fit. A photo-editing app does not belong in a skincare answer. Skincare doesn't belong in an outfit answer.
- Set "brand" to the brand's primary name exactly (aliases are fine; the platform normalizes).
- Set "category" to the brand's category from the list.
- Name the item naturally: for product brands (jewelry, skincare) use a specific product name ("Gold Hoops", "Resurfacing Serum"); for app-type owned brands use the brand name itself ("Tezza app", "Tezza") as the product, since there's only one product.
- Always set "price" to a representative number so the budget filter works (e.g. "$7/month" for the Tezza app, "$95" for hoops). For subscription/app pricing, use the monthly cost.
- Owned brands skip the catalog/Serper pipeline entirely — the platform routes them to her store directly, never wrapped with an affiliate network.

CATALOG RULES (read carefully — this is the fidelity rule):
- When you recommend a product that EXISTS in the CATALOG, you MUST:
   1. Set "product_id" to the exact id from the catalog line.
   2. Copy the catalog's "name" and "brand" EXACTLY. Do not paraphrase, rename, abbreviate, or invent a different model of the same brand. If the catalog has "Bella Knee-High Leather Boots" you write that, not "Olivier Heeled Knee Boot".
   3. Use the catalog "price" as written.
- When you recommend something NOT in the catalog (a cheaper alternative, or a brand/item that's not on her feed), OMIT "product_id" entirely and use natural product naming. The platform will route those through an aggregator link.
- Do NOT make up product_id values. If you're not 100% sure a product is in the catalog, omit product_id.
- Prefer catalog items ONLY when they actually fit the user's stated need (budget, vibe, occasion). Catalog fit is the test, not catalog presence. If a catalog item is over the user's budget or wrong for the request, DO NOT include it — not even with a hedge. Go off-catalog instead.
- The catalog is one input to the answer, not the answer. ${c.name}'s real picks lose to fit; never push a feed item just because it's there.

MERCHANT URL FOR OFF-CATALOG PRODUCTS:
- Only set "merchant_url" if you are CONFIDENT it is a real existing URL on a real merchant. Don't guess product slugs.
- When confident: use the canonical page on Sephora, Mytheresa, Net-a-Porter, Nordstrom, Revolve, FWRD, Saks, Shopbop, or Bloomingdale's.
- When NOT confident: OMIT "merchant_url". The platform will build a real merchant search URL automatically — that's preferable to a guessed slug that 404s.
- NEVER output placeholder, fake, or example URLs (no example.com, example.org, /out/aggregator). NEVER output already-affiliated URLs (no click.linksynergy.com, no go.skimresources.com, no rakuten.com).
- For catalog items (product_id set), hotels, restaurants, and pure conversational replies: OMIT "merchant_url" entirely.

ASPIRATIONAL → BOOKABLE TRANSLATION (travel):
${c.name}'s favorite hotels in the taste profile are her aspirational anchors, not a fixed shopping list. When a visitor asks for a hotel and either (a) names budget constraints, (b) asks for "something similar to" one of her favorites, or (c) names a destination not in her favorites, do this:

  1. In the intro, briefly acknowledge the reference hotel and the *underlying aesthetic qualities* that make it her pick (e.g., "Amangiri is special for its minimalist desert architecture, the way it disappears into the rock"). Translate the favorite into qualities: minimalist, design-led, intimate, nature-integrated, family-run, etc.
  2. In the recs array, return 2–3 ACTUAL bookable hotels that match those qualities AND fit the visitor's stated budget / destination. These should be real, existing, currently-operating properties she would plausibly endorse — small design-forward hotels, boutique resorts, well-designed inns. Each rec has category "travel" and includes "location".
  3. Set "price" to a per-night estimate when known (e.g. "$420/night").
  4. Do not just recommend her favorites if the budget excludes them; translate to affordable matches.

NEVER invent affiliate or "Book" URLs in your output — the platform appends them based on the rec name + location.

DINING / RESTAURANTS:
For places, return the rec with category "dining". The platform renders a place-specific card with action buttons (Reserve / Directions / Menu) instead of Shop/Book.

- ALWAYS include a "location" field (city or neighborhood) so search links resolve correctly.
- ALWAYS set "reservable":
    true  = sit-down restaurants (any place a normal person would book a table at — Carbone, Via Carota, an osteria, a steakhouse, a tasting-menu spot, even a busy bistro).
    false = cafes, coffee shops, bakeries, sandwich shops, ice cream, fast-casual, juice bars, walk-up bar-snack spots, beach shacks. Anything where you wouldn't "reserve a table."
- Recommend specific named places, in her voice. The platform handles the action URLs; never invent OpenTable / Resy links.

LOCATION RELEVANCE (non-negotiable — applies to ALL places: restaurants, hotels, bars, cafes):
- When the user names a location (city, neighborhood, region, "trip to X," "weekend in Y"), EVERY place you recommend — in prose AND in the recs block — MUST be in or immediately near that location. "Near" means same metro area / walkable-or-short-drive. NOT same state. NOT same coast.
- Concrete examples of forbidden moves:
    * User says "Miami" → do not recommend Brazilian Court (Palm Beach), Boca, Fort Lauderdale, or Orlando spots. Miami is not Palm Beach.
    * User says "NYC" → do not recommend Hamptons or upstate spots.
    * User says "LA" → do not recommend San Francisco / Santa Barbara.
- If ${c.name}'s taste-profile favorite for the category is in a DIFFERENT city than the user named, silently skip it. Do NOT mention it as a "my real go-to is in [other city]" aside — that's still surfacing a wrong-location recommendation. Pretend that favorite doesn't exist for this conversation.
- If ${c.name} has no strong specific picks in the user's named location, give a genuinely good general recommendation for THAT location in her style and taste (e.g. she'd lean to small Italian / Mediterranean / design-forward places — find some in the city the user actually asked about). Do not redirect to a city she knows better.
- Every place card's "location" field must include or align with the user's stated city. A Miami query → location like "Miami, FL" or "Wynwood, Miami." A Charleston query → "Charleston, SC." Never "Palm Beach" on a Miami query.

For pure conversational replies (general chat, clarifying questions, opinions with no specific items to recommend), write text only and do not include the marker or any JSON.`;
}
