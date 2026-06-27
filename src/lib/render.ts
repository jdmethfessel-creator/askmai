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
import { segmentClothingMask } from "./segmentClothing";

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
// at 1024x1536). For a clothing-swap edit on a real photo, the
// quality delta is small and the unit-economics delta is large.
const OPENAI_QUALITY = "medium";
const OPENAI_IMAGES_EDITS_URL = "https://api.openai.com/v1/images/edits";
const RENDER_SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7;

const RENDER_BUCKET = "renders";

// Pre-rendered branding assets. The wordmark ("AskMai") and the URL
// ("www.askmai.co") are baked to PNG once at dev time using sharp's
// text engine + the bundled Inter TTFs, then committed to the repo.
// At runtime we ONLY composite the PNGs — never render text — so the
// /api/render lambda has zero font / fontconfig dependency.
//
// Why this matters: the Vercel serverless runtime has no fontconfig
// default config and no system fonts. sharp.text() with fontfile=
// works locally (libvips finds the file via the fontfile hint) but
// fails on the deployed lambda where Pango can't resolve the family
// description even with fontfile= present. Reproducing that failure
// in dev is hard, so the safe pattern is: do all text work at dev
// time, ship raster output.
//
// The strings ("AskMai" and "www.askmai.co") are baked into the PNG
// data — no runtime string substitution path, so no foreign string
// (e.g. a storage hostname from anywhere else in the code) can ever
// leak into the overlay.
const WORDMARK_PNG_PATH = path.join(
  process.cwd(),
  "src/lib/render-assets/wordmark-askmai.png"
);
const URL_PNG_PATH = path.join(
  process.cwd(),
  "src/lib/render-assets/url-askmai-co.png"
);

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
 * Build a rounded-rect "pill" SVG sized to wrap a text block with
 * symmetric padding. Translucent black so white text stays legible on
 * any photo without dominating the composition. SVG is fine here:
 * sharp renders it as a vector primitive, no font path involved.
 *
 * Pill opacity is tuned for "magazine credit," not "watermark":
 * 0.22 reads as a refined overlay that supports the text rather
 * than a heavy black box.
 */
