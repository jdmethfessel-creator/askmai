/**
 * Dressing Room persistence layer (Phase 1 = localStorage).
 *
 * Keyed by creatorSlug: a visitor can have a separate Dressing
 * Room per creator they browse. No backend storage in this
 * version (per JD: concept test, ship in one push, no new
 * tables). Trade-off: doesn't survive browser-data clear,
 * device switch, or incognito session end. If the concept
 * sticks the next iteration migrates to a `dressing_rooms`
 * table keyed by an anonymous session cookie.
 *
 * Schema versioning: every write includes a `version` so a
 * future migration can detect and reshape old payloads. v1
 * is the only version today.
 *
 * Saved looks store the STORAGE PATH (e.g.
 * "<userId>/<uuid>.png" in the private renders bucket), NOT
 * the signed URL. Signed URLs have a 7-day TTL and would rot;
 * we re-sign on access via /api/render/refresh-url so saved
 * looks remain viewable indefinitely.
 *
 * SSR safety: every function checks for `window` and no-ops on
 * the server. Components consuming this store should run inside
 * useEffect or "use client" boundaries.
 */

const STORAGE_VERSION = 1;
const STORAGE_PREFIX = "askmai:dressing-room:";

export type SavedItem = {
  /** product id from creator_products */
  id: string;
  creatorSlug: string;
  name: string;
  brand: string | null;
  imageUrl: string;
  affiliateUrl: string;
  /** product_subcategory (tops/bottoms/dresses/outerwear/bags/etc) */
  subcategory: string | null;
  priceDisplay: string | null;
  /** ISO timestamp */
  savedAt: string;
};

export type SavedLook = {
  /** crypto.randomUUID at save time; stable forever */
  id: string;
  creatorSlug: string;
  /** Storage path in the private `renders` bucket. Re-sign on view
   *  via /api/render/refresh-url. We do NOT store signed URLs
   *  here to avoid the 7-day TTL bit-rot. */
  renderPath: string;
  /** Product ids that made up this outfit (for the "shop the
   *  pieces" affordance back to the source products). */
  itemIds: string[];
  /** Tiny denormalized cache so we can render the look-card
   *  meta line (item names/brands) without re-querying. Items
   *  in the source catalog may change or get removed; this
   *  snapshot preserves what the look actually was when saved. */
  itemSnapshots: Array<{
    id: string;
    name: string;
    brand: string | null;
  }>;
  savedAt: string;
};

export type DressingRoom = {
  version: number;
  items: SavedItem[];
  looks: SavedLook[];
};

function key(creatorSlug: string): string {
  return `${STORAGE_PREFIX}${creatorSlug}`;
}

function emptyRoom(): DressingRoom {
  return { version: STORAGE_VERSION, items: [], looks: [] };
}

export function loadDressingRoom(creatorSlug: string): DressingRoom {
  if (typeof window === "undefined") return emptyRoom();
  try {
    const raw = window.localStorage.getItem(key(creatorSlug));
    if (!raw) return emptyRoom();
    const parsed = JSON.parse(raw) as DressingRoom;
    // Schema guard: anything not v1 gets wiped to empty. Cheap and
    // safe; we only have one schema version today.
    if (!parsed || parsed.version !== STORAGE_VERSION) return emptyRoom();
    if (!Array.isArray(parsed.items)) parsed.items = [];
    if (!Array.isArray(parsed.looks)) parsed.looks = [];
    return parsed;
  } catch {
    return emptyRoom();
  }
}

function save(creatorSlug: string, room: DressingRoom): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key(creatorSlug), JSON.stringify(room));
  } catch {
    // QuotaExceededError or private-mode write-block; silently drop.
    // The user just won't see their addition persist; not blocking.
  }
}

/**
 * Add an item to the collection. Idempotent on product id; an
 * existing item is moved to the top (most-recently-added) rather
 * than duplicated.
 */
export function addItem(
  creatorSlug: string,
  item: Omit<SavedItem, "savedAt">
): DressingRoom {
  const room = loadDressingRoom(creatorSlug);
  const existing = room.items.findIndex((i) => i.id === item.id);
  const stamped: SavedItem = { ...item, savedAt: new Date().toISOString() };
  const next: DressingRoom = {
    ...room,
    items: existing >= 0
      ? [stamped, ...room.items.filter((i) => i.id !== item.id)]
      : [stamped, ...room.items],
  };
  save(creatorSlug, next);
  return next;
}

export function removeItem(
  creatorSlug: string,
  productId: string
): DressingRoom {
  const room = loadDressingRoom(creatorSlug);
  const next: DressingRoom = {
    ...room,
    items: room.items.filter((i) => i.id !== productId),
  };
  save(creatorSlug, next);
  return next;
}

export function hasItem(creatorSlug: string, productId: string): boolean {
  const room = loadDressingRoom(creatorSlug);
  return room.items.some((i) => i.id === productId);
}

/**
 * Save a rendered look. ID is generated here; caller passes the
 * storage path + the item ids that made up the outfit.
 */
export function addLook(
  creatorSlug: string,
  look: Omit<SavedLook, "id" | "savedAt">
): DressingRoom {
  const room = loadDressingRoom(creatorSlug);
  const stamped: SavedLook = {
    ...look,
    id:
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    savedAt: new Date().toISOString(),
  };
  const next: DressingRoom = {
    ...room,
    looks: [stamped, ...room.looks],
  };
  save(creatorSlug, next);
  return next;
}

export function removeLook(
  creatorSlug: string,
  lookId: string
): DressingRoom {
  const room = loadDressingRoom(creatorSlug);
  const next: DressingRoom = {
    ...room,
    looks: room.looks.filter((l) => l.id !== lookId),
  };
  save(creatorSlug, next);
  return next;
}

export function clearDressingRoom(creatorSlug: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key(creatorSlug));
  } catch {
    // ignore
  }
}
