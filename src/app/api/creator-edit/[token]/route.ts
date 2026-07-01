/**
 * GET  /api/creator-edit/[token]
 * PUT  /api/creator-edit/[token]
 *
 * Tokenized self-serve manage endpoint for a creator's AskMai page.
 * Post-Mai: no voice_prompt / taste_profile editing -- Mai has one
 * universal voice. What creators can edit here is the SET of blog
 * URLs Mai reads as grounding for travel / dining / lifestyle
 * answers.
 *
 * The token is the credentials; no login. The completion email at
 * onboarding time contains the URL, so only the creator has it.
 *
 * GET body: { ok, slug, name, blog_urls, chunk_count }.
 * PUT body: { blog_urls: string[] }.
 * PUT semantics: replace-in-place. Wipe existing creator_content
 * rows for this creator, re-fetch each URL, chunk the text, insert
 * fresh rows. Synchronous so the response can carry the new chunk
 * count + any skip reasons.
 */

import { supabaseAdmin } from "@/lib/supabase";
import {
  chunkBlogText,
  fetchManyBlogTexts,
} from "@/lib/onboarding/blogScrape";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Re-fetching + re-chunking N blogs runs 5-30s; keep the ceiling
// generous for slow blog hosts.
export const maxDuration = 120;

const MAX_BLOG_URLS = 5;

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    s
  );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  if (!isUuid(token)) {
    return Response.json({ error: "invalid_token" }, { status: 400 });
  }
  const sb = supabaseAdmin();
  const row = await sb
    .from("creators")
    .select("id, slug, name")
    .eq("edit_token", token)
    .maybeSingle();
  if (row.error || !row.data) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const creator = row.data as { id: string; slug: string; name: string };

  const { data: appRow } = await sb
    .from("creator_applications")
    .select("blog_urls")
    .eq("resolved_slug", creator.slug)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const blog_urls: string[] = Array.isArray(
    (appRow as { blog_urls?: unknown } | null)?.blog_urls
  )
    ? ((appRow as { blog_urls?: string[] } | null)?.blog_urls as string[])
    : [];

  const { count } = await sb
    .from("creator_content")
    .select("id", { count: "exact", head: true })
    .eq("creator_id", creator.id);

  return Response.json({
    ok: true,
    slug: creator.slug,
    name: creator.name,
    blog_urls,
    chunk_count: count ?? 0,
  });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  if (!isUuid(token)) {
    return Response.json({ error: "invalid_token" }, { status: 400 });
  }
  let body: { blog_urls?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const rawUrls = Array.isArray(body.blog_urls) ? body.blog_urls : [];
  const cleanedUrls: string[] = [];
  for (const raw of rawUrls) {
    if (typeof raw !== "string") continue;
    const t = raw.trim();
    if (!t) continue;
    try {
      const u = new URL(t.startsWith("http") ? t : `https://${t}`);
      cleanedUrls.push(u.toString());
    } catch {
      // skip malformed
    }
  }
  if (cleanedUrls.length > MAX_BLOG_URLS) {
    return Response.json({ error: "too_many_urls" }, { status: 400 });
  }

  const sb = supabaseAdmin();
  const row = await sb
    .from("creators")
    .select("id, slug")
    .eq("edit_token", token)
    .maybeSingle();
  if (row.error || !row.data) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const creator = row.data as { id: string; slug: string };

  // Persist the URL list on the most recent application row for
  // this creator so the manage view reflects it on the next load.
  // If no application row exists (hand-seeded creator), we skip the
  // update but still re-scrape + re-insert content chunks.
  const { data: appRow } = await sb
    .from("creator_applications")
    .select("id")
    .eq("resolved_slug", creator.slug)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (appRow?.id) {
    await sb
      .from("creator_applications")
      .update({ blog_urls: cleanedUrls })
      .eq("id", appRow.id);
  }

  // Wipe existing chunks, refetch each URL, chunk fresh. Fetch
  // failures land in `skipped` and don't abort the save.
  await sb.from("creator_content").delete().eq("creator_id", creator.id);
  const skipped: Array<{ url: string; reason: string }> = [];
  let chunks = 0;
  if (cleanedUrls.length > 0) {
    const results = await fetchManyBlogTexts(cleanedUrls);
    const rows: Array<{
      creator_id: string;
      source_url: string;
      kind: string;
      text_chunk: string;
      chunk_index: number;
    }> = [];
    for (const r of results) {
      if (r.error) {
        skipped.push({ url: r.url, reason: r.error });
        continue;
      }
      if (!r.text) {
        skipped.push({ url: r.url, reason: "empty_body" });
        continue;
      }
      const cs = chunkBlogText(r.url, r.text);
      for (const c of cs) {
        rows.push({
          creator_id: creator.id,
          source_url: c.sourceUrl,
          kind: c.kind,
          text_chunk: c.text,
          chunk_index: c.chunkIndex,
        });
      }
    }
    if (rows.length > 0) {
      const CHUNK_INSERT = 100;
      for (let i = 0; i < rows.length; i += CHUNK_INSERT) {
        const slice = rows.slice(i, i + CHUNK_INSERT);
        const ins = await sb.from("creator_content").insert(slice);
        if (ins.error) {
          console.error(
            `[creator-edit] creator_content insert failed at offset ${i}:`,
            ins.error.message
          );
          break;
        }
        chunks += slice.length;
      }
    }
  }

  return Response.json({ ok: true, slug: creator.slug, chunks, skipped });
}
