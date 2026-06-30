/**
 * Local intent parser for the /cassdimicconew search bar.
 *
 * The bottom search/ask bar accepts natural-language queries like
 * "show me a black top for under $300 for nyc date night". The grid's
 * Phase 2 ILIKE pass was matching that whole sentence against
 * product_title + brand, which finds nothing because no product is
 * literally titled "show me a black top for nyc date night".
 *
 * This module fixes that by extracting STRUCTURED signals only:
 *
 *   subcategory  one of the 12 categorize.mjs buckets (or null)
 *   maxPrice     numeric cap pulled from "under $X" / "below X" / etc.
 *   descriptors  curated colors + materials + silhouette adjectives
 *
 * Everything else (cities, occasions, polite filler) is IGNORED. We
 * never keyword-match unrecognized words; that was the bug. The
 * structured filters compose with the category pill (pill always
 * wins when both are set) and are applied server-side as SQL filters.
 *
 * Graceful degradation: applyParsedFilters() drives the relaxation
 * ladder (full set, then drop descriptors, then drop price, then
 * drop subcategory), so a too-strict query returns the broader hit
 * with an interpreted-filters caption instead of an empty grid.
 */

// ---- subcategory synonyms ----------------------------------------------------
//
// Map natural-language phrases to one of the 12 buckets the grid pills
// already understand. Order matters inside CATEGORY_SYNONYMS: the
// matcher tries the longest phrase first so "midi dress" routes to
// dresses before "dress" or "midi" stand-alone could.
//
// Keep this list small and high-precision. A miss is fine (the parser
// returns subcategory=null and other signals still apply); a wrong
// route is annoying.
const CATEGORY_SYNONYMS: Array<[RegExp, string]> = [
  // multi-word phrases first
  [/\b(maxi|midi|mini|slip|wrap|cocktail|sun|shift|bodycon)\s+dress(es)?\b/, "dresses"],
  [/\b(crop|tank|button[-\s]?up|button[-\s]?down|halter)\s+(top|shirt|blouse)s?\b/, "tops"],
  [/\bswim\s*(suit|wear|sets?)?\b/, "swim"],
  [/\bcover[-\s]?ups?\b/, "swim"],
  [/\bcover\s*ups?\b/, "swim"],
  [/\bone[-\s]?pieces?\b/, "swim"],
  [/\bwide[-\s]?leg\s+pants?\b/, "bottoms"],
  [/\bhigh[-\s]?(rise|waist(ed)?)\s+(pants?|jeans?|trousers?|shorts?)\b/, "bottoms"],
  [/\bcrop\s+pants?\b/, "bottoms"],
  [/\bleather\s+(jacket|coat)s?\b/, "outerwear"],
  [/\bblazer\s+dress(es)?\b/, "dresses"],
  [/\bjean\s+jackets?\b/, "outerwear"],

  // single nouns (plural-tolerant)
  [/\bdress(es)?\b/, "dresses"],
  [/\bgowns?\b/, "dresses"],
  [/\bsundress(es)?\b/, "dresses"],
  [/\bromper(s)?\b/, "dresses"],
  [/\bjumpsuit(s)?\b/, "dresses"],

  // `top` was bare in v1: matched "top" but NOT "tops" because the
  // word-boundary fails on "tops" (p|s is not a word boundary). That
  // silently routed "show me tops" to subcategory=null. Fixed to
  // `tops?` so both singular and plural match.
  [/\b(tops?|tee|tees|tanks?|shirts?|blouses?|sweaters?|knits?|cardigans?|hoodies?|sweatshirts?|cami(s|sole)?|bodysuits?|pullovers?|tunics?|polos?)\b/, "tops"],

  [/\b(pants?|jeans?|trousers?|shorts?|skirts?|leggings?|denim|chinos?|cargos?|joggers?)\b/, "bottoms"],
  [/\bbottoms?\b/, "bottoms"],

  [/\b(shoes?|sneakers?|boots?|booties?|heels?|pumps?|sandals?|flats?|loafers?|mules?|wedges?|espadrilles?|clogs?|slides?|slippers?)\b/, "shoes"],

  [/\b(bag|bags|tote(s)?|clutch(es)?|hobo(s)?|satchel(s)?|crossbody|backpack(s)?|wallet(s)?|wristlet(s)?|handbag(s)?|purse(s)?)\b/, "bags"],

  [/\b(earrings?|necklaces?|rings?|bracelets?|bangles?|anklets?|pendants?|charms?|cuffs?|studs?|hoops?|chokers?)\b/, "jewelry"],
  [/\bjewelry\b/, "jewelry"],

  [/\b(bikinis?|swimsuits?|trunks?|monokini(s)?|tankini(s)?)\b/, "swim"],

  [/\b(jacket(s)?|coat(s)?|blazer(s)?|trench(es)?|parka(s)?|puffer(s)?|cape(s)?|poncho(s)?|vest(s)?|moto|overcoat(s)?)\b/, "outerwear"],
  [/\bouterwear\b/, "outerwear"],

  [/\b(sunglasses|hat(s)?|cap(s)?|beanie(s)?|scarves|scarfs?|belts?|gloves?|headbands?)\b/, "accessories"],
  [/\baccessor(y|ies)\b/, "accessories"],

  [/\b(serum(s)?|cream(s)?|moisturizer(s)?|sunscreen(s)?|spf|lipstick(s)?|mascara(s)?|fragrance(s)?|perfume(s)?|cleanser(s)?|toner(s)?|skincare|makeup)\b/, "beauty"],
  [/\bbeauty\b/, "beauty"],

  [/\b(candle(s)?|vase(s)?|throw(s)?|pillow(s)?|towel(s)?|mug(s)?|tray(s)?|decor|home)\b/, "home"],
];

