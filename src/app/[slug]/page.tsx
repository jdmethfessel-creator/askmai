import { notFound } from "next/navigation";
import Link from "next/link";
import { supabaseAdmin } from "@/lib/supabase";
import { getServerSession } from "@/lib/session";
import type { Creator } from "@/lib/types";
import { CreatorAvatar } from "../_components/CreatorAvatar";
import NavAuth from "../_components/NavAuth";
import Chat from "./Chat";

const DEFAULT_THEME = {
  bg: "#f7f1ea",
  surface: "#ffffff",
  ink: "#221d18",
  muted: "#7a6e63",
  accent: "#a26a5a",
};

export const dynamic = "force-dynamic";

export default async function CreatorPage({
  params,
}: {
  params: { slug: string };
}) {
  const sb = supabaseAdmin();
  // `hidden` is column-tolerant: if the migration hasn't been applied
  // yet, Postgres returns code 42703 and we retry without it (treating
  // every creator as visible). Once the column exists the primary query
  // succeeds and hidden=true 404s normally.
  const cols =
    "id, slug, name, bio, avatar_url, theme, voice_prompt, taste_profile, hidden";
  const primary = await sb
    .from("creators")
    .select(cols)
    .eq("slug", params.slug)
    .maybeSingle();

  let row: (Creator & { hidden?: boolean | null }) | null = null;
  if (primary.error?.code === "42703") {
    const fb = await sb
      .from("creators")
      .select(
        "id, slug, name, bio, avatar_url, theme, voice_prompt, taste_profile"
      )
      .eq("slug", params.slug)
      .maybeSingle();
    if (fb.error || !fb.data) notFound();
    row = { ...(fb.data as Creator), hidden: false };
  } else if (primary.error || !primary.data) {
    notFound();
  } else {
    row = primary.data as Creator;
  }
  if (!row || row.hidden) notFound();

  const creator = row;
  const session = await getServerSession();
  const theme = { ...DEFAULT_THEME, ...(creator.theme ?? {}) };
  const followerLabel = deriveFollowers(creator.taste_profile);

  const cssVars: React.CSSProperties = {
    ["--bg" as string]: theme.bg,
    ["--surface" as string]: theme.surface,
    ["--ink" as string]: theme.ink,
    ["--muted" as string]: theme.muted,
    ["--accent" as string]: theme.accent,
  };

  return (
    <div
      className="min-h-dvh w-full flex flex-col items-center"
      style={{ ...cssVars, background: theme.bg, color: theme.ink }}
    >
      {/* Thin top bar — persistent Log-in entry point so a returning
          subscriber doesn't have to trip the paywall first. Stays
          quiet visually: just a small text affordance, themed to the
          creator's palette via the accent var. */}
      <div className="w-full flex justify-end px-5 sm:px-8 pt-4">
        <NavAuth
          signedIn={Boolean(session)}
          className="text-[12px] tracking-[0.04em] opacity-65 hover:opacity-100 transition-opacity bg-transparent border-0 cursor-pointer"
          signedInClassName="text-[11px] tracking-[0.04em] opacity-55 px-3 py-1 rounded-full border border-current/15"
          modalAccent={theme.accent}
        />
      </div>
      <main className="w-full max-w-[480px] px-5 pt-6 sm:pt-8 pb-6 flex flex-col">
        <header className="text-center">
          <CreatorAvatar
            src={creator.avatar_url}
            initial={creator.name.trim().charAt(0).toUpperCase()}
            alt={creator.name}
            imgClassName="h-[100px] w-[100px] rounded-full ring-4 ring-white shadow-[0_10px_30px_-10px_rgba(0,0,0,0.25)] object-cover mx-auto"
            tileClassName="h-[100px] w-[100px] rounded-full ring-4 ring-white shadow-[0_10px_30px_-10px_rgba(0,0,0,0.25)] mx-auto flex items-center justify-center font-serif text-white text-[40px]"
            tileStyle={{
              background: `linear-gradient(135deg, ${theme.accent}, ${theme.accent}b3 60%, ${theme.accent}80)`,
            }}
          />
          <h1 className="font-serif mt-5 text-3xl sm:text-[34px] tracking-tight leading-tight">
            {creator.name}
          </h1>
          <p className="mt-1 text-[13px] opacity-55">
            @{creator.slug}
            {followerLabel ? ` · ${followerLabel}` : ""}
          </p>
          <span
            className="inline-flex items-center gap-1.5 mt-4 rounded-full px-3 py-1 text-[11px] font-medium tracking-wide"
            style={{
              background: `${theme.accent}1f`,
              color: theme.accent,
            }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full live-dot"
              style={{ background: theme.accent }}
            />
            Find my favorites
          </span>
          {creator.bio && (
            <p className="mt-5 text-[14px] leading-relaxed opacity-75 max-w-[360px] mx-auto">
              {creator.bio}
            </p>
          )}
        </header>

        <section
          className="mt-7 rounded-3xl flex flex-col overflow-hidden"
          style={{
            background: theme.surface,
            boxShadow:
              "0 8px 28px -10px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.04)",
          }}
        >
          <Chat
            slug={creator.slug}
            accent={theme.accent}
            creatorFirstName={creator.name.trim().split(/\s+/)[0]}
            signedIn={Boolean(session)}
            isSubscribed={session?.subscriptionStatus === "active"}
          />
        </section>

        <footer className="mt-6 mb-2 text-[11px] opacity-40 text-center">
          Powered by{" "}
          <Link href="/" className="underline underline-offset-2">
            AskMai
          </Link>{" "}
          · askmai.co/{creator.slug}
        </footer>
      </main>
    </div>
  );
}

function deriveFollowers(tp: Creator["taste_profile"]): string | null {
  if (!tp || typeof tp !== "object") return null;
  const identity = (tp as Record<string, unknown>).identity;
  if (!identity || typeof identity !== "object") return null;
  const background = (identity as Record<string, unknown>).background;
  if (typeof background !== "string") return null;
  const m = background.match(/~?(\d+(?:\.\d+)?)\s*([KMB])\s+(?:following|followers)/i);
  if (!m) return null;
  return `${m[1]}${m[2].toUpperCase()} followers`;
}
