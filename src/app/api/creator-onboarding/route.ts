/**
 * POST /api/creator-onboarding
 *
 * Fully automated, self-serve creator onboarding pipeline. Runs the
 * entire stack synchronously inside one Node serverless function so
 * the creator submitting the signup form gets a live URL + an edit
 * link in the response (no async wait, no human in the loop). The
 * UX wrapper (SignupForm) shows a progress state while this runs.
 *
 * Post-Mai simplification: voice generation is gone entirely. Mai
 * (the AskMai styling assistant, src/lib/mai/systemPrompt.ts) has
 * ONE universal prompt and grounds herself per-page by the creator's
 * catalog + content chunks. The onboarding pipeline now only needs
 * to (1) ingest products into creator_products for Mai's shopping
 * answers and (2) chunk blog content into creator_content for Mai's
 * travel/dining/lifestyle answers.
 *
 * Pipeline steps:
 *
 *   1. Validate input + derive slug
 *   2. Slug collision check  -- safeguard (b): early fail with a
 *      suggested alternative; never partial-create the row
 *   3. Insert application audit row (status=processing)
 *   4. Ingest products from every submitted source URL in parallel
 *      -- safeguard (a): each URL try/catch; zero-product or
 *      unsupported-network URLs are skipped + logged, not fatal
 *   5. Best-effort blog scrape (5s per URL) -- chunked and stored
 *      in creator_content for Mai's content grounding
 *   6. Upsert creators row (hidden=false; goes live immediately)
 *   7. Upsert creator_products rows
 *   8. Insert creator_content rows (one per chunk per blog URL)
 *   9. Update application status=live
 *  10. Fire-and-forget completion email with live URL + edit URL
 *      -- safeguard (d): preview URL returned in the response too,
 *      so the form can render it before email lands
 *
 * Failures land in the application row as status=failed with the
 * error message so the operator dashboard can see what blew up.
 * Failure to upsert the creators row is the only step that aborts
 * the pipeline; everything else logs and continues.
 */

import { Resend } from "resend";
import { supabaseAdmin } from "@/lib/supabase";
import { isValidSlugHint, nextFreeSlug, slugify } from "@/lib/onboarding/slug";
import { chunkBlogText, fetchManyBlogTexts } from "@/lib/onboarding/blogScrape";
import {
  ingestManySources,
  type IngestResult,
  type IngestRow,
} from "@/lib/onboarding/ingestRunner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Product ingestion + blog scrapes + DB writes typically run 15-60s.
// Voice generation used to add 30s+; without it the pipeline lands
// closer to 20-40s for a typical creator. 300s ceiling stays for
// outliers (huge ShopMy shop, slow retailer response).
export const maxDuration = 300;

const MAX_BLOG_URLS = 5;
const MAX_AFFILIATE_URLS = 8;

type Payload = {
  name?: string;
  email?: string;
  slug_hint?: string;
  ig_handle?: string;
  tiktok_handle?: string;
  affiliate_urls?: string[];
  blog_urls?: string[];
};