// ---- descriptors (colors, materials, silhouettes) ---------------------------
//
// These are ILIKE'd against product_title (and brand as a fallback).
// The dataset doesn't have a dedicated color column, so matching is
// imperfect; many products have color in the affiliate URL slug but
// not the title. The relaxation ladder handles this by dropping
// descriptors when they zero out the result set.
const DESCRIPTOR_VOCAB = new Set<string>([
  // colors
  "black", "white", "red", "blue", "navy", "green", "olive", "yellow",
  "pink", "rose", "purple", "lavender", "orange", "rust", "brown",
  "tan", "beige", "cream", "ivory", "nude", "gray", "grey", "charcoal",
  "gold", "silver", "burgundy", "maroon", "khaki", "taupe", "mustard",
  "saffron", "emerald", "teal", "coral", "sage", "lilac",
  // materials
  "silk", "linen", "cotton", "leather", "suede", "cashmere", "wool",
  "satin", "lace", "velvet", "tweed", "knit", "chiffon", "denim",
  // silhouettes / fits
  "oversized", "cropped", "tailored", "fitted", "slim", "long",
  "short", "midi", "maxi", "mini", "strapless", "sleeveless", "ribbed",
]);

// ---- garment-type vocabulary (HARD constraints) ---------------------
//
// Distinct from DESCRIPTOR_VOCAB: when a user asks for a specific
// garment TYPE, a wrong-type item is disqualifying, not down-rankable.
// "white turtleneck sweater" -> a sleeveless square-neck top is a
// confidently-wrong answer no matter how good the brand match is.
//
// Each entry is a logical type (the key) with an array of title-token
// aliases. Chat's loadCatalog ORs the aliases inside a single .ilike
// clause so "turtle top" and "mock neck bodysuit" both satisfy
// "turtleneck." Plural-tolerant via the alias list (sneaker / sneakers).
//
// The set is intentionally narrow to start: well-defined garment types
// with stable vocabulary. Broader semantic understanding ("puffy
// sleeve," "off-shoulder," "going-out") needs embeddings -- documented
// trade-off. Add entries here as real user queries surface new types.
export const GARMENT_TYPES: Array<{
  /** Canonical key surfaced to the prompt/caption. */
  key: string;
  /** Lower-cased trigger words/phrases (with word boundaries) that
   *  identify this type in the user's query. */
  triggers: RegExp[];
  /** Lower-cased substrings to look for in product_title (one or
   *  more must match for the row to qualify). */
  titleAliases: string[];
  /** Optional subcategory pin so a query like "midi" doesn't pull
   *  midi dresses when the user said "midi skirt." */
  subcategoryHint?: string;
}> = [
  // necklines
  { key: "turtleneck", triggers: [/\bturtle(?:neck)?\b/], titleAliases: ["turtleneck", "turtle", "mock neck", "mockneck"], subcategoryHint: "tops" },
  { key: "mock neck", triggers: [/\bmock[-\s]?neck\b/], titleAliases: ["mock neck", "mockneck", "mock-neck"], subcategoryHint: "tops" },
  { key: "v-neck", triggers: [/\bv[-\s]?neck\b/], titleAliases: ["v-neck", "vneck", "v neck"], subcategoryHint: "tops" },
  { key: "crew neck", triggers: [/\bcrew(?:[-\s]?neck)?\b/], titleAliases: ["crew", "crewneck", "crew neck", "crew-neck"], subcategoryHint: "tops" },
  { key: "halter", triggers: [/\bhalters?\b/], titleAliases: ["halter"], subcategoryHint: "tops" },
  { key: "tank", triggers: [/\btanks?\b/], titleAliases: ["tank"], subcategoryHint: "tops" },
  { key: "tee", triggers: [/\b(?:tee|t[-\s]?shirt)s?\b/], titleAliases: ["tee", "t-shirt", "tshirt"], subcategoryHint: "tops" },
  { key: "bodysuit", triggers: [/\bbodysuits?\b/], titleAliases: ["bodysuit"], subcategoryHint: "tops" },
  { key: "blouse", triggers: [/\bblouses?\b/], titleAliases: ["blouse"], subcategoryHint: "tops" },
  { key: "button-down", triggers: [/\bbutton[-\s]?(?:up|down)\b/], titleAliases: ["button up", "button down", "button-up", "button-down"], subcategoryHint: "tops" },
  // bottoms
  { key: "midi skirt", triggers: [/\bmidi\s+skirts?\b/], titleAliases: ["midi skirt", "midi"], subcategoryHint: "bottoms" },
  { key: "mini skirt", triggers: [/\bmini\s+skirts?\b/], titleAliases: ["mini skirt", "mini"], subcategoryHint: "bottoms" },
  { key: "maxi skirt", triggers: [/\bmaxi\s+skirts?\b/], titleAliases: ["maxi skirt", "maxi"], subcategoryHint: "bottoms" },
  { key: "trouser", triggers: [/\btrousers?\b/], titleAliases: ["trouser", "trousers"], subcategoryHint: "bottoms" },
  { key: "jeans", triggers: [/\bjeans?\b/], titleAliases: ["jean", "jeans", "denim"], subcategoryHint: "bottoms" },
  { key: "shorts", triggers: [/\bshorts?\b/], titleAliases: ["short"], subcategoryHint: "bottoms" },
  { key: "leggings", triggers: [/\bleggings?\b/], titleAliases: ["legging"], subcategoryHint: "bottoms" },
  // dresses
  { key: "midi dress", triggers: [/\bmidi\s+dress(es)?\b/], titleAliases: ["midi"], subcategoryHint: "dresses" },
  { key: "mini dress", triggers: [/\bmini\s+dress(es)?\b/], titleAliases: ["mini"], subcategoryHint: "dresses" },
  { key: "maxi dress", triggers: [/\bmaxi\s+dress(es)?\b/], titleAliases: ["maxi"], subcategoryHint: "dresses" },
  { key: "slip dress", triggers: [/\bslip\s+dress(es)?\b/], titleAliases: ["slip"], subcategoryHint: "dresses" },
  { key: "jumpsuit", triggers: [/\bjumpsuits?\b/], titleAliases: ["jumpsuit"], subcategoryHint: "dresses" },
  // outerwear
  { key: "blazer", triggers: [/\bblazers?\b/], titleAliases: ["blazer"], subcategoryHint: "outerwear" },
  { key: "trench", triggers: [/\btrenches?\b/, /\btrench[-\s]?coats?\b/], titleAliases: ["trench"], subcategoryHint: "outerwear" },
  { key: "bomber", triggers: [/\bbombers?\b/], titleAliases: ["bomber"], subcategoryHint: "outerwear" },
  { key: "parka", triggers: [/\bparkas?\b/], titleAliases: ["parka"], subcategoryHint: "outerwear" },
  { key: "puffer", triggers: [/\bpuffers?\b/], titleAliases: ["puffer"], subcategoryHint: "outerwear" },
  { key: "cardigan", triggers: [/\bcardigans?\b/], titleAliases: ["cardigan"], subcategoryHint: "outerwear" },
  // shoes
  { key: "sneaker", triggers: [/\bsneakers?\b/], titleAliases: ["sneaker"], subcategoryHint: "shoes" },
  { key: "boot", triggers: [/\bbooties?\b/, /\bboots?\b/], titleAliases: ["boot", "bootie"], subcategoryHint: "shoes" },
  { key: "heel", triggers: [/\bheels?\b/], titleAliases: ["heel", "pump"], subcategoryHint: "shoes" },
  { key: "sandal", triggers: [/\bsandals?\b/], titleAliases: ["sandal"], subcategoryHint: "shoes" },
  { key: "loafer", triggers: [/\bloafers?\b/], titleAliases: ["loafer"], subcategoryHint: "shoes" },
  { key: "mule", triggers: [/\bmules?\b/], titleAliases: ["mule"], subcategoryHint: "shoes" },
  { key: "flat", triggers: [/\bflats?\b/], titleAliases: ["flat", "ballet"], subcategoryHint: "shoes" },
  // bags
  { key: "tote", triggers: [/\btotes?\b/], titleAliases: ["tote"], subcategoryHint: "bags" },
  { key: "clutch", triggers: [/\bclutch(es)?\b/], titleAliases: ["clutch"], subcategoryHint: "bags" },
  { key: "crossbody", triggers: [/\bcrossbody\b/, /\bcross[-\s]?body\b/], titleAliases: ["crossbody", "cross-body"], subcategoryHint: "bags" },
  { key: "shoulder bag", triggers: [/\bshoulder\s+bags?\b/], titleAliases: ["shoulder"], subcategoryHint: "bags" },
  { key: "satchel", triggers: [/\bsatchels?\b/], titleAliases: ["satchel"], subcategoryHint: "bags" },
  { key: "hobo", triggers: [/\bhobos?\b/], titleAliases: ["hobo"], subcategoryHint: "bags" },
  // jewelry
  { key: "hoop earrings", triggers: [/\bhoops?\b/], titleAliases: ["hoop"], subcategoryHint: "jewelry" },
  { key: "stud earrings", triggers: [/\bstuds?\b/], titleAliases: ["stud"], subcategoryHint: "jewelry" },
  { key: "drop earrings", triggers: [/\bdrop\s+earrings?\b/], titleAliases: ["drop"], subcategoryHint: "jewelry" },
  { key: "pendant", triggers: [/\bpendants?\b/], titleAliases: ["pendant"], subcategoryHint: "jewelry" },
  { key: "necklace", triggers: [/\bnecklaces?\b/, /\bchains?\b/], titleAliases: ["necklace", "chain"], subcategoryHint: "jewelry" },
  { key: "bracelet", triggers: [/\bbracelets?\b/, /\bbangles?\b/, /\bcuffs?\b/], titleAliases: ["bracelet", "bangle", "cuff"], subcategoryHint: "jewelry" },
  { key: "ring", triggers: [/\brings?\b/], titleAliases: ["ring"], subcategoryHint: "jewelry" },
];

