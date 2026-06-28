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
import { probeHeadBbox, segmentForRender, type Bbox } from "./segmentClothing";
import { removeProductBackground } from "./removeBackground";

export const INCLUDED_RENDERS_PER_MONTH = 3;

// Cost basis at the time of render. ONE-OFF QUALITY EXPERIMENT:
// currently set to the high-tier price ($0.25 at 1024x1536) while
// OPENAI_QUALITY is "high" below. REVERT TO 0.063 when flipping
// back to medium so the renders log stops over-stating spend.
const COST_USD_PER_RENDER = 0.25;

const OPENAI_MODEL = "gpt-image-1";
// Portrait so a full-body try-on returns head-to-feet. We do NOT
// crop or letterbox the result in post-processing — whatever the
// model returns is what we ship (with a thin top/bottom branding
// overlay).
const OPENAI_SIZE = "1024x1536";
// ONE-OFF QUALITY EXPERIMENT: temporarily "high" for a single
// medium-vs-high comparison render. REVERT TO "medium" immediately
// after the test render is fired — every subsequent render will
// otherwise be billed at ~4x the cost ($0.25 vs $0.063 at 1024x1536).
const OPENAI_QUALITY = "high";
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
const RENDER_PROMPT =
  "A photorealistic image of the person from the first image, wearing the clothing shown in the reference image(s). Match the references' color, pattern, fabric, and cut as closely as possible. Natural fit and draping. The image stays non-sexual and the person stays fully clothed.";

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

// -------- Post-hoc head composite -------------------------------------
//
// gpt-image-1 treats the mask as guidance, not as a strict
// preservation boundary (per OpenAI's own guide: "Masking with GPT
// Image is entirely prompt-based. The model uses the mask as
// guidance, but may not follow its exact shape with complete
// precision."). The face — the highest-attention region in any
// portrait — therefore gets regenerated more often than not, even
// when the OpenAI mask marks it opaque.
//
// Fix: after the OpenAI call returns, we paint the user's ACTUAL
// head pixels (from their normalized input photo) back over the
// model's output, using a feathered Face+Hair mask as the alpha.
// The model's contribution stays everywhere below the chin (clothing
// swap, neckline draping, hands, the rest of the body); the head
// region is hard-restored to bit-exact identity.
//
// Two safety rails:
//
//   - The SegFormer Face+Hair bbox is computed on BOTH the input
//     normalized photo and the OpenAI output. If they differ in
//     center position (>8% of the image's larger dimension) or
//     significantly in size (>30% area change), the model
//     recomposed the body and pasting the head would land in the
//     wrong spot. We fall back: return the OpenAI output without
//     the composite, with a warning logged.
//
//   - The Face+Hair binary mask is Gaussian-blurred (sigma 8) before
//     it becomes the alpha channel, so the composite has a soft
//     neckline gradient instead of a hard seam.
//
// Cost: one additional HF SegFormer call on the output (~$0.001).
// Total per render now ~$0.065.

/**
 * Bbox-alignment check between input head and output head. Returns
 * true when the two bboxes are close enough that pasting the input
 * head over the output will land correctly.
 */
function headBboxesAligned(
  inBox: Bbox,
  outBox: Bbox,
  imageDimMax: number
): boolean {
  const inCx = inBox.x + inBox.w / 2;
  const inCy = inBox.y + inBox.h / 2;
  const outCx = outBox.x + outBox.w / 2;
  const outCy = outBox.y + outBox.h / 2;
  const centerShift = Math.hypot(inCx - outCx, inCy - outCy);
  const centerShiftPct = centerShift / imageDimMax;

  const inArea = Math.max(1, inBox.w * inBox.h);
  const outArea = Math.max(1, outBox.w * outBox.h);
  const areaRatio = Math.abs(inArea - outArea) / inArea;

  return centerShiftPct <= 0.08 && areaRatio <= 0.3;
}

/**
 * Build the feathered alpha PNG used as the head-composite mask.
 *
 * Input: the raw 1-channel binary head mask from SegFormer (255 in
 * Face+Hair, 0 elsewhere).
 *
 * Output: a PNG of an alpha-only image at the same dimensions where
 * the Face+Hair region is fully opaque (alpha=255) and edges feather
 * to transparent over a few pixels. Sharp's Gaussian blur on the
 * raw 1-channel buffer is the cheap way to achieve the feather.
 */
