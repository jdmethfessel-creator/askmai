/**
 * Outfit slot classification + dedup.
 *
 * An outfit is at most ONE item per category slot. The slot taxonomy:
 *
 *   - dress       full-body single garment (excludes top + bottom)
 *   - top         shirt, tee, sweater, blouse, tank, bodysuit, etc.
 *   - bottom      pants, jeans, skirt, shorts, etc.
 *   - outerwear   jacket, coat, blazer, trench, vest
 *   - shoes       any footwear
 *   - bag         any handbag
 *   - jewelry     ring, earring, necklace, bracelet, hoops, studs
 *   - accessory   non-jewelry wearables (sunglasses, belt, hat, scarf)
 *   - other       non-outfit items (beauty, lifestyle, anything we
 *                 cannot place in an outfit)
 *
 * Coherence rule: if a DRESS is present, any TOP or BOTTOM in the
 * same outfit is dropped (you cannot wear a dress AND a separate
 * top + bottom). For every other slot, the first occurrence wins —
 * the upstream ranker already orders "best first" by attribution
 * and image presence, so first-occurrence is the strongest
 * candidate.
 *
 * "Other" items are dropped from the outfit entirely. They typically
 * mean the model emitted something that isn't part of a head-to-toe
 * look (e.g. a beauty SKU in a packing list).
 *
 * The render-trigger ("Try This Outfit on Me") uses the same dedup
 * so the renderer never sees two heels or two bags.
 */

import type { Rec } from "./types";

export type OutfitSlot =
  | "dress"
  | "top"
  | "bottom"
  | "outerwear"
  | "shoes"
  | "bag"
  | "jewelry"
  | "sunglasses"
  | "accessory"
  | "other";

// Pattern table. Order is significant: the first pattern that matches
// the rec's name wins. We check the more specific terms BEFORE more
// generic ones so that:
//   - "Shirt Dress" matches `dress` before `shirt`
//   - "Blazer" matches `outerwear` before `top` (which would also
//     match "jacket" tokens via dress-shirt loops if order were reversed)
//   - "Diamond Bar Bracelet" matches `jewelry` before any generic
//     accessory bucket
//   - Specific shoe / bag / jewelry vocabulary matches before
//     generic accessories so "Heel" or "Tote" never lands as
//     `accessory`.
const SLOT_PATTERNS: Array<{ slot: OutfitSlot; pattern: RegExp }> = [
  {
    slot: "dress",
    pattern: /\b(dress|gown|jumpsuit|romper|kaftan|caftan|catsuit)\b/i,
  },
  {
    slot: "shoes",
    pattern:
      /\b(heels?|sandals?|sneakers?|boots?|booties?|flats?|loafers?|mules?|pumps?|slingbacks?|stilettos?|trainers?|oxfords?|ballerinas?|wedges?|espadrilles?|clogs?|slippers?|brogues?)\b/i,
  },
  {
    slot: "bag",
    pattern:
      /\b(bag|tote|clutch|purse|handbag|backpack|satchel|crossbody|hobo|bucket|messenger|saddle|baguette)\b/i,
  },
  {
    slot: "jewelry",
    pattern:
      /\b(rings?|earrings?|necklaces?|bracelets?|anklets?|pendants?|chokers?|hoops?|studs?|chains?|cuffs?|brooch(?:es)?)\b/i,
  },
  {
    slot: "outerwear",
    pattern:
      /\b(jacket|coat|blazer|trench|cape|parka|anorak|gilet|puffer|overcoat|peacoat)\b/i,
  },
  // Top family — explicit top vocabulary. Note: `shirt` is here
  // intentionally, AFTER `dress` so "Shirt Dress" goes to dress.
  {
    slot: "top",
    pattern:
      /\b(tops?|tee|tshirt|t-shirt|blouse|tank|cami|sweater|knit|cardigan|polo|henley|bodysuit|crewneck|pullover|hoodie|sweatshirt|button[- ]down|shirt|tunic|kimono)\b/i,
  },
  {
    slot: "bottom",
    pattern:
      /\b(pants?|jeans?|trousers?|shorts?|skirts?|leggings?|joggers?|chinos?|culottes?|capris?|denim)\b/i,
  },
  // Sunglasses gets its own slot so a single "outfit" cannot end up
  // with three sunglasses. (Eyewear is a distinct outfit feature
  // from belts/hats/scarves — the model treats them as choosable in
  // multiples and we have to gate that explicitly.)
  {
    slot: "sunglasses",
    pattern: /\b(sunglasses?|shades|sunnies)\b/i,
  },
  {
    slot: "accessory",
    pattern:
      /\b(glasses?|belts?|hats?|caps?|berets?|scarves?|scarf|gloves?|hairband|headband|ties?|fascinator)\b/i,
  },
];

