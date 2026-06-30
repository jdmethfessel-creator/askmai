/**
 * /janesmith: unified creator page with two modes (Shop / Ask).
 *
 * (Display-name shim. The underlying creator row is the same one
 * historically known as "Cass DiMicco"; the visible name was
 * changed to "Jane Smith" as a temporary placeholder. The legacy
 * /cassdimicconew URL 301s here via next.config.js.)
 *
 * Layout contract:
 *   ┌──────────────────────────────────────┐
 *   │  [eyebrow line, mode-aware]          │   <-- shared header,
 *   │  Jane Smith                          │       stays put when
 *   │  [Shop]  [Ask]                       │       toggling.
 *   ├──────────────────────────────────────┤
 *   │                                      │
 *   │   Shop body OR Ask body              │   <-- only this swaps
 *   │   (category pills + grid)            │
 *   │   (chat messages + input)            │
 *   │                                      │
 *   └──────────────────────────────────────┘
 *
 * The header (eyebrow + name + toggle) is owned by THIS page and
 * persists across mode changes. TryOnGrid and Chat render only
 * their body content; neither owns the creator name / toggle.
 *
 * Mode persistence: ?mode=shop|ask (default shop). Toggle is a
 * router.replace so the URL stays canonical and shareable; no
 * full page reload, no scroll jump.
 *
 * Affiliate attribution: preserved byte-for-byte in both modes
 * (Shop pulls creator_products.affiliate_url; Ask passes through
 * whatever affiliate_url the model response carried from the same
 * catalog).
 */

import type { Metadata } from "next";
import { Fraunces, Manrope } from "next/font/google";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { supabaseAdmin } from "@/lib/supabase";
import { getServerSession } from "@/lib/session";
import TryOnGrid from "../_tryon/TryOnGrid";
import DressingRoom from "../_tryon/DressingRoom";
import ModeToggle, { type Mode } from "../_tryon/ModeToggle";
import Chat from "../[slug]/Chat";
import type { Creator } from "@/lib/types";
import "../_tryon/tryon.css";

const CREATOR_SLUG = "janesmith";

const fraunces = Fraunces({
  subsets: ["latin"],
  display: "swap",
  axes: ["SOFT", "WONK", "opsz"],
  variable: "--font-display",
});
const manrope = Manrope({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-body",
});

const DEFAULT_ACCENT = "#a26a5a";

// Display-name mapping for source_network values stored in
// creator_products. Lowercase is the canonical form (set by the
// ingest parsers); the UI shows the brand-correct case. Unknown
// networks fall through to a generic titlecase so a new source
// always renders something readable. Admin sources (csv, manual)
// are intentionally excluded -- they're not creator-shopped
// affiliate networks and would dilute the attribution line.
const SOURCE_DISPLAY: Record<string, string> = {
  shopbop: "Shopbop",
  revolve: "Revolve",
  fwrd: "FWRD",
  shopmy: "ShopMy",
  ltk: "LTK",
};
const SOURCE_HIDDEN = new Set(["csv", "manual"]);

function formatSourceName(raw: string): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v || SOURCE_HIDDEN.has(v)) return null;
  return SOURCE_DISPLAY[v] ?? v.charAt(0).toUpperCase() + v.slice(1);
}

const SUBTITLE_SHOP = "Search my closet and favorite finds";
// Intentionally short and topic-free; the chat's greeting bubble
// inside Ask mode carries the closet/routine/travel/finds topic
// list so the eyebrow doesn't read as a duplicate of the greeting.
const SUBTITLE_ASK = "Ask me anything";
const SUBTITLE_ROOM = "Your saved pieces and looks";

