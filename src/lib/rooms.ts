/**
 * Shared Fitting Rooms server helpers.
 *
 * Central home for room-side invariants so the individual route files
 * stay narrow orchestrators. Everything here uses supabaseAdmin so the
 * caller always ships the session-derived userId; policy lives in
 * these helpers, not in RLS (we don't want a leaky RLS bypass to also
 * bypass privacy).
 *
 * The load-bearing privacy rule this module enforces:
 *   Room feed reads (submissions, reactions, comments) require an
 *   ACTIVE membership row. Room info reads (name, creator, roster)
 *   are open to any invite-link holder. The distinction sits in
 *   `assertActiveMember` vs `loadRoomBySlug`.
 */

import { supabaseAdmin } from "./supabase";

// 11-char crockford-base32 invite slug. 55 bits of entropy: ~36 quintillion
// possibilities, collision-resistant for the room-count horizon of the
// entire product. Excludes visually ambiguous glyphs (I, L, O, U).
const INVITE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const INVITE_LEN = 11;

export function generateInviteSlug(): string {
  const bytes = new Uint8Array(INVITE_LEN);
  crypto.getRandomValues(bytes);
  let s = "";
  for (let i = 0; i < INVITE_LEN; i++) {
    s += INVITE_ALPHABET[bytes[i] & 31];
  }
  return s;
}

export type RoomRow = {
  id: string;
  name: string;
  creator_slug: string;
  host_user_id: string;
  invite_slug: string;
  is_archived: boolean;
  created_at: string;
};

export async function loadRoomBySlug(inviteSlug: string): Promise<RoomRow | null> {
  const clean = inviteSlug.trim().toUpperCase().slice(0, 32);
  if (!clean) return null;
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("fitting_rooms")
    .select("id, name, creator_slug, host_user_id, invite_slug, is_archived, created_at")
    .eq("invite_slug", clean)
    .maybeSingle();
  if (error || !data) return null;
  return data as RoomRow;
}

export type MemberRow = {
  id: string;
  room_id: string;
  user_id: string;
  role: "host" | "member";
  removed_at: string | null;
  joined_at: string;
};

/**
 * Returns the active membership row or null. Callers surface the
 * appropriate 403 or open the join flow client-side. "Active" means
 * removed_at IS NULL; a soft-removed member reads as non-member.
 */
export async function loadActiveMembership(
  roomId: string,
  userId: string
): Promise<MemberRow | null> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("fitting_room_members")
    .select("id, room_id, user_id, role, removed_at, joined_at")
    .eq("room_id", roomId)
    .eq("user_id", userId)
    .is("removed_at", null)
    .maybeSingle();
  if (error || !data) return null;
  return data as MemberRow;
}

const RENDER_BUCKET = "renders";
const PHOTO_BUCKET = "tryon-photos";
const FEED_URL_TTL_SECONDS = 60 * 10; // 10 minutes; each feed load re-signs.

export async function signRenderPath(path: string): Promise<string | null> {
  if (!path) return null;
  const sb = supabaseAdmin();
  const { data, error } = await sb.storage
    .from(RENDER_BUCKET)
    .createSignedUrl(path, FEED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

export async function signBeforePath(path: string): Promise<string | null> {
  if (!path) return null;
  const sb = supabaseAdmin();
  const { data, error } = await sb.storage
    .from(PHOTO_BUCKET)
    .createSignedUrl(path, FEED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

// Reaction taxonomy. Upvote is a distinct kind; emoji reactions live
// as "emoji:<glyph>" so we can grow the palette without a schema
// change. Downvotes are structurally impossible: nothing writes a
// "downvote" kind and the client palette doesn't offer one.
export const EMOJI_ALLOWLIST = ["🔥", "😍", "💅", "👀", "😭", "✨", "💖"] as const;
export type EmojiKind = (typeof EMOJI_ALLOWLIST)[number];

export function normalizeReactionKind(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (s === "upvote") return "upvote";
  if (s.startsWith("emoji:")) {
    const glyph = s.slice("emoji:".length);
    if ((EMOJI_ALLOWLIST as readonly string[]).includes(glyph)) {
      return `emoji:${glyph}`;
    }
    return null;
  }
  return null;
}

// Structural limits. Enforced at the API layer, not in the schema, so
// a limit change ships as a code deploy without a migration.
export const ROOM_NAME_MAX = 80;
export const CAPTION_MAX = 500;
export const COMMENT_MAX = 2000;
export const SUBMISSIONS_PAGE = 50;
export const COMMENTS_PAGE = 200;