/**
 * Extract every garment-type the user query named. Multiple types
 * can co-occur ("white turtleneck sweater" hits turtleneck only;
 * "midi skirt" hits midi skirt). Returns the canonical keys + the
 * union of titleAliases (for SQL ILIKE) + first subcategoryHint.
 */
export function extractGarmentTypes(query: string): {
  keys: string[];
  titleAliases: string[];
  subcategoryHint: string | null;
} {
  const lc = (query || "").toLowerCase();
  const keys: string[] = [];
  const aliases = new Set<string>();
  let subHint: string | null = null;
  for (const t of GARMENT_TYPES) {
    if (t.triggers.some((re) => re.test(lc))) {
      keys.push(t.key);
      for (const a of t.titleAliases) aliases.add(a);
      if (!subHint && t.subcategoryHint) subHint = t.subcategoryHint;
    }
  }
  return {
    keys,
    titleAliases: Array.from(aliases),
    subcategoryHint: subHint,
  };
}

// ---- price extraction -------------------------------------------------------
//
// Recognized forms:
//   "under $300", "under 300", "below $300", "less than $300"
//   "<= 300", "<300"
//   "around $300", "about $300", "~$300", "$300ish", "300ish"
//   "$100-$300", "between 100 and 300"  (ceiling = higher value)
//
// We always normalize to a single ceiling. "Around X" means "X with
// some headroom"; we add 10% so a $300 query lands the $320 hero
// piece. That matches the budget-target reasoning the chat prompt
// uses.
const PRICE_PATTERNS: Array<{ re: RegExp; pick: (m: RegExpExecArray) => number }> = [
  { re: /\b(?:under|below|less\s+than|<=?)\s*\$?\s*(\d{1,5})\b/i, pick: (m) => Number(m[1]) },
  { re: /\bbetween\s*\$?\s*(\d{1,5})\s*(?:and|to|-)\s*\$?\s*(\d{1,5})\b/i, pick: (m) => Math.max(Number(m[1]), Number(m[2])) },
  { re: /\$\s*(\d{1,5})\s*-\s*\$?\s*(\d{1,5})\b/, pick: (m) => Math.max(Number(m[1]), Number(m[2])) },
  { re: /\b(?:around|about|approximately|~)\s*\$?\s*(\d{1,5})\b/i, pick: (m) => Math.round(Number(m[1]) * 1.1) },
  { re: /\$\s*(\d{1,5})\s*ish\b/i, pick: (m) => Math.round(Number(m[1]) * 1.1) },
  { re: /\b(\d{2,5})\s*ish\b/i, pick: (m) => Math.round(Number(m[1]) * 1.1) },
];

