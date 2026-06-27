/**
 * Product-image background removal for the render inpaint pipeline.
 *
 * Calls briaai/RMBG-2.0 on Hugging Face's Inference Providers router
 * (hf-inference provider, image-segmentation pipeline) to strip the
 * background from each product reference image before it goes to
 * gpt-image-1. The cleaned reference becomes a model + garment on a
 * flat white background.
 *
 * Why this matters for try-on:
 *
 * gpt-image-1 in multi-image edit mode treats the reference images
 * as compositional cues, not just garment cues. Editorial product
 * photos often include scene context — a co-model, a setting, a
 * lighting style — and the model freely incorporates that context
 * into the output. The recurring "suit guy" appearing next to the
 * user's rendered figure is the canonical failure: the product
 * shoot had a male partner, and gpt-image-1 inserted him into the
 * try-on.
 *
 * By stripping everything except the foreground subject (the model
 * wearing the garment) and flattening onto white, we give the model
 * a clean, unambiguous garment reference with no extraneous scene
 * cues to inherit.
 *
 * Failure mode: bg-removal is a *quality* improvement, not a
 * correctness requirement. If RMBG returns non-200 / empty / errors,
 * we silently fall back to the original product image. The render
 * still succeeds; it just loses this particular cue-stripping pass.
 * No throw, no credit refund decision.
 */

import sharp from "sharp";
import { readEnv } from "./env";

const RMBG_URL =
  "https://router.huggingface.co/hf-inference/models/briaai/RMBG-2.0";

const FETCH_TIMEOUT_MS = 30_000;

/**
 * Run RMBG-2.0 on a product image and return a white-flattened PNG
 * with the background removed. On any failure, returns the original
 * buffer untouched.
 *
 * @param imageBuffer Raw bytes of the product reference image.
 * @param index Position of this item in the render request — used
 *              only for log lines.
 */
export async function removeProductBackground(
  imageBuffer: Buffer,
  index: number
): Promise<Buffer> {
  const token = readEnv("HF_API_TOKEN");
  if (!token) {
    console.warn(`[render] RMBG item-${index} skipped: HF_API_TOKEN not set`);
    return imageBuffer;
  }

  try {
    const resp = await fetch(RMBG_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
      },
      body: new Uint8Array(imageBuffer),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.warn(
        `[render] RMBG item-${index} ${resp.status}: ${text.slice(0, 200)}`
      );
      return imageBuffer;
    }

    // HF image-segmentation response: array of {label, score, mask}.
    // RMBG typically returns a single subject entry; take the highest-
    // score mask defensively in case the model ever returns multiple.
    const json = (await resp.json()) as Array<{
      label?: string;
      score?: number;
      mask?: string;
    }>;
    if (!Array.isArray(json) || json.length === 0) {
      console.warn(`[render] RMBG item-${index} returned no entries`);
      return imageBuffer;
    }
    const subject = json.reduce((a, b) =>
      (a?.score ?? 0) >= (b?.score ?? 0) ? a : b
    );
    if (!subject?.mask) {
      console.warn(`[render] RMBG item-${index} entries had no mask`);
      return imageBuffer;
    }

    const meta = await sharp(imageBuffer).metadata();
    const width = meta.width;
    const height = meta.height;
    if (!width || !height) {
      console.warn(
        `[render] RMBG item-${index}: could not read product dimensions`
      );
      return imageBuffer;
    }

    // Mask polarity for RMBG: 255 in subject area, 0 in background.
    // Apply directly as alpha — opaque subject, transparent background.
    const maskRaw = await sharp(Buffer.from(subject.mask, "base64"))
      .resize({ width, height, fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer();

    const { data: rgb } = await sharp(imageBuffer)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const total = width * height;
    const rgba = Buffer.alloc(total * 4);
    for (let i = 0; i < total; i++) {
      const b = i * 4;
      rgba[b] = rgb[i * 3];
      rgba[b + 1] = rgb[i * 3 + 1];
      rgba[b + 2] = rgb[i * 3 + 2];
      rgba[b + 3] = maskRaw[i];
    }

    // Flatten the alpha-channel image onto white. gpt-image-1's
    // multi-image edits work best with clean opaque references;
    // transparency in a reference can be interpreted inconsistently.
    // White is the typical editorial-product-photo background, so the
    // model has a familiar visual prior to work from.
    const flattened = await sharp(rgba, {
      raw: { width, height, channels: 4 },
    })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .png()
      .toBuffer();

    console.log(`[render] RMBG item-${index} applied (${width}x${height})`);
    return flattened;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[render] RMBG item-${index} error: ${msg}`);
    return imageBuffer;
  }
}