/**
 * Classify a rec into an outfit slot using its name + category.
 *
 * Returns "other" when:
 *   - the rec's category is not fashion / accessories (beauty,
 *     lifestyle, dining, travel, anything else — they're not
 *     part of an outfit assembly)
 *   - or the name doesn't match any slot pattern
 */
export function classifyOutfitSlot(rec: Rec): OutfitSlot {
  const cat = (rec.category ?? "").trim().toLowerCase();
  if (cat !== "fashion" && cat !== "accessories") return "other";
  const name = (rec.name ?? "").toLowerCase();
  for (const { slot, pattern } of SLOT_PATTERNS) {
    if (pattern.test(name)) return slot;
  }
  return "other";
}

/**
 * Dedupe a set of recs into a coherent outfit.
 *
 * Rules:
 *   1. At most one item per slot — first occurrence wins (the
 *      upstream ranker has already ordered the list, so first =
 *      best).
 *   2. If any DRESS is present, every TOP and BOTTOM is dropped
 *      from the outfit. A dress excludes a separate top+bottom.
 *   3. OTHER items are dropped entirely. They aren't part of a
 *      head-to-toe look.
 *
 * The returned list preserves the input order of the recs that
 * survive the dedup. Non-fashion / non-accessories items are
 * dropped from the outfit but the caller can re-merge them
 * (e.g. for the chat card display, places + beauty stay outside
 * this function's scope).
 */
export function dedupeOutfitRecs(recs: Rec[]): Rec[] {
  if (recs.length === 0) return recs;
  const hasDress = recs.some((r) => classifyOutfitSlot(r) === "dress");
  const filled = new Set<OutfitSlot>();
  const out: Rec[] = [];
  for (const rec of recs) {
    const slot = classifyOutfitSlot(rec);
    if (slot === "other") continue;
    if (hasDress && (slot === "top" || slot === "bottom")) continue;
    if (filled.has(slot)) continue;
    filled.add(slot);
    out.push(rec);
  }
  return out;
}

/**
 * A coherent outfit must include a TOP-LEVEL GARMENT — either a
 * dress (single full-body garment) or a top + bottom combination.
 * An assortment that's only accessories (sunglasses + jewelry +
 * belt + bag with no actual clothing) is not an outfit; it's a
 * pile of accessories.
 *
 * Used by the render trigger to decide whether to show the
 * "Try This Outfit on Me" pill. If no top-level garment is
 * present, the pill stays hidden — each item still gets its own
 * per-card "Show This Item on Me" pill, but there's no "outfit"
 * render path for an accessory pile.
 *
 * Also used by the server-side assembler to log when a deduped
 * outfit comes back garmentless, so we can monitor the rate.
 */
export function hasValidOutfitComposition(recs: Rec[]): boolean {
  let hasDress = false;
  let hasTop = false;
  let hasBottom = false;
  for (const rec of recs) {
    const slot = classifyOutfitSlot(rec);
    if (slot === "dress") hasDress = true;
    else if (slot === "top") hasTop = true;
    else if (slot === "bottom") hasBottom = true;
  }
  return hasDress || (hasTop && hasBottom);
}

/**
 * Partition recs into outfit + non-outfit. The outfit half is
 * deduped to one-per-slot; the non-outfit half (beauty, lifestyle,
 * dining, travel, anything other) is preserved verbatim so the
 * server-side recs array stays whole for the card display.
 *
 * Used by the chat assembler: we want to dedupe the outfit pieces
 * without dropping a skincare card or a restaurant card that
 * happened to come back in the same response.
 */
export function dedupeOutfitPreservingOther(recs: Rec[]): Rec[] {
  if (recs.length === 0) return recs;
  const outfitCandidates: Rec[] = [];
  const passThrough: Rec[] = [];
  for (const rec of recs) {
    if (classifyOutfitSlot(rec) === "other") {
      passThrough.push(rec);
    } else {
      outfitCandidates.push(rec);
    }
  }
  const dedupedOutfit = dedupeOutfitRecs(outfitCandidates);
  // Preserve the original order of the input by walking through
  // recs and emitting each item if it survived dedup or is pass-through.
  const keepIds = new Set<Rec>();
  for (const r of dedupedOutfit) keepIds.add(r);
  for (const r of passThrough) keepIds.add(r);
  return recs.filter((r) => keepIds.has(r));
}
