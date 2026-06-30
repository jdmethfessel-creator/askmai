import type { Metadata } from "next";
import { Fraunces, Manrope } from "next/font/google";
import { notFound } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase";
import EditForm from "./EditForm";
import "./edit.css";

export const metadata: Metadata = {
  title: "Edit your AskMai twin",
  // Tokenized URL; never expose in search.
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

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

export default async function Page({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    notFound();
  }
  const sb = supabaseAdmin();
  const row = await sb
    .from("creators")
    .select("slug, name, voice_prompt, taste_profile")
    .eq("edit_token", token)
    .maybeSingle();
  if (row.error || !row.data) {
    notFound();
  }
  const creator = row.data as {
    slug: string;
    name: string;
    voice_prompt: string | null;
    taste_profile: unknown;
  };

  return (
    <div className={`${fraunces.variable} ${manrope.variable} edit-root`}>
      <main className="edit-page">
        <header className="edit-header">
          <p className="edit-eyebrow">Edit your AskMai twin</p>
          <h1 className="edit-title">{creator.name}</h1>
          <p className="edit-sub">
            Your live page:{" "}
            <a
              href={`/${creator.slug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="edit-link"
            >
              askmai.co/{creator.slug}
            </a>
          </p>
          <p className="edit-note">
            This page is for you only. Changes save back to your live
            AskMai page; refresh your page to see them. The Voice
            prompt is what your AI twin uses to talk like you. The
            Taste profile is what it pulls from to recommend things.
          </p>
        </header>

        <EditForm
          token={token}
          initialVoicePrompt={creator.voice_prompt ?? ""}
          initialTasteProfile={creator.taste_profile ?? {}}
          slug={creator.slug}
        />
      </main>
    </div>
  );
}
