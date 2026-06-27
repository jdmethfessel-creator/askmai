/**
 * POST /api/render
 *
 * Try-on render endpoint (Phase 2). Click-gated: this is the ONLY
 * place that fires gpt-image-1. The chat route does not render
 * automatically; the per-card "Show This Item" and per-response
 * "Try This Outfit" buttons hit here on explicit click.
 *
 * Gate order (mirrors the photo-upload route's strict ordering so a
 * failed gate never spends any provider credit):
 *
 *   1. session                  -> 401 not_signed_in
 *   2. body parse + shape       -> 400 invalid_request / no_items
 *   3. age_verified_at present  -> 403 age_not_verified
 *   4. tryon_photo_path present -> 412 no_photo
 *   5. render quota available   -> 402 no_quota
 *
 * If any gate fails the client surfaces the matched prompt (sign in,
 * upload a photo, buy a pack). Only after step 5 do we touch OpenAI.
 *
 * On a successful render:
 *   - composite the askmai.co + @creator branding band
 *   - upload to the private renders bucket
 *   - atomically consume one credit (consume_render RPC)
 *   - append-only log into public.renders
 *   - return a short-lived signed URL the user can view/share
 *
 * If consume_render returns charged=false after the upstream succeeded
 * (rare race against another concurrent render the same user fired),
 * we still return the image since the OpenAI credit is already spent,
 * and log a 'leak' line for spend reconciliation.
 *
 * Request body:
 *   {
 *     kind: "single" | "outfit",
 *     creatorSlug: string,
 *     items: Array<{ image_url: string, name?: string, brand?: string }>
 *   }
 *
 * Response:
 *   200 { ok: true, signed_url, kind, source, included_remaining, pack_balance }
 *   400 { error: "invalid_request" | "no_items" | "too_many_items" }
 *   401 { error: "not_signed_in" }
 *   402 { error: "no_quota", included_remaining, pack_balance }
 *   403 { error: "age_not_verified" }
 *   412 { error: "no_photo" }
 *   500 { error: "render_failed" | "upload_failed" }
 */

import { getServerSession } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";
import {
  consumeRender,
  fetchPersonPhoto,
  getRenderQuota,
  logRender,
  runRender,
  uploadRender,
} from "@/lib/render";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// gpt-image-1 inpaint at 1024x1536 with a mask + multiple reference
// images regularly takes 60–90s end-to-end (HF segmentation + photo
// normalization + OpenAI edit + branding + Supabase upload). Vercel's
// project-default function limit is 60s, which truncates the OpenAI
// fetch mid-flight and surfaces in our log as "fetch failed."
// Raising to the Pro plan's 300s ceiling so the fetch is the gate,
// not the runtime.
export const maxDuration = 300;

const MAX_ITEMS_PER_RENDER = 6;

type IncomingItem = {
  image_url?: string;
  name?: string;
  brand?: string;
};

type IncomingBody = {
  kind?: string;
  creatorSlug?: string;
  items?: IncomingItem[];
};

