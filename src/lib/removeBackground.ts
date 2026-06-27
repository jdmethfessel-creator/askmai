/**
 * Product-image background removal for the render inpaint pipeline.
 *
 * Reuses mattmdjaga/segformer_b2_clothes (the same model the rest of
 * the pipeline relies on) to segment the product photo into person
 * vs. background. We OR-merge every class that is NOT `Background`
 * into a subject mask, apply it as the image's alpha channel, and
 * flatten onto white so gpt-image-1 sees a clean garment-on-white
 * reference instead of an editorial scene.
 *
 * Why not briaai/RMBG-2.0?
 * The previous version of this file called RMBG-2.0 via the
 * hf-inference router. HF docs map RMBG to the fal-ai provider only
 * — calls to hf-inference for that model return
 * `400: Model not supported by provider hf-inference`. Switching
 * providers would mean wiring a second auth path, a different
 * response shape, and a second per-call billing line. SegFormer-B2
 * is already on hf-inference, already authed, already paid for,
 * and produces a subject mask we can use for the same purpose.
 *
 * Why this helps:
 * gpt-image-1 in multi-image edit mode treats references as
 * compositional cues. The "suit guy reappearing" failure was the
 * model latching onto environmental context in the product photo —
 * scene partners, lighting setups, props. Stripping the background
 * removes a substantial chunk of those cues. (If the product photo
 * contains a second model, both stay as foreground — bg-removal
 * isn't a complete fix for that case, but neither was RMBG.)
 *
 * Failure mode: best-effort. On HF non-200, empty mask, wrong-size
 * buffer, or any sharp error, the function returns the original
 * buffer untouched. The render proceeds normally — bg-removal is a
 * quality lever, never a render-blocker.
 */

import sharp from "sharp";
import { readEnv } from "./env";

const SEGFORMER_URL =
  "https://router.huggingface.co/hf-inference/models/mattmdjaga/segformer_b2_clothes";

// SegFormer-B2 clothing label that represents non-person pixels.
// Everything else (Face, Hair, Upper-clothes, Skirt, Pants, Dress,
// Belt, Hat, Sunglasses, Left/Right-arm, Left/Right-leg,
// Left/Right-shoe, Bag, Scarf) collapses into the subject mask.
const BACKGROUND_LABEL = "Background";

const FETCH_TIMEOUT_MS = 30_000;

export async function removeProductBackground(
  imageBuffer: Buffer,
  index: number
): Promise<Buffer> {
  const token = readEnv("HF_API_TOKEN");
  if (!token) {
    console.warn(`[render] bg-remove item-${index} skipped: HF_API_TOKEN not set`);
    return imageBuffer;
  }

  try {
    const resp = await fetch(SEGFORMER_URL, {
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
        `[render] bg-remove item-${index} segformer ${resp.status}: ${text.slice(0, 200)}`
      );
      return imageBuffer;
    }

    const json = (await resp.json()) as Array<{
      label?: string;
      score?: number;
      mask?: string;
    }>;
    if (!Array.isArray(json) || json.length === 0) {
      console.warn(`[render] bg-remove item-${index} returned no entries`);
      return imageBuffer;
    }

    const meta = await sharp(imageBuffer).metadata();
    const width = meta.width;
    const height = meta.height;
    if (!width || !height) {
      console.warn(
        `[render] bg-remove item-${index}: could not read product dimensions`
      );
      return imageBuffer;
    }
    const totalPixels = width * height;

    // OR-merge every NON-Background class mask into a single 1-channel
    // subject mask. Same `.extractChannel(0)` discipline as the rest of
    // the segmentation code — sharp's .greyscale() leaves 3 identical
    // channels in the raw output, and downstream byte-write loops
    // assume 1 channel; forcing extract here keeps them honest.
    let subjectMask: Buffer | null = null;
    let classesUsed = 0;
    for (const c of json) {
      if (typeof c.label !== "string" || !c.mask) continue;
      if (c.label === BACKGROUND_LABEL) continue;
      const classRaw = Buffer.from(c.mask, "base64");
      const flat = await sharp(classRaw)
        .resize({ width, height, fit: "fill" })
        .greyscale()
        .extractChannel(0)
        .raw()
        .toBuffer();
      if (flat.length !== totalPixels) {
        console.warn(
          `[render] bg-remove item-${index}: class ${c.label} wrong size ${flat.length} vs ${totalPixels}`
        );
        return imageBuffer;
      }
      if (!subjectMask) {
        subjectMask = Buffer.from(flat);
      } else {
        for (let i = 0; i < totalPixels; i++) {
          if (flat[i] > subjectMask[i]) subjectMask[i] = flat[i];
        }
      }
      classesUsed++;
    }
    if (!subjectMask || classesUsed === 0) {
      console.warn(
        `[render] bg-remove item-${index}: no non-Background classes detected`
      );
      return imageBuffer;
    }

    // Coverage sanity: if the subject mask covers <2% the product is
    // probably text or an icon SegFormer can't parse; if it covers
    // >99% there's no background to remove. In either case skip and
    // pass the original through.
    let subjectCount = 0;
    for (let i = 0; i < totalPixels; i++) {
      if (subjectMask[i] > 127) subjectCount++;
    }
    const coverage = (subjectCount / totalPixels) * 100;
    if (coverage < 2 || coverage > 99) {
      console.warn(
        `[render] bg-remove item-${index} subject coverage ${coverage.toFixed(1)}% outside sanity band; passing original`
      );
      return imageBuffer;
    }

    const { data: rgb, info } = await sharp(imageBuffer)
      .resize({ width, height, fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 3 || rgb.length !== totalPixels * 3) {
      console.warn(
        `[render] bg-remove item-${index}: product RGB wrong shape ${rgb.length} channels=${info.channels}`
      );
      return imageBuffer;
    }

    // RGBA: subject mask → alpha. Opaque on the model+garment,
    // transparent on the original background.
    const rgba = Buffer.alloc(totalPixels * 4);
    for (let i = 0; i < totalPixels; i++) {
      const b = i * 4;
      rgba[b] = rgb[i * 3];
      rgba[b + 1] = rgb[i * 3 + 1];
      rgba[b + 2] = rgb[i * 3 + 2];
      rgba[b + 3] = subjectMask[i];
    }

    // Flatten onto white so gpt-image-1 sees a clean opaque reference
    // (subjects on white floor — the editorial product-photo norm) and
    // doesn't have to interpret transparency in the reference channel.
    const flattened = await sharp(rgba, {
      raw: { width, height, channels: 4 },
    })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .png()
      .toBuffer();

    console.log(
      `[render] bg-remove item-${index} applied (${width}x${height}, subject ${coverage.toFixed(1)}% of frame, ${classesUsed} SegFormer classes)`
    );
    return flattened;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[render] bg-remove item-${index} error: ${msg}`);
    return imageBuffer;
  }
}
