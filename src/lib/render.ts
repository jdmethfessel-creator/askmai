/**
 * Try-on render pipeline (Phase 2).
 *
 * One function per concern, kept boring and testable:
 *
 *   getRenderQuota(userId)
 *     Read-only quota view backed by the get_render_quota RPC.
 *     The included pool lazy-resets inside the RPC so a client read
 *     of a stale row reports correctly.
 *
 *   consumeRender(userId)
 *     Atomic decrement after a successful upstream render. The
 *     consume_render RPC is the source of truth for "included first,
 *     then pack, then deny" and is the only thing that ever touches
 *     the user's render counters.
 *
 *   logRender({...})
 *     Append-only audit log into public.renders. Cost basis is
 *     stamped per row so a future price change doesn't rewrite
 *     historical spend.
 *
 *   runRender({ personBuffer, personMime, itemImageUrls })
 *     Calls gpt-image-1 /v1/images/edits with the user's uploaded
 *     photo plus 1..N reference garment image URLs (downloaded
 *     server-side first), composites the top wordmark + bottom URL
 *     branding overlay, returns a PNG buffer ready for upload.
 *     The OPENAI_API_KEY is read here and only here in the lib
 *     layer; the client never sees it.
 *
 *   uploadRender({ userId, pngBuffer })
 *     Stores the rendered PNG into the private `renders` bucket
 *     under `{userId}/{uuid}.png` and signs a short-lived URL.
 *
 * The route handler in /api/render orchestrates these in order:
 * gates -> quota -> runRender -> consumeRender -> uploadRender -> log.
 * If consumeRender returns charged=false (rare race after the quota
 * read), we still return the image because the money is already
 * spent, and log a leak so it shows up in spend reconciliation.
 */

import path from "path";
import sharp from "sharp";
import { supabaseAdmin } from "./supabase";
import { segmentForRender } from "./segmentClothing";
import { removeProductBackground } from "./removeBackground";
import { faceSwap } from "./faceSwap";

export const INCLUDED_RENDERS_PER_MONTH = 3;

// Cost basis at the time of render. Verified 2026-06-27 from the
// OpenAI pricing page for gpt-image-1 medium@1024x1536 (portrait).
// Stamped onto every renders row so a future provider price change
// does not silently rewrite historical spend totals.
const COST_USD_PER_RENDER = 0.063;

const OPENAI_MODEL = "gpt-image-1";
// Portrait so a full-body try-on returns head-to-feet. We do NOT
// crop or letterbox the result in post-processing — whatever the
// model returns is what we ship (with a thin top/bottom branding
// overlay).
const OPENAI_SIZE = "1024x1536";
// Medium quality is a ~4x cost reduction over high ($0.063 vs $0.25
// at 1024x1536). A/B'd 2026-06-27 against the same item + prompt —
// high reads marginally crisper but not 4x crisper. Medium stays
// the default. May revisit high for detail-heavy categories
// (lace, sequins, fine print) as a per-render override later.
const OPENAI_QUALITY = "medium";
const OPENAI_IMAGES_EDITS_URL = "https://api.openai.com/v1/images/edits";
const RENDER_SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7;

const RENDER_BUCKET = "renders";

// Pre-rendered share-card overlay. A single 1024x1536 RGBA PNG with
// top + bottom gradient scrims, the Fraunces "AskMai" wordmark, and
// the DM Sans "www.askmai.co" URL all baked in. Generated once at
// dev time via scripts/generate-share-overlay.mjs (uses
// @napi-rs/canvas + @fontsource/fraunces + @fontsource/dm-sans, all
// devDependencies — never bundled into the runtime). The runtime
// only composites this PNG over the rendered image; no text
// rendering, no fontconfig, no system-font dependency.
//
// Because every string ("AskMai", "www.askmai.co") is baked into
// the raster, there is no runtime substitution path — no foreign
// string can leak into the overlay.
//
// The overlay is FIXED at 1024x1536. applyBranding asserts the
// input image matches, so OPENAI_SIZE and overlay dimensions can
// never silently diverge.
const OVERLAY_PNG_PATH = path.join(
  process.cwd(),
  "src/lib/render-assets/askmai-share-overlay-1024x1536.png"
);
const OVERLAY_WIDTH = 1024;
const OVERLAY_HEIGHT = 1536;

/**
 * Single fixed prompt for the gpt-image-1 /images/edits call. Locked
 * verbatim by product spec — both "Show This Item" (1 product image
 * in addition to the user photo) and "Try This Outfit" (N product
 * images in addition to the user photo) use this exact string. The
 * input image[] array carries the count distinction; the prompt does
 * not branch on kind.
 */
