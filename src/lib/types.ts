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

export type LinkTier = "feed" | "aggregator" | "hotel" | "none";

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
  /** Set by server-side enrichment; clients should treat null as "no link". */
  affiliate_url?: string | null;
  tier?: LinkTier;
};

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  recs?: Rec[];
};