export async function POST(request: Request) {
  const session = await getServerSession();
  if (!session) {
    return Response.json({ error: "not_signed_in" }, { status: 401 });
  }

  let body: IncomingBody;
  try {
    body = (await request.json()) as IncomingBody;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const kind = body.kind === "outfit" ? "outfit" : "single";
  const items = Array.isArray(body.items) ? body.items : [];
  const imageUrls: string[] = [];
  for (const item of items) {
    const url = typeof item?.image_url === "string" ? item.image_url.trim() : "";
    if (!url) continue;
    if (!/^https?:\/\//i.test(url)) continue;
    imageUrls.push(url);
  }
  if (imageUrls.length === 0) {
    return Response.json({ error: "no_items" }, { status: 400 });
  }
  if (kind === "single" && imageUrls.length > 1) {
    imageUrls.splice(1);
  }
  if (imageUrls.length > MAX_ITEMS_PER_RENDER) {
    return Response.json({ error: "too_many_items" }, { status: 400 });
  }

  const creatorSlug =
    typeof body.creatorSlug === "string"
      ? body.creatorSlug.trim().toLowerCase().slice(0, 64)
      : "";

  const admin = supabaseAdmin();

  const userRow = await admin
    .from("users")
    .select("age_verified_at, tryon_photo_path")
    .eq("id", session.userId)
    .maybeSingle();
  if (userRow.error || !userRow.data) {
    console.error(
      "[render] users read failed:",
      userRow.error?.message ?? "missing row"
    );
    return Response.json({ error: "render_failed" }, { status: 500 });
  }
  if (!userRow.data.age_verified_at) {
    return Response.json({ error: "age_not_verified" }, { status: 403 });
  }
  const photoPath = userRow.data.tryon_photo_path as string | null;
  if (!photoPath) {
    return Response.json({ error: "no_photo" }, { status: 412 });
  }

  // Quota pre-check. The consume_render RPC is the final authority and
  // will refuse to overdraw under any race, but the pre-check spares
  // us a multi-second OpenAI call we cannot bill for.
  const quota = await getRenderQuota(session.userId);
  if (quota.totalRemaining <= 0) {
    return Response.json(
      {
        error: "no_quota",
        included_remaining: quota.includedRemaining,
        pack_balance: quota.packBalance,
      },
      { status: 402 }
    );
  }

  // Fetch the person photo. Failures here are pre-upstream so the
  // user is not charged and we surface a clear error.
  let person: { buffer: Buffer; mime: string };
  try {
    person = await fetchPersonPhoto(photoPath);
  } catch (err) {
    console.error(
      "[render] person photo fetch failed:",
      err instanceof Error ? err.message : String(err)
    );
    return Response.json({ error: "render_failed" }, { status: 500 });
  }

  // Upstream gpt-image-1 call. On failure we never consume a credit
  // and never log a row; the user sees a generic error and can retry
  // at no cost to them.
  let pngBuffer: Buffer;
  try {
    pngBuffer = await runRender({
      personBuffer: person.buffer,
      personMime: person.mime,
      itemImageUrls: imageUrls,
    });
  } catch (err) {
    // err.cause carries the underlying system error when Node's
    // undici wraps a fetch failure. Surfacing both turns an opaque
    // "fetch failed" into something we can actually act on
    // (AbortError = timeout, ECONNRESET = upstream closed, ETIMEDOUT
    // = TCP-level timeout, etc.).
    const e = err as { message?: string; cause?: unknown; name?: string };
    const causeStr =
      e.cause instanceof Error
        ? `${e.cause.name ?? "Error"}: ${e.cause.message}`
        : e.cause
        ? String(e.cause)
        : "(no cause)";
    console.error(
      `[render] gpt-image-1 call failed: ${e.message ?? String(err)} | cause=${causeStr}`
    );
    return Response.json({ error: "render_failed" }, { status: 500 });
  }

  // Upload + sign before consuming the credit. If the upload fails we
  // still have not charged the user (the OpenAI call already cost
  // money but that is sunk; consuming a credit on top of that would
  // double-punish them for our infrastructure failing).
  let stored: { path: string; signedUrl: string };
  try {
    stored = await uploadRender({
      userId: session.userId,
      pngBuffer,
    });
  } catch (err) {
    console.error(
      "[render] upload failed:",
      err instanceof Error ? err.message : String(err)
    );
    return Response.json({ error: "upload_failed" }, { status: 500 });
  }

  // Atomic credit decrement. After this returns we have a guaranteed
  // source ('included' | 'pack') if charged, or a leak we log if not.
  const consume = await consumeRender(session.userId);
  const source = consume.charged && consume.source ? consume.source : null;

  // Append-only log. Source defaults to 'included' on a leak so the
  // CHECK constraint accepts the row; the leak shows up as a row
  // logged with no matching charged=true credit consumption from the
  // user's running totals.
  await logRender({
    userId: session.userId,
    creatorSlug: creatorSlug || null,
    kind,
    itemCount: imageUrls.length,
    source: source ?? "included",
    imagePath: stored.path,
  });

  if (!consume.charged) {
    console.warn(
      `[render] LEAK user=${session.userId} kind=${kind} path=${stored.path} — render produced after quota race; credit not charged`
    );
  }

  return Response.json({
    ok: true,
    signed_url: stored.signedUrl,
    kind,
    source,
    included_remaining: consume.includedRemaining,
    pack_balance: consume.packBalance,
  });
}
