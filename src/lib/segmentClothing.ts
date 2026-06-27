/**
 * Clothing segmentation for the render inpaint pipeline.
 *
 * Calls the SegFormer-B2 clothing model on Hugging Face's Inference
 * API (mattmdjaga/segformer_b2_clothes — pretrained on the
 * iMaterialist Fashion dataset) and returns an OpenAI-compatible
 * mask PNG for /v1/images/edits.
 *
 * Mask semantics (per OpenAI docs): RGBA PNG, same dimensions as
 * the base image. Alpha=0 marks the editable region; alpha=255
 * marks the region that must be preserved bit-for-bit.
 *
 * We OR-merge the model's labeled masks down to a single binary
 * mask covering only the wearables that try-on should rewrite:
 *
 *   editable (the clothing):
 *     Upper-clothes, Skirt, Pants, Dress, Belt, Scarf
 *
 *   preserved (everything else):
 *     Face, Hair, Hat, Sunglasses, Left/Right-arm, Left/Right-leg,
 *     Left/Right-shoe, Bag, Background
 *
 * Shoes stay preserved in v1 — try-on for footwear is a separate
 * follow-up that needs category-aware mask selection. Logged as a
 * known gap.
 *
 * The function throws (never returns) when:
 *   - HF_API_TOKEN is missing
 *   - HF returns non-200
 *   - HF returns no clothing classes (no detectable garment)
 *   - mask coverage falls outside the 5-90% sanity band
 *     ("nothing detected" or "whole photo masked")
 *
 * Throwing is by design — the route's `runRender` try/catch returns
 * 500 render_failed and never consumes a credit. Failed segmentation
 * costs the user nothing.
 */

import sharp from "sharp";
import { readEnv } from "./env";

// HF deprecated and removed `api-inference.huggingface.co` in late
// 2025 — the host no longer has a DNS A record, and our old URL
// surfaced in the render lambda as
// `getaddrinfo ENOTFOUND api-inference.huggingface.co`. The model
// is still available via the new Inference Providers router under
// the hf-inference provider:
//
//   https://router.huggingface.co/hf-inference/models/{model_id}
//
// Per HF's current image-segmentation API spec:
//   - Authorization: Bearer hf_*** (unchanged)
//   - body: raw image bytes (when no `parameters` are sent)
//   - response: [{ label, score, mask: <base64 PNG> }, ...]
//
// All of those match what segmentClothingMask already does, so this
// is a pure endpoint swap.
const SEGFORMER_URL =
  "https://router.huggingface.co/hf-inference/models/mattmdjaga/segformer_b2_clothes";

// Classes we want OR-merged into the editable mask. Labels match the
// model's training set verbatim — capitalization and hyphenation are
// significant. Order doesn't matter (Set semantics).
const EDITABLE_CLASSES = new Set<string>([
  "Upper-clothes",
  "Skirt",
  "Pants",
  "Dress",
  "Belt",
  "Scarf",
]);

// Sanity band for the merged mask. Below the floor we likely missed
// the garment entirely (model fired on background or empty); above
// the ceiling we'd be rewriting the whole image, which defeats the
// inpaint constraint.
const MIN_COVERAGE_PCT = 5;
const MAX_COVERAGE_PCT = 90;

const FETCH_TIMEOUT_MS = 30_000;

export type SegmentResult = {
  /** PNG buffer ready to pass to OpenAI as the `mask` field. */
  maskPng: Buffer;
  /** Percentage of pixels in the editable (transparent) region. */
  coveragePct: number;
  /** Class labels that contributed to the editable mask. */
  classesUsed: string[];
};

/**
 * Run SegFormer-B2 clothing on a photo and return the OpenAI mask.
 *
 * @param photoBuffer The user's try-on photo as raw bytes.
 * @returns Mask PNG + coverage stats. Throws on any failure path.
 */
