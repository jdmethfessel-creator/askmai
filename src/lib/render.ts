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
// Alignment handling. gpt-image-1 often shifts the model's head
// vertically (different framing / different stance). We classify the
// shift and respond, instead of always skipping:
//
//   ALIGNED        center within 8% of image max dim, size within
//                  15% area delta. Composite at input position.
//   TRANSLATE      moderate shift, sizes still similar (<=15% area
//                  delta). Composite the input head shifted by
//                  (outCx-inCx, outCy-inCy) so it lands at the
//                  output bbox center.
//   TRANSLATE+SCALE  shift AND sizes differ (15-40% area delta).
//                  Composite shifted AND scaled to match the
//                  output bbox size.
//   SKIP           sizes differ >40% area, OR linear scale would
//                  be outside [0.75, 1.33]. Pasting a scaled face
//                  beyond that risks an uncanny / warped result.
//                  Better to return the gpt-image-1 face than a
//                  visibly wrong one.
//
// The Face+Hair binary mask is Gaussian-blurred (sigma 8) before it
// becomes the alpha channel, so the composite has a soft neckline
// gradient instead of a hard seam.
//
// Cost: one additional HF SegFormer call on the output (~$0.001).
// Total per render now ~$0.065.

type HeadAlignment =
  | { kind: "aligned" }
  | { kind: "translate"; dx: number; dy: number }
  | { kind: "scale"; dx: number; dy: number; scale: number; inCx: number; inCy: number; outCx: number; outCy: number }
  | { kind: "skip"; reason: string };

// Linear-scale bounds beyond which we refuse to scale the input
// face/hair patch. Outside this band the user's face would warp
// visibly; we'd rather ship the gpt-image-1 face than an uncanny
// one. (areaDelta 0.40 ≈ linearScale 0.77 / 1.30 around 1.0.)
const SCALE_LINEAR_MIN = 0.75;
const SCALE_LINEAR_MAX = 1.33;

// When the centers are close AND sizes are within this area-delta,
// no shift is needed and we composite at the input position.
const ALIGNED_CENTER_PCT = 0.08;
const ALIGNED_AREA_DELTA = 0.15;

// When sizes differ more than this, translation alone leaves a
// visibly wrong-sized head; we engage the scale path.
const SCALE_TRIGGER_AREA_DELTA = 0.15;

// ---- Seam-blend tunables -------------------------------------------
//
// Standard deviation (pixels) of the Gaussian feather applied to the
// head mask before it becomes the composite alpha channel. Larger =
// softer fade across the seam, but the user's pixels also become
// translucent further from the head center (risk: "ghost" head).
// Bumped from the original inline 8 to 14 to widen the fade band at
// 1024x1536 (~84 px transition vs the prior ~48 px), softening the
// visible chest-line seam that surfaced after the alignment fix.
const HEAD_COMPOSITE_FEATHER_SIGMA = 14;

// SegFormer-B2's ATR-trained class set doesn't include a "Neck"
// label, so the Face+Hair mask cuts at the jawline. After the
// alignment fix, the visible seam is at the chin where user-face
// pixels meet AI-body neck/chest pixels with mismatched tone.
//
// Downward dilation extends the bottom edge of the head mask by N
// pixels per column so the boundary moves DOWN, ideally past the
// garment collar in the model's output. The pasted region then
// includes the user's actual neck pixels, so the tone transition
// happens above the garment line where it can hide. The feather
// blur runs AFTER the dilation, so the extended bottom edge is also
// softly faded.
//
// Trade-off: if the user's pose and the AI's pose put the neck at
// different angles or widths, the extended patch may misregister at
// its edges. Keep this modest. Tune if Try-On evidence shows the
// extension overshooting into the garment.
const HEAD_COMPOSITE_DOWNWARD_DILATION_PX = 30;

/**
 * Classifies the input/output head bbox relationship into one of
 * the four response modes above. Drives the composite branch.
 */
function classifyHeadAlignment(
  inBox: Bbox,
  outBox: Bbox,
  imageDimMax: number
): HeadAlignment {
  const inCx = inBox.x + inBox.w / 2;
  const inCy = inBox.y + inBox.h / 2;
  const outCx = outBox.x + outBox.w / 2;
  const outCy = outBox.y + outBox.h / 2;
  const centerShift = Math.hypot(inCx - outCx, inCy - outCy);
  const centerShiftPct = centerShift / imageDimMax;

  const inArea = Math.max(1, inBox.w * inBox.h);
  const outArea = Math.max(1, outBox.w * outBox.h);
  const areaDelta = Math.abs(inArea - outArea) / Math.max(inArea, outArea);
  const linearScale = Math.sqrt(outArea / inArea);

  if (linearScale < SCALE_LINEAR_MIN || linearScale > SCALE_LINEAR_MAX) {
    return {
      kind: "skip",
      reason: `linear scale ${linearScale.toFixed(2)} outside [${SCALE_LINEAR_MIN}, ${SCALE_LINEAR_MAX}]`,
    };
  }
  if (centerShiftPct <= ALIGNED_CENTER_PCT && areaDelta <= ALIGNED_AREA_DELTA) {
    return { kind: "aligned" };
  }
  if (areaDelta <= SCALE_TRIGGER_AREA_DELTA) {
    return { kind: "translate", dx: outCx - inCx, dy: outCy - inCy };
  }
  return {
    kind: "scale",
    dx: outCx - inCx,
    dy: outCy - inCy,
    scale: linearScale,
    inCx,
    inCy,
    outCx,
    outCy,
  };
}