// Single fixed prompt for the inpaint /images/edits call. The mask
// is the load-bearing constraint (transparent over clothing only;
// face, hair, hands, feet, background opaque), so the prompt only
// describes the desired clothing — not the preservation rules,
// which the mask now enforces physically.
// The first image is the user pre-normalized by
// src/lib/normalizeTryonPhoto.ts: an isolated figure on a mid-gray
// canvas, with the original-clothing region (torso/legs) replaced by
// a flat neutral gray placeholder (Option A from the seam-bleed fix).
// The placeholder reads to the model as "clothing-shaped void to fill"
// rather than existing garment to overlay. The prompt explicitly
// reinforces this so the model doesn't try to preserve the placeholder
// color in the output.
const RENDER_PROMPT =
  "A photorealistic image of the person from the first image, wearing the clothing shown in the reference image(s). The person's torso and legs region in the first image is filled with a flat neutral gray placeholder; replace this region entirely with the new garment, do not preserve the placeholder color, do not blend with it. Match the reference garment's color, pattern, fabric, and cut as closely as possible. Natural fit and draping. The image stays non-sexual and the person stays fully clothed.";

/**
 * Read the user's current quota. Calls the get_render_quota RPC which
 * lazy-resets the included counter when the monthly window has
 * elapsed. Returns zeros if the row is missing rather than throwing,
 * because the consume RPC is the final word — the client UI uses this
 * only to choose the button label.
 */
export type RenderQuota = {
  includedRemaining: number;
  packBalance: number;
  totalRemaining: number;
};

export async function getRenderQuota(userId: string): Promise<RenderQuota> {
  const sb = supabaseAdmin();
  const { data, error } = await sb.rpc("get_render_quota", {
    p_user_id: userId,
    p_included_limit: INCLUDED_RENDERS_PER_MONTH,
  });
  if (error) {
    console.error("[render] get_render_quota failed:", error.message);
    return { includedRemaining: 0, packBalance: 0, totalRemaining: 0 };
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { includedRemaining: 0, packBalance: 0, totalRemaining: 0 };
  return {
    includedRemaining: Number(row.included_remaining ?? 0),
    packBalance: Number(row.pack_balance ?? 0),
    totalRemaining: Number(row.total_remaining ?? 0),
  };
}

/**
 * Atomic consume: included first, then pack, then deny. Returns the
 * source the credit was drawn from (so it can be logged) and the
 * post-decrement remainders. charged=false means there was no credit
 * available; in the normal flow we only call this AFTER a successful
 * upstream render, so a false here is a leak we record but do not
 * surface as an error to the user.
 */
export type ConsumeResult = {
  charged: boolean;
  source: "included" | "pack" | null;
  includedRemaining: number;
  packBalance: number;
};

export async function consumeRender(userId: string): Promise<ConsumeResult> {
  const sb = supabaseAdmin();
  const { data, error } = await sb.rpc("consume_render", {
    p_user_id: userId,
    p_included_limit: INCLUDED_RENDERS_PER_MONTH,
  });
  if (error) {
    console.error("[render] consume_render failed:", error.message);
    return {
      charged: false,
      source: null,
      includedRemaining: 0,
      packBalance: 0,
    };
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    return {
      charged: false,
      source: null,
      includedRemaining: 0,
      packBalance: 0,
    };
  }
  const src = row.source as string | null;
  return {
    charged: Boolean(row.charged),
    source: src === "included" || src === "pack" ? src : null,
    includedRemaining: Number(row.included_remaining ?? 0),
    packBalance: Number(row.pack_balance ?? 0),
  };
}

/**
 * Append-only audit log. Fire-and-forget from the route after a
 * successful render — failures here are logged but never block the
 * response since the image is already produced and uploaded.
 */
export async function logRender(args: {
  userId: string;
  creatorSlug: string | null;
  kind: "single" | "outfit";
  itemCount: number;
  source: "included" | "pack";
  imagePath: string | null;
}): Promise<void> {
  const sb = supabaseAdmin();
  const { error } = await sb.from("renders").insert({
    user_id: args.userId,
    creator_slug: args.creatorSlug,
    kind: args.kind,
    item_count: args.itemCount,
    source: args.source,
    cost_usd: COST_USD_PER_RENDER,
    image_path: args.imagePath,
  });
  if (error) {
    console.error("[render] log insert failed:", error.message);
  }
}

/**
 * Fetch a remote item image and return it as a Blob suitable for the
 * gpt-image-1 multipart request. Falls back to image/jpeg when the
 * upstream content-type is missing or bare-extension. Throws on a
 * non-OK upstream so the caller can surface a clear error before
 * spending OpenAI credits on a half-prepared request.
 */
async function fetchItemBlob(
  url: string,
  index: number
): Promise<{ blob: Blob; filename: string }> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    throw new Error(`item image fetch ${index} failed: ${resp.status}`);
  }
  const ct = (resp.headers.get("content-type") ?? "").toLowerCase();
  let mime = "image/jpeg";
  let ext = "jpg";
  if (ct.includes("png")) {
    mime = "image/png";
    ext = "png";
  } else if (ct.includes("webp")) {
    mime = "image/webp";
    ext = "webp";
  }
  const ab = await resp.arrayBuffer();
  return {
    blob: new Blob([new Uint8Array(ab)], { type: mime }),
    filename: `item-${index}.${ext}`,
  };
}

