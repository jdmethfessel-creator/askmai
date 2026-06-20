import { notFound } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase";
import type { Creator } from "@/lib/types";
import Chat from "./Chat";

const DEFAULT_THEME = {
  bg: "#faf7f2",
  surface: "#ffffff",
  ink: "#1c1a17",
  muted: "#6b6660",
  accent: "#b8746a",
};

export const dynamic = "force-dynamic";

export default async function CreatorPage({
  params,
}: {
  params: { slug: string };
}) {
  const { data, error } = await supabaseAdmin()
    .from("creators")
    .select("id, slug, name, bio, avatar_url, theme, voice_prompt, taste_profile")
    .eq("slug", params.slug)
    .maybeSingle();

  if (error || !data) notFound();

  const creator = data as Creator;
  const theme = { ...DEFAULT_THEME, ...(creator.theme ?? {}) };

  const cssVars: React.CSSProperties = {
    ["--bg" as string]: theme.bg,
    ["--surface" as string]: theme.surface,
    ["--ink" as string]: theme.ink,
    ["--muted" as string]: theme.muted,
    ["--accent" as string]: theme.accent,
  };

  return (
    <div
      className="min-h-dvh flex flex-col"
      style={{ ...cssVars, background: theme.bg, color: theme.ink }}
    >
      <header className="px-5 pt-8 pb-6 sm:pt-12 sm:pb-8 max-w-xl w-full mx-auto">
        <div className="flex items-center gap-4">
          <Avatar src={creator.avatar_url} name={creator.name} />
          <div className="min-w-0">
            <h1 className="font-serif text-2xl sm:text-3xl tracking-tight leading-tight">
              {creator.name}
            </h1>
            <p className="text-xs uppercase tracking-widest mt-0.5 opacity-60">
              ask her ai
            </p>
          </div>
        </div>
        {creator.bio && (
          <p className="mt-4 text-sm leading-relaxed opacity-80">
            {creator.bio}
          </p>
        )}
      </header>

      <Chat slug={creator.slug} accent={theme.accent} />
    </div>
  );
}

function Avatar({ src, name }: { src: string | null; name: string }) {
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={src}
        alt={name}
        className="h-14 w-14 sm:h-16 sm:w-16 rounded-full object-cover"
      />
    );
  }
  return (
    <div
      className="h-14 w-14 sm:h-16 sm:w-16 rounded-full flex items-center justify-center font-serif text-xl"
      style={{ background: "var(--accent)", color: "var(--surface)" }}
    >
      {name.trim().charAt(0).toUpperCase()}
    </div>
  );
}