/**
 * In-place downward dilation of a binary mask. For each column x,
 * finds the bottommost positive pixel and sets the N pixels directly
 * below it to 255 (clipped to canvas). Used to push the head mask
 * boundary down past the chin so the seam lands under the garment
 * collar instead of crossing open chest skin.
 *
 * Cost: O(W*H) single pass to locate per-column bottoms + O(W*N) to
 * fill. Cheap relative to a sharp/SegFormer call.
 *
 * Mutates the input buffer.
 */
function dilateMaskDown(
  mask: Buffer,
  width: number,
  height: number,
  dilatePx: number
): void {
  if (dilatePx <= 0) return;
  // Walk each column from the bottom up to find the lowest positive
  // row; remember it. Then write 255 into the dilatePx rows directly
  // below. Done as a single pass per column.
  for (let x = 0; x < width; x++) {
    let bottomY = -1;
    for (let y = height - 1; y >= 0; y--) {
      if (mask[y * width + x] > 127) {
        bottomY = y;
        break;
      }
    }
    if (bottomY < 0) continue;
    const fillEnd = Math.min(height - 1, bottomY + dilatePx);
    for (let y = bottomY + 1; y <= fillEnd; y++) {
      mask[y * width + x] = 255;
    }
  }
}

/**
 * Build the feathered alpha PNG used as the head-composite mask.
 *
 * Input: the raw 1-channel binary head mask from SegFormer (255 in
 * Face+Hair, 0 elsewhere).
 *
 * Pipeline:
 *   1. Copy the input mask (we mutate during dilation).
 *   2. Dilate the bottom edge downward by
 *      HEAD_COMPOSITE_DOWNWARD_DILATION_PX so the seam pushes past
 *      the chin into the user's neck/collar region.
 *   3. Gaussian-blur the dilated mask with sigma
 *      HEAD_COMPOSITE_FEATHER_SIGMA so the new bottom edge fades
 *      softly into the AI body instead of cutting sharply.
 *
 * Output: a PNG of an alpha-only image at the same dimensions where
 * the head region is fully opaque (alpha=255) and edges feather to
 * transparent.
 */
