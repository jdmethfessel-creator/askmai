/**
 * Shared try-on eligibility + outfit-slot logic. Both TryOnGrid
 * (Shop tab) and DressingRoom (Room tab) consume this so the rules
 * stay aligned. The server's render route (src/lib/render.ts)
 * mirrors RENDERABLE_SUBCATEGORIES; a client can never bypass the
 * server gate.
 *
 * Slot model:
 *   - top / bottom / dress / outerwear are renderable through
 *     FASHN's chained tryon-v1.6 pipeline.
 *   - outerwear has no conflicts (layers on anything) and is
 *     chained LAST so the tops-region pass wins.
 *   - dress excludes top+bottom; top OR bottom excludes dress.
 *   - bag / shoes / jewelry / accessories / beauty / swim never
 *     reach the render path (server filters; client surfaces a
 *     "shop only, can't try on" affordance in the Room).
 *
 * Item-shape generic: callers pass their own row type as long as it
 * exposes a product_subcategory string. Keeps this module decoupled
 * from any specific DTO so SavedItem (camelCase) and Product
 * (snake_case) both work.
 */

export type OutfitSlot = "top" | "bottom" | "dress" | "outerwear";

export const MAX_OUTFIT_ITEMS = 3;

export const TRYON_ELIGIBLE_CATEGORIES = new Set<string>([
  "tops",
  "bottoms",
  "dresses",
  "outerwear",
]);

const SUBCATEGORY_TO_SLOT: Record<string, OutfitSlot> = {
  tops: "top",
  bottoms: "bottom",
  dresses: "dress",
  outerwear: "outerwear",
};

export function isTryOnEligibleSubcategory(sub: string | null | undefined): boolean {
  const v = (sub ?? "").toLowerCase();
  return TRYON_ELIGIBLE_CATEGORIES.has(v);
}

export function slotForSubcategory(sub: string | null | undefined): OutfitSlot | null {
  const v = (sub ?? "").toLowerCase();
  return SUBCATEGORY_TO_SLOT[v] ?? null;
}

/**
 * Stable chain order: top, bottom, dress, then outerwear LAST so the
 * VTON region-swap leaves outerwear as the most-visible layer.
 */
export const SLOT_ORDER: OutfitSlot[] = ["top", "bottom", "dress", "outerwear"];

/**
 * Whether adding `candidateSub` would conflict with the currently-
 * selected slots. Returns true when:
 *   - the candidate's slot is already filled by a DIFFERENT id
 *   - candidate is a dress and top/bottom is filled
 *   - candidate is top/bottom and dress is filled
 *
 * Self-deselect (same id already in its slot) is never a conflict.
 */
export function isSlotConflict(
  candidate: { id: string; subcategory: string | null },
  selected: Partial<Record<OutfitSlot, { id: string }>>
): boolean {
  const slot = slotForSubcategory(candidate.subcategory);
  if (!slot) return false; // non-tryable items never conflict
  if (selected[slot]?.id === candidate.id) return false;
  if (selected[slot]) return true;
  if (slot === "dress" && (selected.top || selected.bottom)) return true;
  if ((slot === "top" || slot === "bottom") && selected.dress) return true;
  return false;
}

/**
 * Toggle an item in/out of a slot-keyed selection map. Honors the
 * dress/separates exclusion (adding a dress clears top+bottom;
 * adding a top/bottom clears any dress). Hard cap at
 * MAX_OUTFIT_ITEMS; over-cap adds are no-ops.
 */
export function toggleSlot<T extends { id: string; subcategory: string | null }>(
  selected: Partial<Record<OutfitSlot, T>>,
  item: T
): Partial<Record<OutfitSlot, T>> {
  const slot = slotForSubcategory(item.subcategory);
  if (!slot) return selected;
  const next: Partial<Record<OutfitSlot, T>> = { ...selected };
  if (next[slot]?.id === item.id) {
    delete next[slot];
    return next;
  }
  if (slot === "dress") {
    delete next.top;
    delete next.bottom;
  } else if (slot === "top" || slot === "bottom") {
    delete next.dress;
  }
  const replacing = Boolean(next[slot]);
  const wouldExceed = !replacing && Object.keys(next).length >= MAX_OUTFIT_ITEMS;
  if (wouldExceed) return selected;
  next[slot] = item;
  return next;
}

/**
 * Flatten a slot-keyed selection into chain-ordered array.
 */
export function selectedInOrder<T>(
  selected: Partial<Record<OutfitSlot, T>>
): T[] {
  const out: T[] = [];
  for (const s of SLOT_ORDER) {
    const v = selected[s];
    if (v) out.push(v);
  }
  return out;
}