export async function segmentClothingMask(
  photoBuffer: Buffer
): Promise<SegmentResult> {
  const token = readEnv("HF_API_TOKEN");
  if (!token) {
    throw new Error("HF_API_TOKEN not set");
  }

  // HF Inference API accepts the raw image bytes as the request
  // body. Content-Type can be inferred but we send octet-stream to
  // stay neutral on the upstream's parser.
  const resp = await fetch(SEGFORMER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
    },
    body: new Uint8Array(photoBuffer),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `segformer ${resp.status}: ${text.slice(0, 400)}`
    );
  }

  // HF image-segmentation responses are arrays of
  // { label, score, mask: <base64 PNG single-class binary mask> }.
  // Mask PNG is grayscale where 255 = belongs to this class.
  const json = (await resp.json()) as Array<{
    label?: string;
    score?: number;
    mask?: string;
  }>;
  if (!Array.isArray(json)) {
    throw new Error("segformer returned non-array body");
  }
  const wanted = json.filter(
    (c) => typeof c.label === "string" && EDITABLE_CLASSES.has(c.label) && c.mask
  );
  if (wanted.length === 0) {
    throw new Error("segformer detected no clothing classes");
  }

  // Read the base photo dimensions so we resize each class mask to
  // match exactly. SegFormer outputs at the input's resolution so
  // resize is usually a no-op, but pin it defensively in case HF
  // ever rescales.
  const photoMeta = await sharp(photoBuffer).metadata();
  const width = photoMeta.width;
  const height = photoMeta.height;
  if (!width || !height) {
    throw new Error("could not read photo dimensions");
  }
  const totalPixels = width * height;

  // OR-merge: start from zeros, raise each pixel to 255 wherever any
  // wanted class said "yes." sharp.raw() returns a 1-channel grayscale
  // buffer (length = w*h). We mutate in place to avoid allocating one
  // buffer per class.
  let merged: Buffer | null = null;
  const classesUsed: string[] = [];
  for (const c of wanted) {
    const classMaskRaw = Buffer.from(c.mask as string, "base64");
    // ensureAlpha(0) drops any alpha channel; .extractChannel(0) takes
    // the first channel. Combining gives us a flat grayscale even if
    // the upstream returns RGB-encoded binaries.
    const flat = await sharp(classMaskRaw)
      .resize({ width, height, fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer();
    if (!merged) {
      merged = Buffer.from(flat);
    } else {
      for (let i = 0; i < merged.length; i++) {
        if (flat[i] > merged[i]) merged[i] = flat[i];
      }
    }
    classesUsed.push(c.label as string);
  }
  if (!merged) {
    throw new Error("merge yielded empty mask");
  }

  // Coverage check: count pixels above 127 (binary threshold).
  let editableCount = 0;
  for (let i = 0; i < merged.length; i++) {
    if (merged[i] > 127) editableCount++;
  }
  const coveragePct = (editableCount / totalPixels) * 100;
  if (coveragePct < MIN_COVERAGE_PCT || coveragePct > MAX_COVERAGE_PCT) {
    throw new Error(
      `mask coverage ${coveragePct.toFixed(1)}% outside sanity band ${MIN_COVERAGE_PCT}-${MAX_COVERAGE_PCT}%`
    );
  }

  // Build the RGBA PNG OpenAI expects:
  //   editable pixel (merged[i] > 127):  RGBA = (0,0,0,0)       transparent
  //   preserved pixel:                   RGBA = (255,255,255,255) opaque
  const rgba = Buffer.alloc(totalPixels * 4);
  for (let i = 0; i < totalPixels; i++) {
    const editable = merged[i] > 127;
    const base = i * 4;
    rgba[base] = 255;
    rgba[base + 1] = 255;
    rgba[base + 2] = 255;
    rgba[base + 3] = editable ? 0 : 255;
  }
  const maskPng = await sharp(rgba, {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();

  return { maskPng, coveragePct, classesUsed };
}
