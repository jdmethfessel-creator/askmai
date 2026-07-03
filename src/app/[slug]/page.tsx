/**
 * /[slug]: unified creator page with three modes (Shop / Ask / Try On).
 *
 * Layout contract:
 *   ┌──────────────────────────────────────┐
 *   │  [eyebrow line, mode-aware]          │   <-- shared header,
 *   │  Creator Name                        │       stays put when
 *   │  [Shop]  [Ask]  [Try On]             │       toggling.
 *   │  [creator]'s picks from <sources>    │
 *   ├──────────────────────────────────────┤
 *   │                                      │
 *   │   Shop / Ask / Try On body           │   <-- only this swaps
 *   │                                      │
 *   └──────────────────────────────────────┘
 *
 * This page replaces both the prior /janesmith one-off and the v1
 * single-chat /[slug] template, so every creator (auto-onboarded or
 * hand-seeded) lands on the same surface. The hardcoded janesmith
 * page was removed; /janesmith now resolves here via the [slug]
 * dynamic route. The /cassdimicconew 301 in next.config.mjs still
 * routes to /janesmith (which now hits this template).
 *
 * Mode persistence: ?mode=shop|ask|room (default shop). ModeToggle
 * does router.replace so the URL stays canonical and shareable.
 *
 * Affiliate attribution: preserved byte-for-byte in every mode.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { supabaseAdmin } from "@/lib/supabase";
import { getServerSession } from "@/lib/session";
import TryOnGrid from "../_tryon/TryOnGrid";
import DressingRoom from "../_tryon/DressingRoom";
import type { Mode } from "../_tryon/ModeToggle";
import Masthead from "../_pullsheet/Masthead";
import PullSheetTabs from "../_pullsheet/PullSheetTabs";
import Chat from "./Chat";
import type { Creator } from "@/lib/types";
import "../_tryon/tryon.css";
import "../_pullsheet/tokens.css";
import "../_pullsheet/overrides.css";

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

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const sb = supabaseAdmin();
  const { data } = await sb
    .from("creators")
    .select("name")
    .eq("slug", slug)
    .maybeSingle();
  const name = (data as { name?: string } | null)?.name ?? "Creator";
  return {
    title: `${name} · AskMai`,
    description: `Shop ${name}'s picks or ask her your style, dining, and travel questions.`,
    robots: { index: false, follow: false },
  };
}

function parseMode(raw: unknown): Mode {
  if (raw === "ask") return "ask";
  if (raw === "room") return "room";
  return "shop";
}

export default async function CreatorPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ mode?: string; recent?: string; curated?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;

  const admin = supabaseAdmin();
  // Direct-URL creator lookup. Intentionally does NOT gate on the
  // `hidden` flag: per the existing chat-route comment and the
  // prior static janesmith page's behavior, `hidden` is a
  // /creators-discovery-page filter, not a direct-URL gate. A
  // creator handed their askmai.co/<slug> URL to followers in DMs
  // can stay off the public discovery list while their page
  // still resolves for anyone with the link.
  const { data, error } = await admin
    .from("creators")
    .select("id, slug, name, bio, theme")
    .eq("slug", slug)
    .maybeSingle();
  if (error || !data) notFound();
  const creator = data as Pick<
    Creator,
    "id" | "slug" | "name" | "bio" | "theme"
  >;

  const session = await getServerSession();
  const mode = parseMode(sp?.mode);
  // Edit-mode gate (Phase 1: JD-controlled shared key, NOT creator
  // auth). User activates via /api/admin/edit-mode?key=<value>,
  // which sets the askmai_edit cookie. We just read it here to know
  // whether to render the star toggles in TryOnGrid. Cookie value
  // is re-checked against env.ADMIN_EDIT_KEY on every POST to
  // /api/admin/feature-product so a stolen cookie alone doesn't
  // grant access if the env key rotates.
  const cookieStore = await cookies();
  const editCookie = cookieStore.get("askmai_edit")?.value ?? null;
  const editMode =
    Boolean(editCookie) && editCookie === process.env.ADMIN_EDIT_KEY;
  // Accept ?recent=1 (canonical) OR ?curated=1 (back-compat alias
  // from the prior featured-only mode repurposed into recent-picks).
  const recent = sp?.recent === "1" || sp?.curated === "1";

  const themeAccent =
    creator.theme &&
    typeof creator.theme === "object" &&
    typeof (creator.theme as Record<string, unknown>).accent === "string"
      ? ((creator.theme as Record<string, unknown>).accent as string)
      : null;
  const accent = themeAccent ?? DEFAULT_ACCENT;
  const creatorFirstName = creator.name.trim().split(/\s+/)[0];
  const subtitle =
    mode === "ask"
      ? SUBTITLE_ASK
      : mode === "room"
      ? SUBTITLE_ROOM
      : SUBTITLE_SHOP;

  // Attribution + piece count for the masthead subline.
  // "1,209 pieces · styled by Mai" style; falls back to just
  // "styled by Mai" if the count query fails.
  let pieceCount = 0;
  let shopSources: string[] = [];
  try {
    const { count } = await admin
      .from("creator_products")
      .select("id", { count: "exact", head: true })
      .eq("creator_id", creator.id);
    pieceCount = count ?? 0;
  } catch {
    pieceCount = 0;
  }
  if (mode === "shop") {
    const { data: rows } = await admin
      .from("creator_products")
      .select("source_network")
      .eq("creator_id", creator.id)
      .limit(1000);
    const seen = new Set<string>();
    for (const r of (rows ?? []) as { source_network: string | null }[]) {
      const display = r.source_network
        ? formatSourceName(r.source_network)
        : null;
      if (display) seen.add(display);
    }
    shopSources = Array.from(seen).sort((a, b) => a.localeCompare(b));
  }

  const mastheadSub =
    pieceCount > 0
      ? `${pieceCount.toLocaleString()} piece${pieceCount === 1 ? "" : "s"} · styled by Mai`
      : "styled by Mai";
  // subtitle drives the mode-scoped eyebrow line under the tabs on
  // Shop; Ask + Try On carry their own chrome so we surface it only
  // in Shop mode.
  void subtitle;
  void accent;

  return (
    <div className="tryon-root">
      <Masthead name={creator.name} sub={mastheadSub} />
      <PullSheetTabs current={mode} />
      <main className="creator-page-body">
        {mode === "shop" ? (
          <>
            {shopSources.length > 0 ? (
              <p
                className="ps-masthead-sub"
                style={{ textAlign: "center", marginTop: 10 }}
              >
                {creatorFirstName}&apos;s picks from {shopSources.join(" · ")}
              </p>
            ) : null}
            <TryOnGrid
              creatorSlug={creator.slug}
              creatorFirstName={creatorFirstName}
              signedIn={Boolean(session)}
              editMode={editMode}
              initialRecent={recent}
            />
          </>
        ) : mode === "room" ? (
          <DressingRoom creatorSlug={creator.slug} />
        ) : (
          <div className="creator-page-chat-wrap">
            <Chat
              slug={creator.slug}
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