// ---- types ------------------------------------------------------------------

export type ParsedQuery = {
  /** Set when the parser recognized a category synonym. */
  subcategory: string | null;
  /** Numeric ceiling; price <= this. */
  maxPrice: number | null;
  /** Curated colors + materials + silhouette adjectives matched. */
  descriptors: string[];
  /** Original raw query, lower-cased + trimmed. */
  raw: string;
};

export function parseQuery(input: string): ParsedQuery {
  const raw = (input || "").trim();
  const lc = raw.toLowerCase();
  if (!raw) {
    return { subcategory: null, maxPrice: null, descriptors: [], raw };
  }

  // price first so the numeric tokens are off the table for descriptor matching
  let maxPrice: number | null = null;
  for (const { re, pick } of PRICE_PATTERNS) {
    const m = re.exec(lc);
    if (m) {
      maxPrice = pick(m);
      break;
    }
  }

  // category: first synonym match wins (synonyms are ordered longest first)
  let subcategory: string | null = null;
  for (const [re, bucket] of CATEGORY_SYNONYMS) {
    if (re.test(lc)) {
      subcategory = bucket;
      break;
    }
  }

  // descriptors: every recognized vocab word, deduped, preserving input order
  const descriptors: string[] = [];
  const seen = new Set<string>();
  for (const token of lc.split(/[^a-z]+/)) {
    if (!token) continue;
    if (DESCRIPTOR_VOCAB.has(token) && !seen.has(token)) {
      seen.add(token);
      descriptors.push(token);
    }
  }

  return { subcategory, maxPrice, descriptors, raw };
}