function pillSvg(width: number, height: number): Buffer {
  const radius = Math.round(height / 2);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="0" y="0" width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="black" fill-opacity="0.22"/></svg>`
  );
}

/**
 * Lazy-cached pre-rendered text PNGs. The buffers live in memory for
 * the lifetime of the lambda after the first render, so subsequent
 * renders pay zero disk I/O for the overlay. We use require-style
 * fs.readFile (not import) so Next.js' file tracer can statically
 * resolve the include via the outputFileTracingIncludes directive
 * in next.config.mjs.
 */
let cachedWordmark: { buffer: Buffer; width: number; height: number } | null = null;
let cachedUrl: { buffer: Buffer; width: number; height: number } | null = null;

async function loadBrandingAsset(
  filePath: string
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const fs = await import("fs/promises");
  const buf = await fs.readFile(filePath);
  const meta = await sharp(buf).metadata();
  return { buffer: buf, width: meta.width ?? 0, height: meta.height ?? 0 };
}

async function getWordmarkAsset() {
  if (!cachedWordmark) {
    cachedWordmark = await loadBrandingAsset(WORDMARK_PNG_PATH);
  }
  return cachedWordmark;
}
async function getUrlAsset() {
  if (!cachedUrl) {
    cachedUrl = await loadBrandingAsset(URL_PNG_PATH);
  }
  return cachedUrl;
}

/**
 * Composite the AskMai wordmark at top-center and www.askmai.co at
 * bottom-center, each behind a thin translucent pill for legibility.
 *
 * No runtime text rendering. The wordmark and URL are pre-rendered
 * PNG assets (from src/lib/render-assets/) that get resized down to
 * fit the target image width and composited as raster overlays.
 * This removes every dependency on pango / fontconfig / system
 * fonts on the lambda — the only thing sharp does here is resize
 * and overlay, which has been rock-solid on Vercel since day one.
 *
 * No cropping — the input PNG passes through at its full dimensions,
 * head to feet. Asset sizes scale to the input width so the overlay
 * looks the same whether the model returned 1024x1024 or 1024x1536.
 */
async function applyBranding(pngBuffer: Buffer): Promise<Buffer> {
  const img = sharp(pngBuffer);
  const meta = await img.metadata();
  const width = meta.width ?? 1024;
  const height = meta.height ?? 1536;

  // Load pre-rendered assets (cached after first call).
  const wmRaw = await getWordmarkAsset();
  const urlRaw = await getUrlAsset();

  // Resize each asset to a target width that holds proportion across
  // input sizes. Magazine-credit scale: 13% of image width for the
  // wordmark, 17% for the URL. The pre-rendered sources are ~800px
  // wide so resize-down to ~130-175px stays crisp.
  const wordmarkTargetW = Math.round(width * 0.13);
  const urlTargetW = Math.round(width * 0.17);

  const wordmark = await sharp(wmRaw.buffer)
    .resize({ width: wordmarkTargetW })
    .png()
    .toBuffer();
  const url = await sharp(urlRaw.buffer)
    .resize({ width: urlTargetW })
    .png()
    .toBuffer();
  const wordmarkMeta = await sharp(wordmark).metadata();
  const urlMeta = await sharp(url).metadata();
  const wordmarkW = wordmarkMeta.width ?? wordmarkTargetW;
  const wordmarkH = wordmarkMeta.height ?? 0;
  const urlW = urlMeta.width ?? urlTargetW;
  const urlH = urlMeta.height ?? 0;

  // Pill padding tightened. Magazine credit, not banner.
  const padX = Math.round(width * 0.022);
  const padY = Math.round(width * 0.008);
  const topPillW = wordmarkW + padX * 2;
  const topPillH = wordmarkH + padY * 2;
  const botPillW = urlW + padX * 2;
  const botPillH = urlH + padY * 2;

  // Inset from each edge. 1.8% of height keeps both labels tight to
  // the top and bottom edges (not floating into the body of the
  // image) while staying symmetrical.
  const edgeMargin = Math.round(height * 0.018);

  const topPillLeft = Math.round((width - topPillW) / 2);
  const topPillTop = edgeMargin;
  const topTextLeft = Math.round((width - wordmarkW) / 2);
  const topTextTop = topPillTop + padY;

  const botPillLeft = Math.round((width - botPillW) / 2);
  const botPillTop = height - botPillH - edgeMargin;
  const botTextLeft = Math.round((width - urlW) / 2);
  const botTextTop = botPillTop + padY;

  return img
    .composite([
      { input: pillSvg(topPillW, topPillH), top: topPillTop, left: topPillLeft },
      { input: wordmark, top: topTextTop, left: topTextLeft },
      { input: pillSvg(botPillW, botPillH), top: botPillTop, left: botPillLeft },
      { input: url, top: botTextTop, left: botTextLeft },
    ])
    .png()
    .toBuffer();
}

/**
 * Inpaint render via gpt-image-1 /v1/images/edits.
 *
 * Flow (every step throws on failure; the route catches and returns
 * 500 render_failed WITHOUT consuming a credit):
 *
 *   1. Normalize the user photo to OPENAI_SIZE (1024x1536, portrait),
 *      contain-fit with a neutral pad so head-to-feet is never
 *      cropped.
 *   2. Run SegFormer-B2 clothing on the normalized photo to produce
 *      a clothing-only mask (transparent over Upper-clothes / Skirt /
 *      Pants / Dress / Belt / Scarf; opaque over face, hair, arms,
 *      legs, shoes, bag, hat, background).
 *   3. Fetch each product reference image.
 *   4. Call /v1/images/edits with:
 *        image[]  = [normalized_user_photo, ...product_refs]
 *        mask     = the clothing mask
 *        prompt   = RENDER_PROMPT
 *        size     = OPENAI_SIZE  (fixed; mask must match)
 *      The mask only applies to image[0] (the user photo). The
 *      product images are pure references — the model uses them to
 *      decide what to paint into the masked region.
 *   5. Composite branding (top wordmark + bottom URL) and return.
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

  // 2. Generate the clothing mask from the normalized photo.
  //    segmentClothingMask throws when HF_API_TOKEN is missing, when
  //    the model returns no clothing classes, or when coverage falls
  //    outside the sanity band — all of which become render_failed
  //    upstream with no credit consumed.
  const seg = await segmentClothingMask(normalizedPerson);
  console.log(
    `[render] mask coverage=${seg.coveragePct.toFixed(1)}% classes=${seg.classesUsed.join(",")}`
  );

  // 3. Fetch product reference images.
  const itemFetches = await Promise.all(
    args.itemImageUrls.map((u, i) => fetchItemBlob(u, i))
  );

  // 4. Build the multipart form. Person photo first (the mask target),
  //    then each product as a reference. Mask is a separate field per
  //    the OpenAI spec — not part of image[].
  const personBlob = new Blob([new Uint8Array(normalizedPerson)], {
    type: "image/png",
  });
  const maskBlob = new Blob([new Uint8Array(seg.maskPng)], {
    type: "image/png",
  });
  const form = new FormData();
  form.append("model", OPENAI_MODEL);
  form.append("prompt", RENDER_PROMPT);
  form.append("size", OPENAI_SIZE);
  form.append("quality", OPENAI_QUALITY);
  form.append("n", "1");
  form.append("image[]", personBlob, "person.png");
  for (const item of itemFetches) {
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
  // 5. Brand overlay.
  return applyBranding(raw);
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
