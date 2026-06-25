export type Theme = {
  accent?: string;
  bg?: string;
  ink?: string;
  muted?: string;
  surface?: string;
};

export type TasteProfile = Record<string, unknown>;

export type Creator = {
  id: string;
  slug: string;
  name: string;
  bio: string | null;
  avatar_url: string | null;
  theme: Theme | null;
  voice_prompt: string | null;
  taste_profile: TasteProfile | null;
  /** Soft-hide flag. Hidden creators 404 on the chat page and disappear
   *  from the /creators directory while all their data, voice, and
   *  catalog stay intact. Toggle in Supabase to restore. */
  hidden?: boolean | null;
};

export type Product = {
  id: string;
  creator_id: string;
  name: string;
  category: string | null;
  brand: string | null;
  price: number | null;
  affiliate_url: string | null;
  network: string | null;
  image_url?: string | null;
};

export type LinkTier =
  | "feed"
  | "owned_feed"
  | "owned"
  | "aggregator"
  | "hotel"
  | "place"
  | "none";

export type Rec = {
  name: string;
  brand?: string;
  category: string;
  price?: string;
  why: string;
  image_url?: string;
  /** Optional location hint for hotel recs (e.g., "Tulum, Mexico") */
  location?: string;
  /**
   * Set by the model when picking a real catalog item. The server uses this for
   * an exact-ID feed lookup and overrides name/brand/price/image_url with the
   * real product row so what's shown always matches what's linked.
   */
  product_id?: string;
  /**
   * Model-provided best-guess merchant product URL for off-catalog items.
   * Used by the aggregator tier to build a Skimlinks deep link.
   */
  merchant_url?: string;
  /**
   * For dining recs only: true when the place takes reservations (sit-down
   * restaurants). False for cafes, takeout, bakeries, fast-casual, bar-snack
   * spots. Server uses this to pick Reserve vs Directions as primary action.
   */
  reservable?: boolean;
  /** Set by server-side enrichment; clients should treat null as "no link". */
  affiliate_url?: string | null;
  /** Set for place recs: Google Maps directions search URL. */
  directions_url?: string;
  /** Set for place recs: Google "X menu" search URL. */
  menu_url?: string;
  tier?: LinkTier;
  /**
   * True when the rec was synthesized server-side by the off-catalog prose
   * scanner (not emitted by the model in its RECS block). The frontend
   * treats these as low-confidence for image lookups — better to render the
   * accent tile than a wrong photo.
   */
  synth?: boolean;
};

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  recs?: Rec[];
};

/**
 * Application-level user account. Created on first magic-link signup
 * via /api/auth/callback. Stripe fields are nullable until checkout
 * lands in the next phase.
 */
export type User = {
  id: string;
  email: string;
  subscription_status: "none" | "active" | "canceled";
  plan: "monthly" | "annual" | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  created_at: string;
};

/**
 * Per-device free-use counter. Keyed by device_id (the cookie). On
 * signup, user_id is stamped so the count carries forward.
 */
export type UsageCounter = {
  id: string;
  device_id: string;
  fingerprint: string | null;
  user_id: string | null;
  free_uses_count: number;
  created_at: string;
  updated_at: string;
};