/**
 * Lazy-cached pre-rendered share-card overlay. The buffer lives in
 * memory for the lifetime of the lambda after the first render, so
 * subsequent renders pay zero disk I/O. fs.readFile resolves the
 * path Next.js' file tracer pinned via outputFileTracingIncludes.
 */
let cachedOverlay: Buffer | null = null;

async function getOverlay(): Promise<Buffer> {
  if (cachedOverlay) return cachedOverlay;
  const fs = await import("fs/promises");
  cachedOverlay = await fs.readFile(OVERLAY_PNG_PATH);
  return cachedOverlay;
}

/**
 * Composite the pre-baked share-card overlay onto the rendered
 * image. The overlay is a 1024x1536 RGBA PNG containing both
 * gradient edge scrims and the typography (Fraunces "AskMai"
 * wordmark + DM Sans "www.askmai.co" URL), generated once at dev
 * time via scripts/generate-share-overlay.mjs.
 *
 * Runtime work is a single composite call — no text rendering, no
 * scrim drawing, no font dependency. The overlay's alpha channel
 * carries the gradient scrim AND the white text together, so a
 * single sharp.composite() drops it onto the photo in one pass.
 *
 * Guard: the overlay is FIXED at 1024x1536. We assert the input
 * matches before compositing — if OPENAI_SIZE ever changes without
 * regenerating the overlay (or the model returns an unexpected
 * size), we fail closed with a clear error instead of silently
 * letterboxing or stretching the brand.
 */
async function applyBranding(pngBuffer: Buffer): Promise<Buffer> {
  const meta = await sharp(pngBuffer).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width !== OVERLAY_WIDTH || height !== OVERLAY_HEIGHT) {
    throw new Error(
      `applyBranding: input image ${width}x${height} does not match overlay ${OVERLAY_WIDTH}x${OVERLAY_HEIGHT}. Regenerate the overlay via scripts/generate-share-overlay.mjs at the new dimensions, or check OPENAI_SIZE.`
    );
  }
  const overlay = await getOverlay();
  return sharp(pngBuffer)
    .composite([{ input: overlay, top: 0, left: 0 }])
    .png()
    .toBuffer();
}

// -------- Face rendering --------------------------------------------
//
// Two-step face handling:
//
// 1. gpt-image-1 renders the entire person from the normalized photo,
//    including the head and hair. This produces a coherent image with
//    correct lighting on the face / hair / garment seam.
//
// 2. After the render returns, we run a production face swap
//    (InsightFace inswapper via Replicate, see src/lib/faceSwap.ts)
//    to overlay the user's actual facial identity. The swap is an
//    InsightFace-grade pipeline: 5-point landmark detection on both
//    images, affine alignment for pose/angle/scale/rotation, color
//    and lighting transfer, soft feathered boundary inside the
//    hairline / jaw. Hair, neckline, shoulders, and garment from the
//    gpt-image-1 output are preserved untouched.
//
// History: we previously ran a hand-rolled paste-back (alignment
// classifier + seam-feather + downward-dilation) which produced a
// visible melt at the hair/neck seam because it composited two
// differently-lit images. That was removed in commit ce3ad29. The
// inswapper pipeline replaces it: instead of pasting pixels, it
// warps and color-matches an embedding into the target's lighting,
// which is the right architectural shape for what we want.
//
// If REPLICATE_API_TOKEN is missing or the swap fails for any
// reason (no face detected, moderation, timeout, network), we fall
// back to the un-swapped gpt-image-1 output. The render still
// ships; the user just gets the "approximately you" face from the
// model instead of the "exactly you" face from the swap. This means
// the deploy is safe before the token is wired into Vercel env.

