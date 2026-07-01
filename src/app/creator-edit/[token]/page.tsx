import type { Metadata } from "next";
import { Fraunces, Manrope } from "next/font/google";
import { notFound } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase";
import EditForm from "./EditForm";
import "./edit.css";

export const metadata: Metadata = {
  title: "Manage your AskMai page",
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

// Display-name map for source_network. Same set the creator page
// header uses; kept small + deliberate so admin sources (csv,
// manual) never surface in the manage view.
const SOURCE_DISPLAY: Record<string, string> = {
  shopbop: "Shopbop",
  revolve: "Revolve",
  fwrd: "FWRD",
  shopmy: "ShopMy",
  ltk: "LTK",
};
const SOURCE_HIDDEN = new Set(["csv", "manual"]);

function displaySource(raw: string): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v || SOURCE_HIDDEN.has(v)) return null;
  return SOURCE_DISPLAY[v] ?? v.charAt(0).toUpperCase() + v.slice(1);
}

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
    .select("id, slug, name")
    .eq("edit_token", token)
    .maybeSingle();
  if (row.error || !row.data) {
    notFound();
  }
  const creator = row.data as { id: string; slug: string; name: string };

  // Catalog summary: count creator_products rows per source_network
  // so the manage view can show "ShopMy: 812, Revolve: 200" etc.
  // 1k-row sample matches the header attribution query.
  const { data: cpRows } = await sb
    .from("creator_products")
    .select("source_network")
    .eq("creator_id", creator.id)
    .limit(2000);
  const counts = new Map<string, number>();
  for (const r of (cpRows ?? []) as { source_network: string | null }[]) {
    const display = r.source_network ? displaySource(r.source_network) : null;
    if (!display) continue;
    counts.set(display, (counts.get(display) ?? 0) + 1);
  }
  const catalogSummary = [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([source, n]) => ({ source, count: n }));

  // Prior blog URLs from the most recent creator_applications row
  // for this creator. Creators can add / remove / reorder from here.
  const { data: appRow } = await sb
    .from("creator_applications")
    .select("blog_urls")
    .eq("resolved_slug", creator.slug)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const priorBlogUrls: string[] = Array.isArray(
    (appRow as { blog_urls?: unknown } | null)?.blog_urls
  )
    ? ((appRow as { blog_urls?: string[] } | null)?.blog_urls as string[])
    : [];

  // Current content-chunk count so we can show "Mai has N passages"
  // and let the creator know when a re-scrape adds/removes.
  const { count: contentChunkCount } = await sb
    .from("creator_content")
    .select("id", { count: "exact", head: true })
    .eq("creator_id", creator.id);

  return (
    <div className={`${fraunces.variable} ${manrope.variable} edit-root`}>
      <main className="edit-page">
        <header className="edit-header">
          <p className="edit-eyebrow">Manage your AskMai page</p>
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
            This page is for you only. Add or remove the blog URLs Mai
            reads when your followers ask about travel, restaurants,
            or lifestyle. Your affiliate catalog is imported and
            summarized below.
          </p>
        </header>

        <EditForm
          token={token}
          slug={creator.slug}
          catalogSummary={catalogSummary}
          initialBlogUrls={priorBlogUrls}
          contentChunkCount={contentChunkCount ?? 0}
        />
      </main>
    </div>
  );
}
