/**
 * Try-on render pipeline (Phase 3, VTON).
 *
 * The architecture in one sentence: the user's real photo IS the
 * canvas; we ask a virtual-try-on model (FASHN tryon-v1.6, falling
 * back to Replicate IDM-VTON) to warp the catalog garment onto that
 * canvas, then drop the branding overlay on top.
 *
 * What this replaces: a generate-then-swap pipeline built on
 * gpt-image-1 + SegFormer + face-swap. gpt-image-1 invented a face
 * and body; we then ran inswapper to put the user's face back. The
 * VTON approach skips that round-trip: identity, hair, body, pose,
 * and background are all preserved natively, because no generation
 * happens on the person.
 *
 * What runRender does now:
 *   1. fetchPersonPhoto   - download the user's uploaded photo
 *   2. tryOn               - one FASHN call per garment, chained for
 *                            outfits (each call takes the previous
 *                            output as the new model_image)
 *   3. upscale + brand     - sharp resize FASHN's 864x1296 PNG to the
 *                            1024x1536 share-card canvas; composite
 *                            the askmai overlay
 *
 * What the helpers do (unchanged from prior versions):
 *   getRenderQuota / consumeRender / logRender: atomic credit
 *     bookkeeping backed by Supabase RPCs.
 *   uploadRender: stores the finished PNG into the private renders
 *     bucket and signs a short-lived URL.
 *   fetchPersonPhoto: downloads the user's photo from the private
 *     tryon-photos bucket.
 *
 * The route handler in /api/render orchestrates these in order:
 * gates -> quota -> runRender -> consumeRender -> uploadRender -> log.
 * If runRender throws or returns a structured failure, the route
 * does NOT consume a credit; the user retries at no cost.
 */

import path from "path";
import sharp from "sharp";
import { supabaseAdmin } from "./supabase";
import { tryOn, type VtonCategory, type VtonResult } from "./vton";

export const INCLUDED_RENDERS_PER_MONTH = 3;

// Cost basis at the time of render. FASHN tryon-v1.6 in quality mode
// is ~$0.08 per generation at current pricing; updated 2026-06-28.
// Stamped onto every renders row so a future provider price change
// does not silently rewrite historical spend totals. The VTON
// provider's credit usage is also returned per-call in the result;
// this constant is just the bookkeeping basis.
const COST_USD_PER_RENDER = 0.08;

const RENDER_SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7;

const RENDER_BUCKET = "renders";

// Pre-rendered share-card overlay. A single 1024x1536 RGBA PNG with
// top + bottom gradient scrims, the Fraunces "AskMai" wordmark, and
// the DM Sans "www.askmai.co" URL all baked in. Generated once at
// dev time via scripts/generate-share-overlay.mjs.
//
// Because every string ("AskMai", "www.askmai.co") is baked into
// the raster, there is no runtime substitution path; no foreign
// string can leak into the overlay.
//
// The overlay is FIXED at 1024x1536. applyBranding asserts the
// input image matches; runRender upscales the VTON output to this
// size before compositing.
const OVERLAY_PNG_PATH = path.join(
  process.cwd(),
  "src/lib/render-assets/askmai-share-overlay-1024x1536.png"
);
const OVERLAY_WIDTH = 1024;
const OVERLAY_HEIGHT = 1536;

/**
 * Read the user's current quota. Calls the get_render_quota RPC which
 * lazy-resets the included counter when the monthly window has
 * elapsed. Returns zeros if the row is missing rather than throwing,
 * because the consume RPC is the final word; the client UI uses this
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
 * successful render; failures here are logged but never block the
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
 * Runtime work is a single composite call (no text rendering, no
 * scrim drawing, no font dependency). The overlay's alpha channel
 * carries the gradient scrim AND the white text together, so a
 * single sharp.composite() drops it onto the photo in one pass.
 *
 * Guard: the overlay is FIXED at 1024x1536. The caller must size
 * the input image to match before calling; this asserts and throws
 * on a mismatch so the brand never silently letterboxes or stretches.
 */