// ---- caption builder --------------------------------------------------------
//
// Renders a human caption from the active filters so the grid can show
// "Tops under $300, black" instead of the raw query. Used both when
// the parse succeeds AND in the relaxed-fallback case so the user
// knows what they're looking at.
const SUBCATEGORY_LABEL: Record<string, string> = {
  dresses: "Dresses",
  tops: "Tops",
  bottoms: "Bottoms",
  outerwear: "Outerwear",
  shoes: "Shoes",
  bags: "Bags",
  jewelry: "Jewelry",
  accessories: "Accessories",
  swim: "Swim",
  beauty: "Beauty",
  home: "Home",
  other: "Other",
};

export function describeFilters(opts: {
  subcategory: string | null;
  maxPrice: number | null;
  descriptors: string[];
}): string {
  const parts: string[] = [];
  if (opts.descriptors.length) parts.push(opts.descriptors.join(" "));
  if (opts.subcategory) parts.push(SUBCATEGORY_LABEL[opts.subcategory] || opts.subcategory);
  else parts.push("Items");
  const head = parts.join(" ");
  return opts.maxPrice ? `${head} under $${opts.maxPrice}` : head;
}

/**
 * Caption for a relaxed search. Tells the user explicitly that the
 * grid is showing a broader set than they asked for, e.g.
 * "No black tops under $300, showing all tops under $300".
 *
 * The "wanted" half describes the original parsed intent; the
 * "showing" half describes the actually-applied filter set after
 * the relaxation ladder dropped one or more signals. Reading the
 * two halves together tells the user exactly what got broadened.
 */
export function describeRelaxedFilters(opts: {
  wanted: { subcategory: string | null; maxPrice: number | null; descriptors: string[] };
  applied: { subcategory: string | null; maxPrice: number | null; descriptors: string[] };
}): string {
  const wantedStr = describeFilters(opts.wanted).toLowerCase();
  const appliedStr = describeFilters(opts.applied).toLowerCase();
  return `No ${wantedStr}, showing ${appliedStr}`;
}