async function buildFeatheredHeadOverlay(args: {
  normalizedPerson: Buffer;
  headMaskRaw: Buffer;
  width: number;
  height: number;
}): Promise<Buffer> {
  const expected1ch = args.width * args.height;
  const expected3ch = args.width * args.height * 3;

  // Assertion 1: the head mask handed to us must already be a true
  // 1-channel buffer (W*H bytes). segmentForRender now enforces this,
  // but we double-check here so a regression in either lib surfaces
  // as a clear error instead of rainbow scanlines in the output.
  if (args.headMaskRaw.length !== expected1ch) {
    throw new Error(
      `buildFeatheredHeadOverlay: headMaskRaw wrong size: ${args.headMaskRaw.length} vs expected ${expected1ch} (${args.width}x${args.height} 1ch)`
    );
  }

  // Feather the binary mask. Sigma chosen to span ~8 pixels across the
  // boundary, producing a soft neckline gradient at 1024x1536 without
  // bleeding too far into the clothing area. .extractChannel(0) forces
  // the raw output to a single channel — without it sharp's blur emits
  // 3 identical channels (W*H*3 bytes) and the downstream byte-write
  // loop reads at the wrong stride.
  const featheredAlpha = await sharp(args.headMaskRaw, {
    raw: { width: args.width, height: args.height, channels: 1 },
  })
    .blur(8)
    .extractChannel(0)
    .raw()
    .toBuffer();
  if (featheredAlpha.length !== expected1ch) {
    throw new Error(
      `buildFeatheredHeadOverlay: feathered alpha wrong size: ${featheredAlpha.length} vs expected ${expected1ch}`
    );
  }

  // Extract the input photo's RGB channels at the same dimensions so
  // we can join the feathered alpha onto them.
  const { data: rgb, info } = await sharp(args.normalizedPerson)
    .resize({ width: args.width, height: args.height, fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3 || rgb.length !== expected3ch) {
    throw new Error(
      `buildFeatheredHeadOverlay: person RGB wrong shape: ${rgb.length} channels=${info.channels} expected ${expected3ch}/3ch`
    );
  }

  const rgba = Buffer.alloc(expected1ch * 4);
  for (let i = 0; i < expected1ch; i++) {
    const b = i * 4;
    rgba[b] = rgb[i * 3];
    rgba[b + 1] = rgb[i * 3 + 1];
    rgba[b + 2] = rgb[i * 3 + 2];
    rgba[b + 3] = featheredAlpha[i];
  }
  return sharp(rgba, {
    raw: { width: args.width, height: args.height, channels: 4 },
  })
    .png()
    .toBuffer();
}

/**
 * Inpaint render via gpt-image-1 /v1/images/edits, with a post-hoc
 * head composite restoring the user's real face.
 *
 * Flow (every step that throws becomes 500 render_failed with NO
 * credit consumed):
 *
 *   1. Normalize the user photo to 1024x1536, fit:"contain", neutral
 *      pad — head-to-feet preservation is baked in here.
 *   2. SegFormer on the normalized photo → editable clothing mask
 *      (for OpenAI) + head mask + input head bbox.
 *   3. Fetch product reference images.
 *   4. Call /v1/images/edits with image[normalized_user, ...products]
 *      + mask + size=1024x1536. Mask applies only to image[0].
 *   5. SegFormer on the OpenAI output → output head bbox.
 *   6. Alignment check between input/output head bboxes.
 *        - aligned: feather the input head mask, composite the user's
 *          actual head pixels onto the OpenAI output.
 *        - misaligned or no output head detected: skip the composite,
 *          log a warning, and return the OpenAI output as-is. The
 *          render still succeeds (it has a valid garment swap); the
 *          face just isn't identity-preserved on this one.
 *   7. Apply branding overlay.
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

  // 5. Post-hoc head composite. gpt-image-1 won't strictly preserve
  //    the face even with a mask, so we re-run SegFormer on the
  //    output, check that the head bbox is close enough to the input
  //    bbox to safely paste, and (when aligned) composite the user's
  //    actual head pixels back onto the output with a feathered
  //    alpha. When the model has moved the head too far, we skip the
  //    composite rather than land a face in the wrong spot — the
  //    render still ships (no credit refund), just without identity
  //    preservation on this one.
  let composited: Buffer = raw;
  try {
    const outProbe = await probeHeadBbox(raw);
    const inputBbox = seg.headBbox;
    const outputBbox = outProbe.headBbox;
    if (!inputBbox || !outputBbox) {
      console.warn(
        `[render] head composite SKIPPED: input.headBbox=${inputBbox ? "ok" : "none"} output.headBbox=${outputBbox ? "ok" : "none"}`
      );
    } else {
      const imageDimMax = Math.max(outProbe.width, outProbe.height);
      const aligned = headBboxesAligned(inputBbox, outputBbox, imageDimMax);
      if (!aligned) {
        const inCx = inputBbox.x + inputBbox.w / 2;
        const inCy = inputBbox.y + inputBbox.h / 2;
        const outCx = outputBbox.x + outputBbox.w / 2;
        const outCy = outputBbox.y + outputBbox.h / 2;
        console.warn(
          `[render] head composite SKIPPED: misaligned (in center=${inCx.toFixed(0)},${inCy.toFixed(0)} out center=${outCx.toFixed(0)},${outCy.toFixed(0)})`
        );
      } else {
        // OpenAI returns 1024x1536, same as our normalized input
        // dimensions. Feathered overlay = input photo RGB + Face+Hair
        // mask blurred into the alpha channel. Composite over raw.
        const overlay = await buildFeatheredHeadOverlay({
          normalizedPerson,
          headMaskRaw: seg.headMaskRaw,
          width: seg.width,
          height: seg.height,
        });
        composited = await sharp(raw)
          .composite([{ input: overlay, top: 0, left: 0, blend: "over" }])
          .png()
          .toBuffer();
        console.log(
          "[render] head composite APPLIED: face/hair restored from input"
        );
      }
    }
  } catch (err) {
    // Output-side SegFormer probe or composite step failed. Don't
    // fail the whole render — the OpenAI result is valid; we just
    // lose identity preservation on this one. The credit will still
    // be consumed because the user has a usable image.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[render] head composite SKIPPED (error): ${msg}`);
  }

  // 6. Brand overlay.
  return applyBranding(composited);
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