async function applyBranding(pngBuffer: Buffer): Promise<Buffer> {
  const meta = await sharp(pngBuffer).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width !== OVERLAY_WIDTH || height !== OVERLAY_HEIGHT) {
    throw new Error(
      `applyBranding: input image ${width}x${height} does not match overlay ${OVERLAY_WIDTH}x${OVERLAY_HEIGHT}. The VTON output should be resized to overlay dimensions before branding.`
    );
  }
  const overlay = await getOverlay();
  return sharp(pngBuffer)
    .composite([{ input: overlay, top: 0, left: 0 }])
    .png()
    .toBuffer();
}

// The branding overlay's gradient scrims (see
// scripts/generate-share-overlay.mjs) are 14% of canvas height each,
// at top and bottom. If we let the figure fill the canvas, the head
// and feet land inside those scrims and read as cropped to the
// viewer (literal pixel crop if the figure's aspect didn't match
// the canvas's, visual obscuring even when it did).
//
// Fix: place the figure inside a SAFE INNER AREA whose bounds match
// the scrim edges, with mid-gray padding outside. That guarantees
// the body is always fully visible head-to-feet, regardless of
// what aspect the VTON provider returns. Keep these constants in
// sync with the scrim ratios in generate-share-overlay.mjs.
const SCRIM_TOP_PX = Math.round(OVERLAY_HEIGHT * 0.14); // 215
const SCRIM_BOT_PX = Math.round(OVERLAY_HEIGHT * 0.14); // 215
const SAFE_INNER_WIDTH = OVERLAY_WIDTH; // 1024
const SAFE_INNER_HEIGHT = OVERLAY_HEIGHT - SCRIM_TOP_PX - SCRIM_BOT_PX; // 1106
// Mid-gray pad color. Matches the wordmark scrim's perceived tone
// at its mid-opacity point so the bars read as part of the brand
// frame rather than a separate background.
const PAD_COLOR = { r: 144, g: 144, b: 144 } as const;

/**
 * Place the VTON output onto the 1024x1536 share-card canvas inside
 * the safe inner area (between the top + bottom scrim bands), with
 * mid-gray padding outside. The body is never cropped: if the VTON
 * output's aspect matches the inner area's (1024:1106 = 0.926) the
 * figure fills it; otherwise sharp letterboxes the smaller axis
 * with the pad color.
 *
 * FASHN tryon-v1.6 currently outputs 864x1296 (2:3, narrower than
 * the inner area), so the figure scales to 737x1106 and lands
 * centered with ~143px gray bars on either side. Replicate
 * IDM-VTON returns 768x1024 (3:4, wider than the inner area), so
 * the figure scales to 1024 wide and lands centered vertically
 * inside the inner area. Either way, head sits at min y=215 and
 * feet at max y=1321, both clear of the scrims.
 */
async function placeOnSafeCanvas(pngBuffer: Buffer): Promise<Buffer> {
  const inputMeta = await sharp(pngBuffer).metadata();
  console.log(
    `[render] VTON output dimensions: ${inputMeta.width}x${inputMeta.height} (placing inside ${SAFE_INNER_WIDTH}x${SAFE_INNER_HEIGHT} safe area)`
  );

  // Resize with fit:"inside" preserves aspect and shrinks to fit
  // whichever dimension is the constraint. No cropping ever.
  const fitted = await sharp(pngBuffer)
    .resize({
      width: SAFE_INNER_WIDTH,
      height: SAFE_INNER_HEIGHT,
      fit: "inside",
      withoutEnlargement: false,
    })
    .png()
    .toBuffer();

  const fittedMeta = await sharp(fitted).metadata();
  const fW = fittedMeta.width ?? SAFE_INNER_WIDTH;
  const fH = fittedMeta.height ?? SAFE_INNER_HEIGHT;

  // Center inside the safe inner band.
  const left = Math.round((OVERLAY_WIDTH - fW) / 2);
  const top = SCRIM_TOP_PX + Math.round((SAFE_INNER_HEIGHT - fH) / 2);

  return sharp({
    create: {
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
      channels: 3,
      background: PAD_COLOR,
    },
  })
    .composite([{ input: fitted, top, left }])
    .png()
    .toBuffer();
}