/**
 * Inpaint render via gpt-image-1 /v1/images/edits. The model renders
 * the entire person, including the head, from the normalized input
 * photo (which serves as the primary identity reference). No
 * post-hoc face composite -- see "Face rendering" comment above for
 * why it was removed.
 *
 * Flow (every step that throws becomes 500 render_failed with NO
 * credit consumed):
 *
 *   1. The user photo is already normalized at upload time
 *      (src/lib/normalizeTryonPhoto.ts) to 1024x1536 on a mid-gray
 *      canvas with the original garment region neutralized. The
 *      personBuffer arg IS that normalized PNG; we pass it through.
 *   2. SegFormer on the normalized photo to build the editable
 *      clothing mask (transparent over garment, opaque elsewhere)
 *      that gpt-image-1's inpaint takes as the `mask` field.
 *   3. Fetch product reference images.
 *   4. Call /v1/images/edits with image[normalized_user, ...products]
 *      + mask + size=1024x1536. Mask applies only to image[0]. The
 *      model renders one coherent image including the face.
 *   5. Apply branding overlay and return.
 */
export async function runRender(args: {
  personBuffer: Buffer;
  personMime: string;
  itemImageUrls: string[];
}): Promise<Buffer> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not set");
  }
  if (args.itemImageUrls.length === 0) {
    throw new Error("no item images provided");
  }

  // 1. Normalize the user photo to 1024x1536. fit:"contain" pads with
  //    a neutral light-gray background so the actual person content is
  //    NEVER cropped — head-to-feet preservation is baked in here, not
  //    handled by the model. The pad area lands outside any segmented
  //    clothing class, so the mask renders it as preserved (opaque)
  //    and the model cannot repaint it.
  const normalizedPerson = await sharp(args.personBuffer)
    .resize({
      width: 1024,
      height: 1536,
      fit: "contain",
      background: { r: 245, g: 245, b: 245, alpha: 1 },
    })
    .png()
    .toBuffer();

  // 2. Generate the clothing mask + head mask + input head bbox.
  //    segmentForRender throws when HF_API_TOKEN is missing, when the
  //    model returns no clothing classes, or when coverage falls
  //    outside the sanity band — all of which become render_failed
  //    upstream with no credit consumed.
  const seg = await segmentForRender(normalizedPerson);
  console.log(
    `[render] input mask coverage=${seg.editableCoveragePct.toFixed(1)}% clothing=${seg.editableClassesUsed.join(",")} headBbox=${seg.headBbox ? `${seg.headBbox.x},${seg.headBbox.y},${seg.headBbox.w}x${seg.headBbox.h}` : "none"}`
  );

  // 3. Fetch product reference images.
  const itemFetches = await Promise.all(
    args.itemImageUrls.map((u, i) => fetchItemBlob(u, i))
  );

  // 3a. Strip the background from each product reference. gpt-image-1
  //     in multi-image edit mode treats references as compositional
  //     cues, so a product photo with environmental context (a
  //     co-model, a setting) leaks that context into the output
  //     (the canonical "suit guy appears next to the user" failure).
  //     Cleaning the background to white isolates the model+garment
  //     and removes the scene-cue leak path. RMBG returns the
  //     original buffer on any failure — bg removal is best-effort,
  //     never a render-blocker.
  const cleanedItems = await Promise.all(
    itemFetches.map(async (item, i) => {
      const buf = Buffer.from(await item.blob.arrayBuffer());
      const cleaned = await removeProductBackground(buf, i);
      return {
        blob: new Blob([new Uint8Array(cleaned)], { type: "image/png" }),
        filename: `item-${i}.png`,
      };
    })
  );

  // 4. Build the multipart form. Person photo first (the mask target),
  //    then each product as a reference. Mask is a separate field per
  //    the OpenAI spec — not part of image[].
  const personBlob = new Blob([new Uint8Array(normalizedPerson)], {
    type: "image/png",
  });
  const maskBlob = new Blob([new Uint8Array(seg.editableMaskPng)], {
    type: "image/png",
  });
  const form = new FormData();
  form.append("model", OPENAI_MODEL);
  form.append("prompt", RENDER_PROMPT);
  form.append("size", OPENAI_SIZE);
  form.append("quality", OPENAI_QUALITY);
  form.append("n", "1");
  form.append("image[]", personBlob, "person.png");
  for (const item of cleanedItems) {
    form.append("image[]", item.blob, item.filename);
  }
  form.append("mask", maskBlob, "mask.png");

  // 250s timeout sits just under the route's maxDuration=300 so the
  // fetch's AbortSignal is the gate, not the Vercel runtime kill (the
  // latter surfaces as an opaque "fetch failed" with no actionable
  // detail).
  const resp = await fetch(OPENAI_IMAGES_EDITS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(250_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`gpt-image-1 ${resp.status}: ${text.slice(0, 400)}`);
  }
  const json = (await resp.json()) as {
    data?: Array<{ b64_json?: string }>;
  };
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("gpt-image-1 returned no image data");
  }
  const raw = Buffer.from(b64, "base64");

  // 5. Face swap. Replace the gpt-image-1 head's facial identity with
  //    the user's actual face using InsightFace inswapper (via
  //    Replicate). See "Face rendering" comment block above and
  //    src/lib/faceSwap.ts for the full architecture.
  //
  //    The source face is normalizedPerson (the upload-time-normalized
  //    photo: clean isolated figure, neutral background, garment
  //    region blanked). The target is `raw` (gpt-image-1's output).
  //    The swap result preserves everything in `raw` except the
  //    inner-face region (eyes, nose, mouth, chin) which is replaced
  //    with the user's identity, color-matched to the render's
  //    lighting.
  //
  //    Graceful fallback: any failure (missing token, no face
  //    detected, moderation, timeout, network) returns `raw`
  //    un-swapped. The user still gets a render; they just don't
  //    get their exact face. This is also what happens before the
  //    REPLICATE_API_TOKEN is added to Vercel env post-deploy.
  const swapResult = await faceSwap({
    sourceFaceBuffer: normalizedPerson,
    targetImageBuffer: raw,
  });
  let postSwap: Buffer;
  if (swapResult.ok) {
    console.log(
      `[render] face swap ok, latency=${swapResult.latencyMs}ms`
    );
    postSwap = swapResult.pngBuffer;
  } else {
    console.warn(
      `[render] face swap skipped reason=${swapResult.reason} detail=${swapResult.detail}`
    );
    postSwap = raw;
  }

  // 6. Brand overlay. The swap may return a non-1024x1536 image
  //    depending on the model's internal resampling; applyBranding
  //    asserts the size, so we normalize back to canvas dimensions
  //    first. resize(fit:"cover") preserves the aspect ratio with no
  //    letterbox; the swapped output is already 1024x1536-shaped
  //    (because the gpt-image-1 input was), so this is usually a
  //    no-op pass-through.
  const sized = await sharp(postSwap)
    .resize({
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
      fit: "cover",
    })
    .png()
    .toBuffer();
  return applyBranding(sized);
}

