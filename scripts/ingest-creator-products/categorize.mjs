// Granular sub-category normalization for the try-on grid filter bar.
//
// Buckets (intentional small set so the pill bar stays readable):
//   dresses, tops, bottoms, shoes, bags, jewelry, swim, outerwear,
//   accessories, beauty, home, other
//
// Inputs in priority order:
//   1. FWRD's data-cat1 ("Jewelry: Bracelets: Bangle") — most explicit,
//      use as-is when present.
//   2. The product title + brand name keyword match — works across
//      Shopbop, Revolve, ShopMy, CSV, manual.
//
// "Other" is the catch-all and is fine to ship; the grid only renders
// pills for sub-categories that have ≥1 product, so an empty
// "other" pill disappears automatically.

// Order matters: more specific patterns first. The first match wins
// so "blazer" beats "jacket"-style fallbacks for outerwear, etc.
const KEYWORD_RULES = [
  // dresses
  //
  // Note: bare "midi" and "mini" used to match here, but they also
  // appear in skirt/bottom titles ("Midi Skirt", "Mini Skirt") and
  // the dresses rule runs before bottoms, so skirts were bucketing
  // as dresses. The current rule requires "midi" / "mini" to be
  // followed by an actual dress noun (or a single word away from
  // it) so "Midi Dress" still matches but "Midi Skirt" falls
  // through to the bottoms rule.
  {
    sub: "dresses",
    re: /\b(dress(es)?|gowns?|frocks?|sundress(es)?|(maxi|midi|mini)\s+dress(es)?)\b/i,
  },

  // swim
  { sub: "swim", re: /\b(bikini|swim(suit|wear)?|one[-\s]?piece|monokini|cover[-\s]?up|tankini|trunks)\b/i },

  // outerwear (before tops so "blazer" doesn't fall to tops)
  { sub: "outerwear", re: /\b(blazer|coat|jacket|trench|parka|puffer|cardigan(?!\s+set)|cape|poncho|vest|moto|overcoat)\b/i },

  // shoes
  { sub: "shoes", re: /\b(shoe|sneaker|boot(ie)?|heel|pump|sandal|flat|loafer|mule|slipper|wedge|espadrille|clog|slide)\b/i },

  // bags
  { sub: "bags", re: /\b(bag|tote|clutch|hobo|satchel|crossbody|backpack|pouch|wallet|wristlet|baguette|shoulder bag|handbag|purse)\b/i },

  // jewelry (before accessories since "earring" should land in jewelry)
  { sub: "jewelry", re: /\b(earring|necklace|ring|bracelet|bangle|anklet|pendant|charm|cuff|stud|hoop|choker)\b/i },

  // beauty
  { sub: "beauty", re: /\b(serum|cream|moisturizer|sunscreen|spf|lipstick|mascara|fragrance|perfume|lotion|cleanser|toner|mask|balm|polish|primer|foundation|concealer|shadow|liner)\b/i },

  // home / lifestyle
  //
  // Note: `frame` is intentionally NOT in this regex. It used to be
  // (for "picture frame"), but FRAME is also a popular denim and
  // ready-to-wear brand (FRAME The Reboot Jeans, FRAME The Sculpted
  // Shirt, etc.). The home rule ran before bottoms/tops in the
  // rules order, so every FRAME-branded apparel item bucketed into
  // Home. Picture frames are rare enough in our catalogs that
  // dropping the keyword costs little; we'd rather a `picture
  // frame` lands in `other` than route an entire denim brand wrong.
  { sub: "home", re: /\b(candle|vase|throw|pillow|towel|sheet|mug|tray|bowl|plate|rug|napkin|coaster|decor)\b/i },

  // bottoms (before tops since "set" is ambiguous; specific bottom words win)
  //
  // Plural-tolerant: \bjean\b matches "Jean" but not "Jeans" (no
  // word boundary between "n" and "s"). Adding s? to every noun
  // catches both forms. Same fix applies to shorts/pants/trousers/
  // skirts/leggings/chinos/cargos/joggers/jumpsuits/rompers; the
  // catalog mixes singular (Revolve) and plural (Shopbop, FWRD)
  // forms, and we want both to bucket consistently.
  {
    sub: "bottoms",
    re: /\b(pants?|jeans?|trousers?|shorts?|skirts?|leggings?|denim|chinos?|cargos?|joggers?|jumpsuits?|rompers?)\b/i,
  },

  // tops (after dresses, outerwear, swim — fall-through for upper body)
  //
  // Same plural-tolerance fix as bottoms. "Tee" / "tees", "tank" /
  // "tanks", "shirt" / "shirts", etc. all match either form.
  {
    sub: "tops",
    re: /\b(tops?|tees?|tanks?|shirts?|blouses?|sweaters?|knits?|polos?|camisoles?|camis?|bodysuits?|crops?|halters?|tunics?|pullovers?|hoodies?|sweatshirts?)\b/i,
  },

  // accessories (catch-all for non-jewelry non-bag accessories)
  { sub: "accessories", re: /\b(sunglass|hat|cap|beanie|scarf|belt|tie|glove|hair|headband|barrette|umbrella|fan)\b/i },
];

