/**
 * /cassdimicconew — Phase 2 try-on grid (parallel, isolated surface).
 *
 * This is a NEW static route segment; it does NOT replace the existing
 * /[slug] creator chat page and does NOT touch the chat or render
 * pipeline source. Static segments take routing priority over the
 * dynamic [slug] catch-all in Next's App Router, so /cassdimicconew
 * lands here and every other /<slug> still hits the existing chat
 * page. Adding a second creator (e.g. /madisonwallernew) is the same
 * pattern: new file, same TryOnGrid component, different slug prop.
 */

import type { Metadata } from "next";
import { Fraunces, Manrope } from "next/font/google";
import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase";
import { getServerSession } from "@/lib/session";
import TryOnGrid from "../_tryon/TryOnGrid";
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

export const metadata: Metadata = {
  title: "Cass DiMicco — Try-On Grid",
  description:
    "Browse Cass DiMicco's affiliate-linked products and try them on your photo.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function Page() {
  const admin = supabaseAdmin();
  const { data: creator } = await admin
    .from("creators")
    .select("id, slug, name, bio")
    .eq("slug", CREATOR_SLUG)
    .maybeSingle();
  if (!creator) {
    redirect("/");
  }

  const session = await getServerSession();

  return (
    <div className={`${fraunces.variable} ${manrope.variable} tryon-root`}>
      <TryOnGrid
        creatorSlug={creator.slug}
        creatorName={creator.name}
        creatorBio={creator.bio ?? null}
        signedIn={Boolean(session)}
      />
    </div>
  );
}
