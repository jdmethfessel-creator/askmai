/**
 * /cassdimicconew: unified creator page with two modes:
 *
 *   ?mode=shop (default)  Try-on grid surface (TryOnGrid, the
 *                         Pinterest-style catalog with the new VTON
 *                         render pipeline behind every Try This On).
 *
 *   ?mode=ask             Chat surface (the existing creator chat,
 *                         which already POSTs to /api/render with
 *                         the same kind/items contract, so outfit
 *                         and single try-ons in Ask mode flow
 *                         through the same FASHN pipeline as Shop).
 *
 * The toggle persists the selection in the URL so it's shareable
 * and survives reload. ModeToggle is a thin client wrapper around
 * router.replace; the server reads searchParams.mode once on render.
 *
 * Affiliate attribution is preserved byte-for-byte in BOTH modes:
 *  - Shop mode: TryOnGrid pulls affiliate_url straight from
 *    creator_products.affiliate_url with no rewriting.
 *  - Ask mode: Chat passes through whatever affiliate_url the AI
 *    response carried (sourced from the same catalog at prompt
 *    construction time). No Skimlinks, no link mangling.
 *
 * This page does NOT replace the existing /[slug] route; that one
 * stays chat-only for any creator without a dedicated try-on grid
 * (only Cass has one today). Static segments take routing priority
 * over the dynamic [slug] catch-all in Next's App Router.
 */

import type { Metadata } from "next";
import { Fraunces, Manrope } from "next/font/google";
import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase";
import { getServerSession } from "@/lib/session";
import TryOnGrid from "../_tryon/TryOnGrid";
import ModeToggle, { type Mode } from "../_tryon/ModeToggle";
import Chat from "../[slug]/Chat";
import type { Creator } from "@/lib/types";
import "../_tryon/tryon.css";

const CREATOR_SLUG = "cass";

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

export const metadata: Metadata = {
  title: "Cass DiMicco · AskMai",
  description:
    "Shop Cass DiMicco's picks or ask her your style, dining, and travel questions.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

function parseMode(raw: unknown): Mode {
  return raw === "ask" ? "ask" : "shop";
}

export default async function Page({
  searchParams,
}: {
  searchParams: { mode?: string };
}) {
  const admin = supabaseAdmin();
  // Chat needs a few extra fields the grid doesn't (theme accent for
  // its modal, voice / taste-profile aren't read client-side but
  // tolerating the column is cheaper than a second query). Select
  // both grid + chat needs in one round-trip.
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

  return (
    <div className={`${fraunces.variable} ${manrope.variable} tryon-root`}>
      <div className="tryon-mode-wrap">
        <ModeToggle current={mode} />
      </div>
      {mode === "shop" ? (
        <TryOnGrid
          creatorSlug={typedCreator.slug}
          creatorName={typedCreator.name}
          creatorBio={typedCreator.bio ?? null}
          signedIn={Boolean(session)}
        />
      ) : (
        <div className="tryon-ask-shell">
          <Chat
            slug={typedCreator.slug}
            accent={accent}
            creatorFirstName={creatorFirstName}
            signedIn={Boolean(session)}
            isSubscribed={session?.subscriptionStatus === "active"}
          />
        </div>
      )}
    </div>
  );
}