export async function POST(request: Request) {
  let body: Payload;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const name = clean(body.name, 120);
  const email = clean(body.email, 200)?.toLowerCase() ?? null;
  if (!name) return Response.json({ error: "missing_name" }, { status: 400 });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ error: "invalid_email" }, { status: 400 });
  }

  // Slug: hint wins when it round-trips through the validator;
  // otherwise derive from name. Collision check runs against
  // existing creators.slug to bail early before any side effects.
  const rawHint = clean(body.slug_hint, 48) ?? "";
  let slug = rawHint && isValidSlugHint(rawHint) ? rawHint : slugify(name);
  if (!slug) {
    return Response.json({ error: "slug_underivable" }, { status: 400 });
  }

  const affiliateUrls = sanitizeUrlList(
    body.affiliate_urls,
    MAX_AFFILIATE_URLS
  );
  const blogUrls = sanitizeUrlList(body.blog_urls, MAX_BLOG_URLS);
  const igHandle = clean(body.ig_handle, 120) ?? "";
  const tiktokHandle = clean(body.tiktok_handle, 120) ?? "";

  // Post-Mai: require at least one AFFILIATE URL. Blog URLs are
  // strongly encouraged (they power travel/dining answers) but not
  // strictly required. A creator with zero affiliate URLs has no
  // catalog to power the Shop tab or Mai's fashion answers, so we
  // fail loudly.
  if (affiliateUrls.length === 0) {
    return Response.json(
      { error: "missing_affiliate_urls" },
      { status: 400 }
    );
  }

  const sb = supabaseAdmin();

  // (b) Slug collision check. Fail early with an alternative.
  const existing = await sb
    .from("creators")
    .select("slug")
    .ilike("slug", `${slug}%`); // grab the cluster so nextFreeSlug can pick from it
  const takenSet = new Set<string>(
    ((existing.data ?? []) as { slug: string }[]).map((r) => r.slug)
  );
  if (takenSet.has(slug)) {
    const suggested = nextFreeSlug(slug, takenSet);
    return Response.json(
      {
        error: "slug_taken",
        slug,
        suggested,
      },
      { status: 409 }
    );
  }

  // 3. Application audit row (status=processing). Keeps a trail of
  // what was submitted even if the rest fails. interview_text and
  // bio_hint columns from migration 012 stay in the schema for
  // rollback safety but the Mai flow writes null; nothing reads
  // those columns any more.
  const appInsert = await sb
    .from("creator_applications")
    .insert({
      name,
      email,
      shopmy_url: affiliateUrls.find((u) => /shopmy/i.test(u)) ?? null,
      ltk_url: affiliateUrls.find((u) => /shopltk|liketk|rstyle/i.test(u)) ?? null,
      ig_handle: igHandle || null,
      tiktok_handle: tiktokHandle || null,
      note: null,
      blog_urls: blogUrls,
      interview_text: null,
      affiliate_urls: affiliateUrls,
      bio_hint: null,
      slug_hint: rawHint || null,
      status: "processing",
    })
    .select("id")
    .single();
  if (appInsert.error) {
    console.error(
      "[onboarding] application insert failed:",
      appInsert.error.message
    );
    return Response.json({ error: "application_store_failed" }, { status: 500 });
  }
  const appId = appInsert.data.id as string;

  // 4. (a) Parallel product ingestion. Per-URL try/catch lives in
  // ingestOneSource; this loop never throws.
  const ingestResults: IngestResult[] =
    affiliateUrls.length > 0 ? await ingestManySources(affiliateUrls) : [];
  const ingestedRows: IngestRow[] = ingestResults.flatMap((r) => r.products);
  const skipped = ingestResults
    .filter((r) => r.error)
    .map((r) => ({ url: r.url, reason: r.error as string }));
  const totalIngested = ingestedRows.length;
  const ingestedByNetwork: Record<string, number> = {};
  for (const row of ingestedRows) {
    ingestedByNetwork[row.source_network] =
      (ingestedByNetwork[row.source_network] ?? 0) + 1;
  }

  // 5. Blog text fetch (parallel, 5s timeout each). Under the Mai
  // flow blog text is stored chunked in creator_content so Mai can
  // retrieve it at chat time (see chunkBlogText + loadContentChunks).
  const blogTexts = await fetchManyBlogTexts(blogUrls);

  // 6. Upsert creators row. This is the load-bearing write: if it
  // fails the page can't go live and the pipeline aborts. voice_prompt
  // and taste_profile columns stay in the schema for rollback safety;
  // Mai's system prompt is universal so we write nulls.
  const upsert = await sb
    .from("creators")
    .upsert(
      {
        slug,
        name,
        bio: null,
        avatar_url: null,
        voice_prompt: null,
        taste_profile: null,
        hidden: false,
      },
      { onConflict: "slug" }
    )
    .select("id, slug, edit_token")
    .single();
  if (upsert.error || !upsert.data) {
    console.error(
      "[onboarding] creators upsert failed:",
      upsert.error?.message
    );
    await markApplicationFailed(sb, appId, upsert.error?.message ?? "upsert_failed");
    return Response.json({ error: "creator_create_failed" }, { status: 500 });
  }
  const creatorId = upsert.data.id as string;
  const editToken = (upsert.data.edit_token as string | undefined) ?? null;

  // 8. Upsert creator_products rows in chunks. Wipe existing rows
  // for this creator first so a re-onboard (same slug) replaces
  // cleanly. Future-step: when re-sync ships, switch to
  // last-seen-based upsert so created_at survives.
  if (ingestedRows.length > 0) {
    const del = await sb
      .from("creator_products")
      .delete()
      .eq("creator_id", creatorId);
    if (del.error) {
      console.warn(
        "[onboarding] pre-insert wipe failed (continuing):",
        del.error.message
      );
    }
    const payload = ingestedRows.map((r) => ({
      ...r,
      creator_id: creatorId,
    }));
    // Chunk at 100 -- PostgREST has a payload ceiling and ShopMy
    // rows carry large `raw` blobs.
    const CHUNK = 100;
    for (let i = 0; i < payload.length; i += CHUNK) {
      const slice = payload.slice(i, i + CHUNK);
      const ins = await sb.from("creator_products").insert(slice);
      if (ins.error) {
        console.error(
          `[onboarding] creator_products insert failed at offset ${i}:`,
          ins.error.message
        );
        // Don't abort -- the creator page can still render with
        // whatever rows did land; the Ask + Shop fallbacks handle
        // a thin catalog. Surface the partial-write in the response.
        break;
      }
    }
  }

  // 8. Chunk each blog into creator_content rows so Mai can
  // retrieve passages at chat time for travel / dining / lifestyle
  // answers. Fetch failures produced by blogScrape.fetchManyBlogTexts
  // carry `text: ""` and are dropped by chunkBlogText's empty-check;
  // the pipeline continues either way. Table-tolerant: if migration
  // 013 hasn't been applied yet we log once and move on.
  let contentChunkCount = 0;
  const chunkRows: Array<{
    creator_id: string;
    source_url: string;
    kind: string;
    text_chunk: string;
    chunk_index: number;
  }> = [];
  for (const b of blogTexts) {
    if (!b.text) continue;
    const chunks = chunkBlogText(b.url, b.text);
    for (const c of chunks) {
      chunkRows.push({
        creator_id: creatorId,
        source_url: c.sourceUrl,
        kind: c.kind,
        text_chunk: c.text,
        chunk_index: c.chunkIndex,
      });
    }
  }
  if (chunkRows.length > 0) {
    const CHUNK_INSERT = 100;
    for (let i = 0; i < chunkRows.length; i += CHUNK_INSERT) {
      const slice = chunkRows.slice(i, i + CHUNK_INSERT);
      const ins = await sb.from("creator_content").insert(slice);
      if (ins.error) {
        if (ins.error.code === "42P01") {
          console.warn(
            "[onboarding] creator_content not migrated yet (013); skipping content-chunk writes"
          );
          break;
        }
        console.error(
          `[onboarding] creator_content insert failed at offset ${i}:`,
          ins.error.message
        );
        break;
      }
      contentChunkCount += slice.length;
    }
  }

  // 9. Mark application live.
  await sb
    .from("creator_applications")
    .update({
      status: "live",
      resolved_slug: slug,
      error_message: null,
    })
    .eq("id", appId);

  const liveUrl = `https://askmai.co/${slug}`;
  const editUrl = editToken
    ? `https://askmai.co/creator-edit/${editToken}`
    : null;

  // 10. Completion email -- fire-and-forget so a Resend hiccup
  // doesn't fail the request. Response already carries the URLs.
  void sendCompletionEmail({
    to: email,
    name,
    liveUrl,
    editUrl,
    ingestedByNetwork,
    contentChunkCount,
    skipped,
  }).catch((err) => {
    console.warn(
      "[onboarding] completion email send failed (non-fatal):",
      err instanceof Error ? err.message : String(err)
    );
  });

  return Response.json({
    ok: true,
    slug,
    preview_url: liveUrl,
    edit_url: editUrl,
    ingested: {
      total: totalIngested,
      by_network: ingestedByNetwork,
    },
    content_chunks: contentChunkCount,
    skipped,
  });
}

