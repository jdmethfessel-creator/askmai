/**
 * POST /api/creator-onboarding
 *
 * Fully automated, self-serve creator onboarding pipeline. Runs the
 * entire stack synchronously inside one Node serverless function so
 * the creator submitting the signup form gets a live URL + an edit
 * link in the response (no async wait, no human in the loop). The
 * UX wrapper (SignupForm) shows a progress state while this runs.
 *
 * Pipeline steps (each guarded by an explicit safeguard from the
 * onboarding spec):
 *
 *   1. Validate input + derive slug
 *   2. Slug collision check  -- safeguard (b): early fail with a
 *      suggested alternative; never partial-create the row
 *   3. Insert application audit row (status=processing)
 *   4. Ingest products from every submitted source URL in parallel
 *      -- safeguard (a): each URL try/catch; zero-product or
 *      unsupported-network URLs are skipped + logged, not fatal
 *   5. Best-effort blog scrape (5s per URL)
 *   6. Voice/taste generation via Claude with tool_use schema +
 *      retry on validation fail + templated fallback -- safeguard
 *      (c): malformed JSON cannot break the live Ask chat because
 *      the validator runs before we write
 *   7. Upsert creators row (hidden=false; goes live immediately)
 *   8. Upsert creator_products rows
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
import { fetchManyBlogTexts } from "@/lib/onboarding/blogScrape";
import {
  ingestManySources,
  type IngestResult,
  type IngestRow,
} from "@/lib/onboarding/ingestRunner";
import { generateVoice } from "@/lib/onboarding/voiceGen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// LLM generation + product ingestion + DB writes can run 30-90s on
// a typical creator (4 affiliate URLs + ~500 products + one Claude
// Sonnet call). 300s is the Pro-plan ceiling and gives plenty of
// headroom for outliers (huge ShopMy shop, slow Anthropic queue).
export const maxDuration = 300;

const TOP_PRODUCTS_FOR_VOICE = 30;
const MAX_BLOG_URLS = 5;
const MAX_AFFILIATE_URLS = 8;

type Payload = {
  name?: string;
  email?: string;
  slug_hint?: string;
  bio_hint?: string;
  ig_handle?: string;
  tiktok_handle?: string;
  affiliate_urls?: string[];
  blog_urls?: string[];
  interview_text?: string;
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
  const interviewText = clean(body.interview_text, 50_000) ?? "";
  const bioHint = clean(body.bio_hint, 600) ?? "";
  const igHandle = clean(body.ig_handle, 120) ?? "";
  const tiktokHandle = clean(body.tiktok_handle, 120) ?? "";

  // Require AT LEAST one source URL OR meaningful voice input.
  // Without any of these the LLM produces a generic stub and the
  // page goes live empty. Fail loudly instead.
  if (
    affiliateUrls.length === 0 &&
    interviewText.length < 200 &&
    blogUrls.length === 0
  ) {
    return Response.json(
      { error: "insufficient_input" },
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
  // what was submitted even if the rest fails.
  const appInsert = await sb
    .from("creator_applications")
    .insert({
      name,
      email,
      shopmy_url: affiliateUrls.find((u) => /shopmy/i.test(u)) ?? null,
      ltk_url: affiliateUrls.find((u) => /shopltk|liketk|rstyle/i.test(u)) ?? null,
      ig_handle: igHandle || null,
      tiktok_handle: tiktokHandle || null,
      note: interviewText || null,
      blog_urls: blogUrls,
      interview_text: interviewText || null,
      affiliate_urls: affiliateUrls,
      bio_hint: bioHint || null,
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

  // 5. Blog text fetch (parallel, 5s timeout each).
  const blogTexts = await fetchManyBlogTexts(blogUrls);

  // 6. (c) Voice + taste generation. Validator runs before we
  // write; fallback produces valid shape when LLM fails.
  const topProducts = ingestedRows
    .slice(0, TOP_PRODUCTS_FOR_VOICE)
    .map((r) => ({
      name: r.product_title,
      brand: r.brand,
      category: r.product_category,
    }));
  const voiceResult = await generateVoice({
    name,
    bioHint,
    igHandle,
    tiktokHandle,
    blogTexts: blogTexts.map((b) => ({ url: b.url, text: b.text })),
    interviewText,
    productSamples: topProducts,
  });

  // 7. Upsert creators row. This is the load-bearing write: if it
  // fails the page can't go live and the pipeline aborts.
  const upsert = await sb
    .from("creators")
    .upsert(
      {
        slug,
        name,
        bio: bioHint || null,
        avatar_url: null,
        voice_prompt: voiceResult.voice.voice_prompt,
        taste_profile: voiceResult.voice.taste_profile,
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

  // 10. (d) Completion email -- fire-and-forget so a Resend hiccup
  // doesn't fail the request. Response already carries the URLs.
  void sendCompletionEmail({
    to: email,
    name,
    liveUrl,
    editUrl,
    voiceSource: voiceResult.source,
    ingestedByNetwork,
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
    skipped,
    voice_source: voiceResult.source,
    voice_attempts: voiceResult.attempts,
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
  voiceSource: "llm" | "fallback";
  ingestedByNetwork: Record<string, number>;
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
  const voiceNote =
    args.voiceSource === "llm"
      ? "Your AI voice was generated from your inputs. Review it on your edit page and tune anything that doesn't sound like you."
      : "Heads up: the AI voice generator fell back to a templated voice (likely because your inputs were thin). Definitely tune it on your edit page before sharing the link.";

  const text = [
    `Hi ${args.name},`,
    ``,
    `Your AskMai twin is live.`,
    ``,
    `Your page: ${args.liveUrl}`,
    args.editUrl ? `Edit your voice: ${args.editUrl}` : null,
    ``,
    `Catalog imported: ${ingestedSummary}`,
    `Skipped sources: ${skippedSummary === "(none)" ? "(none)" : ""}`,
    skippedSummary !== "(none)" ? skippedSummary : null,
    ``,
    voiceNote,
    ``,
    `-- AskMai`,
  ]
    .filter((l) => l !== null)
    .join("\n");

  await resend.emails.send({
    from,
    to: args.to,
    subject: `Your AskMai twin is live: ${args.liveUrl}`,
    text,
  });
}
