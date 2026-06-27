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

// Bundled fonts. Inter Regular + Bold are shipped at
// src/lib/render-assets/ and force-traced into the /api/render Vercel
// function via next.config.mjs outputFileTracingIncludes. Reading
// them via path.join(process.cwd(), ...) at runtime is the pattern
// the Vercel file tracer can statically resolve when paired with the
// explicit include directive.
//
// We embed the font instead of relying on a system fallback because
// the Vercel serverless runtime has no Georgia / serif fonts
// installed — every SVG `<text>` we used to render came back as tofu
// boxes. fontfile= on sharp.text() bypasses fontconfig entirely.
const INTER_BOLD_PATH = path.join(
  process.cwd(),
  "src/lib/render-assets/Inter-Bold.ttf"
);
const INTER_REGULAR_PATH = path.join(
  process.cwd(),
  "src/lib/render-assets/Inter-Regular.ttf"
);

/**
 * Single fixed prompt for the gpt-image-1 /images/edits call. Locked
 * verbatim by product spec — both "Show This Item" (1 product image
 * in addition to the user photo) and "Try This Outfit" (N product
 * images in addition to the user photo) use this exact string. The
 * input image[] array carries the count distinction; the prompt does
 * not branch on kind.
 */
const RENDER_PROMPT =
  "Dress the person in the first image in the clothing item(s) shown in the other image(s). Keep their face, body, hair, pose, and background exactly the same. Replace only their outfit with the item(s) shown, matching color, pattern, fabric, and cut as closely as possible. Photorealistic, natural fit and draping. Keep the person fully clothed and the image non-sexual.";

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
 * Render a string to a transparent-background PNG buffer using sharp's
 * pangocairo text engine with our bundled Inter font. The fontfile
 * option pins the font to a path we control so the renderer never
 * falls back to a missing system font (which is what produced the
 * tofu-box bug in the previous serif overlay).
 *
 * Returns the rendered PNG plus the bounding box so the caller can
 * position pills and image origins exactly.
 */
async function renderTextPng(opts: {
  text: string;
  fontDescription: string; // e.g. "Inter Bold 36" — Pango parses this
  fontfile: string;
  rgb: [number, number, number];
}): Promise<{ buffer: Buffer; width: number; height: number }> {
  const buf = await sharp({
    text: {
      // Pango markup. Foreground as 6-char hex; the font description
      // (family + weight + size) carries the rest. align/centre
      // would only matter if we passed a width box — we let the text
      // be its natural width and center it ourselves.
      text: `<span foreground="#${opts.rgb
        .map((c) => c.toString(16).padStart(2, "0"))
        .join("")}">${escapePangoMarkup(opts.text)}</span>`,
      font: opts.fontDescription,
      fontfile: opts.fontfile,
      rgba: true,
    },
  })
    .png()
    .toBuffer();
  const meta = await sharp(buf).metadata();
  return {
    buffer: buf,
    width: meta.width ?? 0,
    height: meta.height ?? 0,
  };
}

function escapePangoMarkup(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Build a rounded-rect "pill" SVG sized to wrap a text block with
 * symmetric padding. Translucent black so white text stays legible on
 * any photo without dominating the composition.
 */
function pillSvg(width: number, height: number): Buffer {
  const radius = Math.round(height / 2);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="0" y="0" width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="black" fill-opacity="0.42"/></svg>`
  );
}

/**
 * Composite the AskMai wordmark at top-center and www.askmai.co at
 * bottom-center, each behind a thin translucent pill for legibility.
 * No cropping — the input PNG passes through at its full dimensions,
 * head to feet. Sizes scale to the input width so the overlay looks
 * the same whether the model returned 1024x1024 or 1024x1536.
 */
async function applyBranding(pngBuffer: Buffer): Promise<Buffer> {
  const img = sharp(pngBuffer);
  const meta = await img.metadata();
  const width = meta.width ?? 1024;
  const height = meta.height ?? 1536;

  // Type scale tied to image width so the wordmark holds proportion
  // on either size return. ~4% of width for the brand, ~2.2% for the
  // URL (a comfortable hierarchy at typical viewing sizes).
  const wordmarkPt = Math.max(20, Math.round(width * 0.04));
  const urlPt = Math.max(13, Math.round(width * 0.022));

  const wordmark = await renderTextPng({
    text: "AskMai",
    fontDescription: `Inter Bold ${wordmarkPt}`,
    fontfile: INTER_BOLD_PATH,
    rgb: [255, 255, 255],
  });
  const url = await renderTextPng({
    text: "www.askmai.co",
    fontDescription: `Inter ${urlPt}`,
    fontfile: INTER_REGULAR_PATH,
    rgb: [255, 255, 255],
  });

  // Pill padding scaled with image width so the visual weight stays
  // in proportion across sizes. The pill sits behind the text only,
  // not edge-to-edge — keeps the overlay feeling tasteful.
  const padX = Math.round(width * 0.035);
  const padY = Math.round(width * 0.012);
  const topPillW = wordmark.width + padX * 2;
  const topPillH = wordmark.height + padY * 2;
  const botPillW = url.width + padX * 2;
  const botPillH = url.height + padY * 2;

  // Inset from each edge. 3% of height keeps both elements clear of
  // the natural framing without floating in space.
  const edgeMargin = Math.round(height * 0.03);

  const topPillLeft = Math.round((width - topPillW) / 2);
  const topPillTop = edgeMargin;
  const topTextLeft = Math.round((width - wordmark.width) / 2);
  const topTextTop = topPillTop + padY;

  const botPillLeft = Math.round((width - botPillW) / 2);
  const botPillTop = height - botPillH - edgeMargin;
  const botTextLeft = Math.round((width - url.width) / 2);
  const botTextTop = botPillTop + padY;

  return img
    .composite([
      { input: pillSvg(topPillW, topPillH), top: topPillTop, left: topPillLeft },
      { input: wordmark.buffer, top: topTextTop, left: topTextLeft },
      { input: pillSvg(botPillW, botPillH), top: botPillTop, left: botPillLeft },
      { input: url.buffer, top: botTextTop, left: botTextLeft },
    ])
    .png()
    .toBuffer();
}

/**
 * Call gpt-image-1 with the person photo plus 1..N garment reference
 * images. Throws on any upstream failure so the caller can decide
 * whether to surface "render failed" vs charging the user.
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

  const personExt =
    args.personMime === "image/png"
      ? "png"
      : args.personMime === "image/webp"
      ? "webp"
      : "jpg";
  const personBlob = new Blob([new Uint8Array(args.personBuffer)], {
    type: args.personMime,
  });

  const itemFetches = await Promise.all(
    args.itemImageUrls.map((u, i) => fetchItemBlob(u, i))
  );

  const form = new FormData();
  form.append("model", OPENAI_MODEL);
  form.append("prompt", RENDER_PROMPT);
  form.append("size", OPENAI_SIZE);
  form.append("quality", OPENAI_QUALITY);
  form.append("n", "1");
  form.append("image[]", personBlob, `person.${personExt}`);
  for (const item of itemFetches) {
    form.append("image[]", item.blob, item.filename);
  }

  const resp = await fetch(OPENAI_IMAGES_EDITS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
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
