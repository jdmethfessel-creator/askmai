/**
 * Look helpers - Phase 5.
 *
 * A Look is a saved outfit surface with a shareable slug. Reads +
 * writes go through supabaseAdmin; every field is nullable so a fresh
 * environment (no looks table) simply returns null and callers hide
 * the surface.
 */

import { supabaseAdmin } from "./supabase";

export type LookItem = {
  id?: string;
  name: string;
  brand?: string | null;
  price?: number | null;
  price_display?: string | null;
  source_network?: string | null;
  image_url: string;
  affiliate_url: string;
};

export type LookRow = {
  id: string;
  slug: string;
  creator_slug: string;
  title: string | null;
  items: LookItem[];
  total: number | null;
  created_at: string;
};

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function generateLookSlug(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += ALPHABET[bytes[i] & 31];
  return s;
}

export function lookNumberFromSlug(slug: string): string {
  let n = 0;
  for (const ch of slug) n = (n * 31 + ch.charCodeAt(0)) | 0;
  const three = Math.abs(n) % 999 + 1;
  return String(three).padStart(3, "0");
}

export async function loadLook(slug: string): Promise<LookRow | null> {
  const clean = (slug ?? "").trim().toUpperCase().slice(0, 32);
  if (!clean) return null;
  try {
    const sb = supabaseAdmin();
    const { data } = await sb
      .from("looks")
      .select("id, slug, creator_slug, title, items, total, created_at")
      .eq("slug", clean)
      .maybeSingle();
    if (!data) return null;
    return {
      ...(data as Omit<LookRow, "items"> & { items: unknown }),
      items: Array.isArray(data.items) ? (data.items as LookItem[]) : [],
    };
  } catch {
    return null;
  }
}

export async function createLook(args: {
  creatorSlug: string;
  title: string | null;
  items: LookItem[];
}): Promise<{ slug: string } | null> {
  const sb = supabaseAdmin();
  const total = args.items.reduce(
    (n, it) => n + (typeof it.price === "number" ? it.price : 0),
    0
  );
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = generateLookSlug();
    try {
      const { data, error } = await sb
        .from("looks")
        .insert({
          slug,
          creator_slug: args.creatorSlug,
          title: args.title,
          items: args.items,
          total: total > 0 ? total : null,
        })
        .select("slug")
        .maybeSingle();
      if (error) {
        if ((error as { code?: string }).code === "23505") continue;
        return null;
      }
      if (data) return { slug: data.slug };
    } catch {
      return null;
    }
  }
  return null;
}

export function networkLabel(network: string | null | undefined): string {
  const s = (network ?? "").trim().toLowerCase();
  if (s === "shopmy") return "ShopMy";
  if (s === "shopbop") return "Shopbop";
  if (s === "revolve") return "Revolve";
  if (s === "fwrd") return "FWRD";
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}

export function fmtPrice(n: number | null | undefined, display?: string | null): string {
  if (display && display.trim()) return display.trim();
  if (typeof n !== "number") return "";
  return `$${Math.round(n)}`;
}