/**
 * Structured render failure type. The route handler maps these to
 * HTTP statuses (moderation_blocked -> 422, no_provider -> 500,
 * everything else -> 500). No credit is consumed when this is
 * returned; callers retry at no cost.
 */
export type RunRenderError = {
  kind:
    | "no_provider_configured"
    | "moderation_blocked"
    | "pose_error"
    | "image_load_error"
    | "garment_unsupported"
    | "timeout"
    | "error";
  message: string;
};

/**
 * Run the try-on. Throws nothing; returns the PNG buffer on success
 * or a structured failure the route maps to an HTTP status.
 *
 * Outfit mode chains FASHN calls: the output of call N becomes the
 * model_image for call N+1. Total latency scales linearly with item
 * count (~12s per item in quality mode, so an 8-item outfit runs
 * close to the maxDuration=300s budget). If any single call fails,
 * the whole render fails; partial outfits are not surfaced because
 * they read as incomplete to the user.
 */
// Subcategories the FASHN chain will actually render. Anything
// else (shoes, jewelry, accessories, outerwear, swim, beauty,
// home, other) stays in the items array for shoppability + logging
// but gets skipped from the FASHN chain so we don't burn a pass
// on something the model can't reliably swap. Mirrors
// TRYON_ELIGIBLE_CATEGORIES in the grid client and keeps the
// "no shoes" rule honored regardless of who's calling /api/render.
const CHAINABLE_SUBCATEGORIES = new Set<string>([
  "tops",
  "bottoms",
  "dresses",
  "bags",
]);

// Map our internal subcategory taxonomy to FASHN tryon-v1.6's
// `category` enum. FASHN supports auto / tops / bottoms /
// one-pieces. Bags get `auto` because FASHN has no bags enum and
// we'd rather let the model classify than pin it wrong.
//
// Passing an explicit category (vs "auto" for everything) is the
// load-bearing fix for the chained "phantom denim" artifact: when
// FASHN auto-classifies an ambiguous garment image it can place
// the wrong region or add spurious accessories (a jeans-shaped
// silhouette tied at the waist of a top render). Pinning each
// pass to the right region keeps the swap targeted.
function fashnCategoryFor(subcategory: string | null): VtonCategory {
  switch (subcategory) {
    case "tops":
      return "tops";
    case "bottoms":
      return "bottoms";
    case "dresses":
      return "one-pieces";
    default:
      return "auto";
  }
}

export async function runRender(args: {
  personBuffer: Buffer;
  personMime: string;
  /**
   * All items the client sent, in their original order. Items
   * whose category is not in CHAINABLE_SUBCATEGORIES are skipped
   * from the FASHN chain (shoes/jewelry/etc.) so the result
   * doesn't carry a residue pass that failed to place them.
   */
  items: { image_url: string; category: string | null }[];
}): Promise<
  | { ok: true; pngBuffer: Buffer; provider: "fashn" | "replicate" }
  | { ok: false; error: RunRenderError }