/**
 * Upload the finished PNG to the private renders bucket. Path layout
 * mirrors the tryon-photos bucket: `{userId}/{uuid}.png`. Returns the
 * storage path plus a short-lived signed URL the client can render.
 */
export async function uploadRender(args: {
  userId: string;
  pngBuffer: Buffer;
}): Promise<{ path: string; signedUrl: string }> {
  const sb = supabaseAdmin();
  const uuid = crypto.randomUUID();
  const path = `${args.userId}/${uuid}.png`;
  const up = await sb.storage
    .from(RENDER_BUCKET)
    .upload(path, args.pngBuffer, {
      contentType: "image/png",
      upsert: false,
    });
  if (up.error) {
    throw new Error(`render upload failed: ${up.error.message}`);
  }
  const signed = await sb.storage
    .from(RENDER_BUCKET)
    .createSignedUrl(path, RENDER_SIGNED_URL_TTL_SECONDS);
  if (signed.error || !signed.data?.signedUrl) {
    throw new Error(
      `render sign failed: ${signed.error?.message ?? "unknown"}`
    );
  }
  return { path, signedUrl: signed.data.signedUrl };
}

/**
 * Download the user's uploaded try-on photo from the private bucket.
 * Returns the raw bytes plus mime so runRender can pass them straight
 * into the OpenAI multipart body.
 */
export async function fetchPersonPhoto(
  tryonPhotoPath: string
): Promise<{ buffer: Buffer; mime: string }> {
  const sb = supabaseAdmin();
  const { data, error } = await sb.storage
    .from("tryon-photos")
    .download(tryonPhotoPath);
  if (error || !data) {
    throw new Error(
      `person photo download failed: ${error?.message ?? "no data"}`
    );
  }
  const buffer = Buffer.from(await data.arrayBuffer());
  const mime = data.type || "image/jpeg";
  return { buffer, mime };
}