async function buildFeatheredHeadOverlay(args: {
  normalizedPerson: Buffer;
  headMaskRaw: Buffer;
  width: number;
  height: number;
  /**
   * Optional reposition. When present, every output pixel (ox, oy)
   * samples the source RGB + alpha at the inverse-mapped input
   * coordinate. The inverse maps the output bbox center back to the
   * input bbox center, applying the inverse scale around the input
   * center. Omitting `transform` (or passing identity) keeps the
   * original at-input-position composite for the ALIGNED path.
   */
  transform?: {
    inCx: number;
    inCy: number;
    outCx: number;
    outCy: number;
    /** Linear scale; 1 = translation only. */
    scale: number;
  };
}): Promise<Buffer> {
  const W = args.width;
  const H = args.height;
  const expected1ch = W * H;
  const expected3ch = W * H * 3;

  // Assertion 1: the head mask handed to us must already be a true
  // 1-channel buffer (W*H bytes). segmentForRender now enforces this,
  // but we double-check here so a regression in either lib surfaces
  // as a clear error instead of rainbow scanlines in the output.
  if (args.headMaskRaw.length !== expected1ch) {
    throw new Error(
      `buildFeatheredHeadOverlay: headMaskRaw wrong size: ${args.headMaskRaw.length} vs expected ${expected1ch} (${W}x${H} 1ch)`
    );
  }

  // Copy first so we don't mutate the caller's buffer when we apply
  // the downward dilation. The dilation extends the bottom edge of
  // the head mask past the chin into the user's neck/collar region,
  // so the post-blur seam lands somewhere the garment can hide it
  // rather than crossing open chest skin.
  const dilated = Buffer.from(args.headMaskRaw);
  dilateMaskDown(dilated, W, H, HEAD_COMPOSITE_DOWNWARD_DILATION_PX);

  // Feather the (now downward-dilated) mask. Sigma is tunable via
  // HEAD_COMPOSITE_FEATHER_SIGMA so the blend band can be widened
  // without a code dive. .extractChannel(0) forces the raw output to
  // a single channel — without it sharp's blur emits 3 identical
  // channels (W*H*3 bytes) and the downstream byte-write loop reads
  // at the wrong stride.
  const featheredAlpha = await sharp(dilated, {
    raw: { width: W, height: H, channels: 1 },
  })
    .blur(HEAD_COMPOSITE_FEATHER_SIGMA)
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
    .resize({ width: W, height: H, fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3 || rgb.length !== expected3ch) {
    throw new Error(
      `buildFeatheredHeadOverlay: person RGB wrong shape: ${rgb.length} channels=${info.channels} expected ${expected3ch}/3ch`
    );
  }

  const rgba = Buffer.alloc(expected1ch * 4);

  if (!args.transform) {
    // Fast path: identity transform. Pixel-aligned, no resampling.
    for (let i = 0; i < expected1ch; i++) {
      const b = i * 4;
      rgba[b] = rgb[i * 3];
      rgba[b + 1] = rgb[i * 3 + 1];
      rgba[b + 2] = rgb[i * 3 + 2];
      rgba[b + 3] = featheredAlpha[i];
    }
  } else {
    // Reposition path. For each output pixel (ox, oy), the source
    // input pixel is:
    //
    //   px = inCx + (ox - outCx) / scale
    //   py = inCy + (oy - outCy) / scale
    //
    // (i.e. inverse of "anchor the input center at the output center
    // and scale around it"). Nearest-neighbor sampling is fine here
    // because the head region is large and the alpha is feathered;
    // bilinear would marginally smooth a hair edge but doubles the
    // per-pixel cost.
    const { inCx, inCy, outCx, outCy, scale } = args.transform;
    const invScale = 1 / scale;
    for (let oy = 0; oy < H; oy++) {
      for (let ox = 0; ox < W; ox++) {
        const px = Math.round(inCx + (ox - outCx) * invScale);
        const py = Math.round(inCy + (oy - outCy) * invScale);
        const b = (oy * W + ox) * 4;
        if (px < 0 || px >= W || py < 0 || py >= H) {
          // Source pixel out of frame; leave fully transparent
          // (alpha default 0 from Buffer.alloc).
          continue;
        }
        const srcIdx = py * W + px;
        rgba[b] = rgb[srcIdx * 3];
        rgba[b + 1] = rgb[srcIdx * 3 + 1];
        rgba[b + 2] = rgb[srcIdx * 3 + 2];
        rgba[b + 3] = featheredAlpha[srcIdx];
      }
    }
  }

  return sharp(rgba, {
    raw: { width: W, height: H, channels: 4 },
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
  //    the face even with a mask. Re-run SegFormer on the output,
  //    classify how the model moved the head, and respond:
  //    ALIGNED → composite at input position. TRANSLATE → composite
  //    shifted to the output bbox center. TRANSLATE+SCALE → composite
  //    shifted AND scaled. SKIP → return the gpt-image-1 face
  //    (uncanny paste would be worse than a slightly different face).
  //    See classifyHeadAlignment above for thresholds.
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
      const align = classifyHeadAlignment(inputBbox, outputBbox, imageDimMax);
      const inCx = inputBbox.x + inputBbox.w / 2;
      const inCy = inputBbox.y + inputBbox.h / 2;
      const outCx = outputBbox.x + outputBbox.w / 2;
      const outCy = outputBbox.y + outputBbox.h / 2;

      if (align.kind === "skip") {
        console.warn(
          `[render] head composite SKIPPED: ${align.reason} (in center=${inCx.toFixed(0)},${inCy.toFixed(0)} size=${inputBbox.w}x${inputBbox.h} ; out center=${outCx.toFixed(0)},${outCy.toFixed(0)} size=${outputBbox.w}x${outputBbox.h})`
        );
      } else {
        // OpenAI returns 1024x1536, same as our normalized input
        // dimensions. Feathered overlay = input photo RGB + Face+Hair
        // mask blurred into alpha. When the head moved, we pass a
        // transform so the overlay's sampling maps the input bbox
        // center to the output bbox center (and scales when needed).
        const transform =
          align.kind === "aligned"
            ? undefined
            : align.kind === "translate"
            ? { inCx, inCy, outCx, outCy, scale: 1 }
            : {
                inCx: align.inCx,
                inCy: align.inCy,
                outCx: align.outCx,
                outCy: align.outCy,
                scale: align.scale,
              };
        const overlay = await buildFeatheredHeadOverlay({
          normalizedPerson,
          headMaskRaw: seg.headMaskRaw,
          width: seg.width,
          height: seg.height,
          transform,
        });
        composited = await sharp(raw)
          .composite([{ input: overlay, top: 0, left: 0, blend: "over" }])
          .png()
          .toBuffer();
        const where =
          align.kind === "aligned"
            ? "at input position"
            : align.kind === "translate"
            ? `translated dx=${(outCx - inCx).toFixed(0)} dy=${(outCy - inCy).toFixed(0)}`
            : `translated dx=${(outCx - inCx).toFixed(0)} dy=${(outCy - inCy).toFixed(0)} scale=${align.scale.toFixed(2)}`;
        console.log(
          `[render] head composite APPLIED (${align.kind}): face/hair restored from input ${where}`
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