> {
  if (args.items.length === 0) {
    return {
      ok: false,
      error: { kind: "error", message: "no items provided" },
    };
  }

  // Split into chainable vs skipped. We log the skipped set so the
  // user-facing "your outfit" includes the visible pieces but the
  // chain only spends FASHN credits on what FASHN can actually
  // render. Items without a category (legacy callers) default to
  // chainable so we don't silently drop a single-item Try-On.
  const chainable: { image_url: string; category: string | null }[] = [];
  const skipped: { image_url: string; category: string | null }[] = [];
  for (const it of args.items) {
    if (it.category && !CHAINABLE_SUBCATEGORIES.has(it.category)) {
      skipped.push(it);
    } else {
      chainable.push(it);
    }
  }
  if (skipped.length > 0) {
    console.log(
      `[render] skipping ${skipped.length} non-chainable item(s) from FASHN chain: [${skipped
        .map((s) => s.category ?? "?")
        .join(", ")}]`
    );
  }
  if (chainable.length === 0) {
    // Every item was skipped (e.g. an outfit of only shoes). Return
    // a clean failure so the route surfaces "no_items" semantics.
    return {
      ok: false,
      error: {
        kind: "garment_unsupported",
        message: `no chainable items: all ${args.items.length} were non-chainable categories`,
      },
    };
  }

  // Chain VTON calls, feeding each output back in as the next
  // model_image. For single-item renders this loop runs once; the
  // result is the FASHN/Replicate output directly.
  let workingPerson = args.personBuffer;
  let workingMime = args.personMime;
  let lastResult: VtonResult | null = null;

  for (let i = 0; i < chainable.length; i++) {
    const it = chainable[i];
    const fashnCat = fashnCategoryFor(it.category);
    const r = await tryOn({
      personBuffer: workingPerson,
      personMime: workingMime,
      garmentImageUrl: it.image_url,
      category: fashnCat,
      garmentPhotoType: "model",
    });

    if (!r.ok) {
      console.error(
        `[render] vton item ${i + 1}/${chainable.length} (${it.category ?? "?"} -> ${fashnCat}) failed reason=${r.reason} detail=${r.detail}`
      );
      // Map VtonFailureReason -> RunRenderError.kind. The route
      // turns moderation_blocked into a 422 with a specific user
      // message; the others all become a generic 500 with no
      // credit consumed.
      return {
        ok: false,
        error: {
          kind: r.reason === "no_provider_configured" ? "no_provider_configured" : r.reason,
          message: r.detail,
        },
      };
    }

    console.log(
      `[render] vton item ${i + 1}/${chainable.length} (${it.category ?? "?"} -> ${fashnCat}) ok provider=${r.provider} runtime=${r.runtimeMs}ms${r.creditsUsed != null ? ` credits=${r.creditsUsed}` : ""}`
    );

    // Output of this call becomes input to the next. Mime is always
    // image/png because FASHN/Replicate hand us PNGs.
    workingPerson = r.pngBuffer;
    workingMime = "image/png";
    lastResult = r;
  }

  if (!lastResult || !lastResult.ok) {
    return {
      ok: false,
      error: { kind: "error", message: "no VTON result produced" },
    };
  }

  // Place onto the share-card canvas inside the safe inner band,
  // then composite the overlay. The placeOnSafeCanvas + applyBranding
  // pair is the only post-processing we do; everything else (identity,
  // pose, hair, background) comes from the VTON output unchanged.
  try {
    const placed = await placeOnSafeCanvas(lastResult.pngBuffer);
    const branded = await applyBranding(placed);
    return { ok: true, pngBuffer: branded, provider: lastResult.provider };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[render] branding failed:", msg);
    return { ok: false, error: { kind: "error", message: msg } };
  }
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
  const renderPath = `${args.userId}/${uuid}.png`;
  const up = await sb.storage
    .from(RENDER_BUCKET)
    .upload(renderPath, args.pngBuffer, {
      contentType: "image/png",
      upsert: false,
    });
  if (up.error) {
    throw new Error(`render upload failed: ${up.error.message}`);
  }
  const signed = await sb.storage
    .from(RENDER_BUCKET)
    .createSignedUrl(renderPath, RENDER_SIGNED_URL_TTL_SECONDS);
  if (signed.error || !signed.data?.signedUrl) {
    throw new Error(
      `render sign failed: ${signed.error?.message ?? "unknown"}`
    );
  }
  return { path: renderPath, signedUrl: signed.data.signedUrl };
}

/**
 * Download the user's uploaded try-on photo from the private bucket.
 * Returns the raw bytes plus mime so runRender can pass them straight
 * into the VTON call as the model_image.
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
