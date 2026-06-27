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
 *   runRender({ photoBytes, photoMime, itemImageUrls, kind, creatorHandle })
 *     Calls gpt-image-1 /v1/images/edits with the user's uploaded
 *     photo plus 1..N reference garment image URLs (downloaded
 *     server-side first), composites the askmai.co + @creator
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

import sharp from "sharp";
import { supabaseAdmin } from "./supabase";

export const INCLUDED_RENDERS_PER_MONTH = 3;

// Cost basis at the time of render. Verified 2026-06-27 from the
// OpenAI pricing page for gpt-image-1 high@1024x1024. Stamped onto
// every renders row so a future provider price change does not
// silently rewrite historical spend totals.
const COST_USD_PER_RENDER = 0.167;

const OPENAI_MODEL = "gpt-image-1";
const OPENAI_SIZE = "1024x1024";
const OPENAI_QUALITY = "high";
const OPENAI_IMAGES_EDITS_URL = "https://api.openai.com/v1/images/edits";
const RENDER_SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7;

const RENDER_BUCKET = "renders";

/**
 * Prompt template for gpt-image-1. The HARD CONSTRAINTS block is the
 * guardrail layer: keep the person clothed, swap only the garments,
 * never produce nude / lingerie / sexualized output even if a source
 * product photo is swimwear or intimates. Fail closed on anything
 * ambiguous (no model output is better than a borderline output).
 */
function buildPrompt(kind: "single" | "outfit", itemCount: number): string {
  const garmentNoun = kind === "outfit" || itemCount > 1 ? "garments" : "garment";
  return [
    `Render a photorealistic full-body image of the EXACT person shown in the first image wearing the EXACT ${garmentNoun} shown in the remaining ${itemCount === 1 ? "image" : "images"}.`,
    "",
    "HARD CONSTRAINTS:",
    "  - Preserve the person's face, hairstyle, skin tone, and body proportions identically to the first image. Do not idealize, slim, or restyle the person.",
    `  - Preserve each ${garmentNoun.replace(/s$/, "")}'s silhouette, fabric, color, neckline, sleeve length, hem, and any visible details exactly as shown in its reference image.`,
    "  - Studio-quality photographic look. Clean neutral background. Natural daylight. Sharp focus on the person and clothing.",
    "  - The clothing must fit the person realistically (drape, length, and proportion all consistent with how it would actually wear).",
    "",
    "SAFETY (NON-NEGOTIABLE):",
    "  - This is a clothing-swap render only. The person MUST remain fully clothed in the output. Never produce nude, lingerie-as-result, or sexualized imagery, even if a reference image shows swimwear, intimates, or sheer fabrics. In those cases, render the closest non-revealing equivalent that preserves color and silhouette while keeping the framing modest.",
    "  - Do not change the person's apparent age. Do not produce minors in any state of undress.",
    "  - Keep the framing and pose non-sexual: standing or natural stance, neutral expression.",
    "  - If any reference image is ambiguous or unsafe to render faithfully, fail closed (return the person in their original clothing).",
  ].join("\n");
}

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
 * Branding overlay. SVG composited onto the bottom edge of the
 * rendered PNG via sharp. Translucent dark band so the text stays
 * legible on any background, askmai.co left-aligned, @creator
 * right-aligned. Single composite, no rasterized font asset
 * required.
 */
function buildBrandingSvg(creatorHandle: string, width: number): Buffer {
  const handle = creatorHandle.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 32);
  const bandHeight = Math.round(width * 0.052);
  const fontSize = Math.round(bandHeight * 0.46);
  const padX = Math.round(width * 0.025);
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${bandHeight}" viewBox="0 0 ${width} ${bandHeight}">
  <rect x="0" y="0" width="${width}" height="${bandHeight}" fill="black" fill-opacity="0.42"/>
  <text x="${padX}" y="${Math.round(bandHeight * 0.65)}" font-family="Georgia, 'Times New Roman', serif" font-size="${fontSize}" fill="#ffffff" fill-opacity="0.95" font-style="italic">askmai.co</text>
  <text x="${width - padX}" y="${Math.round(bandHeight * 0.65)}" text-anchor="end" font-family="Georgia, 'Times New Roman', serif" font-size="${fontSize}" fill="#ffffff" fill-opacity="0.95">@${handle}</text>
</svg>`.trim();
  return Buffer.from(svg);
}

/**
 * Composite the branding band onto the bottom of the rendered PNG.
 * Single pass through sharp: read metadata for the width, render the
 * SVG band sized to match, composite at the bottom, encode as PNG.
 */
async function applyBranding(
  pngBuffer: Buffer,
  creatorHandle: string
): Promise<Buffer> {
  const img = sharp(pngBuffer);
  const meta = await img.metadata();
  const width = meta.width ?? 1024;
  const svg = buildBrandingSvg(creatorHandle, width);
  const bandMeta = await sharp(svg).metadata();
  const bandHeight = bandMeta.height ?? Math.round(width * 0.052);
  const totalHeight = (meta.height ?? width) ;
  const top = Math.max(totalHeight - bandHeight, 0);
  return img
    .composite([{ input: svg, top, left: 0 }])
    .png()
    .toBuffer();
}

/**
 * Call gpt-image-1 with the person photo plus 1..N garment reference
 * images. Throws on any upstream failure so the caller can decide
 * whether to surface "render failed" vs charging the user.
 */
export async function runRender(args: {
  kind: "single" | "outfit";
  personBuffer: Buffer;
  personMime: string;
  itemImageUrls: string[];
  creatorHandle: string;
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
  form.append("prompt", buildPrompt(args.kind, args.itemImageUrls.length));
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
  return applyBranding(raw, args.creatorHandle);
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