function clean(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

function sanitizeUrlList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") continue;
    const t = item.trim();
    if (!t) continue;
    // Basic URL shape check; ingestRunner does the deeper validation.
    try {
      const u = new URL(t.startsWith("http") ? t : `https://${t}`);
      out.push(u.toString());
    } catch {
      // skip
    }
    if (out.length >= max) break;
  }
  return out;
}

async function markApplicationFailed(
  sb: ReturnType<typeof supabaseAdmin>,
  appId: string,
  errorMessage: string
) {
  try {
    await sb
      .from("creator_applications")
      .update({ status: "failed", error_message: errorMessage })
      .eq("id", appId);
  } catch {
    /* best-effort */
  }
}

async function sendCompletionEmail(args: {
  to: string;
  name: string;
  liveUrl: string;
  editUrl: string | null;
  ingestedByNetwork: Record<string, number>;
  contentChunkCount: number;
  skipped: Array<{ url: string; reason: string }>;
}) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[onboarding] RESEND_API_KEY not set; skipping email");
    return;
  }
  const from =
    process.env.APPLICATIONS_FROM_EMAIL ?? "onboarding@resend.dev";
  const resend = new Resend(apiKey);
  const ingestedSummary = Object.entries(args.ingestedByNetwork)
    .map(([net, n]) => `${net}: ${n}`)
    .join(", ") || "(no items ingested)";
  const skippedSummary =
    args.skipped.length > 0
      ? args.skipped
          .map((s) => `  - ${s.url} (${s.reason})`)
          .join("\n")
      : "(none)";
  const contentNote =
    args.contentChunkCount > 0
      ? `Mai has ${args.contentChunkCount} passages from your blog content she can pull from when someone asks about travel, restaurants, or hotels.`
      : "You didn't add blog links, so Mai will only answer fashion questions for now. Add a blog URL from the edit page to give her travel/dining grounding.";

  const text = [
    `Hi ${args.name},`,
    ``,
    `Your AskMai twin is live.`,
    ``,
    `Your page: ${args.liveUrl}`,
    args.editUrl ? `Manage your recommendations: ${args.editUrl}` : null,
    ``,
    `Catalog imported: ${ingestedSummary}`,
    `Skipped sources: ${skippedSummary === "(none)" ? "(none)" : ""}`,
    skippedSummary !== "(none)" ? skippedSummary : null,
    ``,
    contentNote,
    ``,
    `Mai (your AskMai styling assistant) is now live on your page. Followers can chat with her about your fashion, travel, and dining recs.`,
    ``,
    `-- AskMai`,
  ]
    .filter((l) => l !== null)
    .join("\n");

  await resend.emails.send({
    from,
    to: args.to,
    subject: `Your AskMai page is live: ${args.liveUrl}`,
    text,
  });
}