export const metadata: Metadata = {
  title: "Jane Smith · AskMai",
  description:
    "Shop Jane Smith's picks or ask her your style, dining, and travel questions.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

function parseMode(raw: unknown): Mode {
  if (raw === "ask") return "ask";
  if (raw === "room") return "room";
  return "shop";
}

export default async function Page({
  searchParams,
}: {
  searchParams: { mode?: string; curated?: string };
}) {
  const admin = supabaseAdmin();
  const { data: creator } = await admin
    .from("creators")
    .select("id, slug, name, bio, theme")
    .eq("slug", CREATOR_SLUG)
    .maybeSingle();
  if (!creator) {
    redirect("/");
  }

  const session = await getServerSession();
  const mode = parseMode(searchParams?.mode);
  // Edit-mode gate (Phase 1: JD-controlled shared key, NOT
  // creator auth). The user activates edit-mode by visiting
  // /api/admin/edit-mode?key=<value>, which sets the askmai_edit
  // httpOnly cookie. We just read the cookie here to know whether
  // to render the star toggles in TryOnGrid. The cookie value is
  // checked against env.ADMIN_EDIT_KEY again on every POST to
  // /api/admin/feature-product, so a stolen cookie alone doesn't
  // grant access if the env key rotates.
  const cookieStore = await cookies();
  const editCookie = cookieStore.get("askmai_edit")?.value ?? null;
  const editMode =
    Boolean(editCookie) && editCookie === process.env.ADMIN_EDIT_KEY;
  const curated = searchParams?.curated === "1";
  const typedCreator = creator as Pick<
    Creator,
    "id" | "slug" | "name" | "bio" | "theme"
  >;
  const themeAccent =
    typedCreator.theme &&
    typeof typedCreator.theme === "object" &&
    typeof (typedCreator.theme as Record<string, unknown>).accent === "string"
      ? ((typedCreator.theme as Record<string, unknown>).accent as string)
      : null;
  const accent = themeAccent ?? DEFAULT_ACCENT;
  const creatorFirstName = typedCreator.name.trim().split(/\s+/)[0];
  const subtitle =
    mode === "ask"
      ? SUBTITLE_ASK
      : mode === "room"
      ? SUBTITLE_ROOM
      : SUBTITLE_SHOP;

  // Attribution line: "{First}'s picks from Revolve · FWRD · ..."
  // pulled from the actual source_network distribution in this
  // creator's creator_products rows. Dynamic per creator so a
  // creator with only ShopMy reads accurately as "ShopMy" alone,
  // and a creator added in the future picks up automatically.
  // Pulled only on Shop mode -- the attribution is about catalog
  // provenance, which is relevant to the Shop surface.
  let shopSources: string[] = [];
  if (mode === "shop") {
    // Pull a sample (1k rows is plenty to surface every distinct
    // source_network for any plausible catalog) then de-dup in JS.
    // PostgREST doesn't expose DISTINCT directly without an RPC; a
    // lightweight sample-and-dedup beats adding a function for one
    // line of UI copy.
    const { data: rows } = await admin
      .from("creator_products")
      .select("source_network")
      .eq("creator_id", typedCreator.id)
      .limit(1000);
    const seen = new Set<string>();
    for (const row of (rows ?? []) as { source_network: string | null }[]) {
      const display = row.source_network
        ? formatSourceName(row.source_network)
        : null;
      if (display) seen.add(display);
    }
    shopSources = Array.from(seen).sort((a, b) => a.localeCompare(b));
  }

  return (
    <div className={`${fraunces.variable} ${manrope.variable} tryon-root`}>
      {/* Shared header. Same DOM in both modes so the eyebrow,
          creator name, and toggle stay put across mode flips. */}
      <header className="creator-page-header">
        <div className="creator-page-eyebrow" key={mode}>
          {subtitle}
        </div>
        <h1 className="creator-page-title">{typedCreator.name}</h1>
        <ModeToggle current={mode} />
        {mode === "shop" && shopSources.length > 0 ? (
          <p className="creator-page-sources">
            {creatorFirstName}&apos;s picks from {shopSources.join(" · ")}
          </p>
        ) : null}
      </header>
      {/* Body swaps based on mode. Both renders go into the same
          width-constrained container so neither feels like a
          separate "card." */}
      <main className="creator-page-body">
        {mode === "shop" ? (
          <TryOnGrid
            creatorSlug={typedCreator.slug}
            creatorFirstName={creatorFirstName}
            signedIn={Boolean(session)}
            editMode={editMode}
            initialCurated={curated}
          />
        ) : mode === "room" ? (
          <DressingRoom creatorSlug={typedCreator.slug} />
        ) : (
          <div className="creator-page-chat-wrap">
            <Chat
              slug={typedCreator.slug}
              accent={accent}
              creatorFirstName={creatorFirstName}
              signedIn={Boolean(session)}
              isSubscribed={session?.subscriptionStatus === "active"}
            />
          </div>
        )}
      </main>
    </div>
  );
}