// FWRD's cat1 is a colon-delimited taxonomy like
// "Jewelry: Bracelets: Bangle" or "Clothing: Dresses: Mini Dresses".
// Match the first segment (or first two) to the granular bucket.
function fromFwrdCat1(cat1) {
  if (!cat1) return null;
  const segs = cat1.toLowerCase().split(":").map((s) => s.trim());
  const top = segs[0] || "";
  const sub = segs[1] || "";
  if (top === "jewelry") return "jewelry";
  if (top === "shoes") return "shoes";
  if (top === "bags" || top === "handbags") return "bags";
  if (top === "beauty") return "beauty";
  if (top === "home" || top === "lifestyle" || top === "kitchen") return "home";
  if (top === "swim" || sub === "swim" || sub.includes("swim") || sub.includes("bikini"))
    return "swim";
  if (top === "clothing" || top === "ready to wear" || top === "apparel") {
    if (sub.includes("dress")) return "dresses";
    if (sub.includes("outerwear") || sub.includes("coat") || sub.includes("jacket"))
      return "outerwear";
    if (sub.includes("top") || sub.includes("shirt") || sub.includes("sweater") || sub.includes("knit"))
      return "tops";
    if (sub.includes("pant") || sub.includes("short") || sub.includes("skirt") || sub.includes("denim"))
      return "bottoms";
    if (sub.includes("swim") || sub.includes("bikini")) return "swim";
  }
  if (top === "accessories") return "accessories";
  return null;
}

/**
 * Returns one of the small set of bucket strings, or "other" when
 * nothing matches. Callers can rely on the return value being a stable
 * lowercase token suitable for direct use as a filter pill key.
 */
export function deriveSubcategory({
  title = "",
  brand = "",
  fwrdCat1 = null,
  topLevelCategory = null,
} = {}) {
  const fromCat = fromFwrdCat1(fwrdCat1);
  if (fromCat) return fromCat;

  const haystack = `${title} ${brand}`;
  for (const rule of KEYWORD_RULES) {
    if (rule.re.test(haystack)) return rule.sub;
  }

  // Top-level fallbacks so we route into a useful bucket even when
  // the title is unhelpful ("Style #1234").
  if (topLevelCategory === "beauty") return "beauty";
  if (topLevelCategory === "lifestyle") return "home";
  if (topLevelCategory === "accessories") return "accessories";
  return "other";
}

// Pretty labels for the pill bar. The grid client renders these.
export const SUBCATEGORY_LABELS = {
  dresses: "Dresses",
  tops: "Tops",
  bottoms: "Bottoms",
  shoes: "Shoes",
  bags: "Bags",
  jewelry: "Jewelry",
  swim: "Swim",
  outerwear: "Outerwear",
  accessories: "Accessories",
  beauty: "Beauty",
  home: "Home",
  other: "Other",
};
