/**
 * Shared low-level helpers for the SegFormer-B2 person/clothing
 * segmentation model on HuggingFace's Inference Providers router.
 *
 * Two callers:
 *   - src/lib/segmentClothing.ts (render-time mask extraction)
 *   - src/lib/normalizeTryonPhoto.ts (upload-time normalization)
 *
 * These helpers used to live inline in segmentClothing.ts. Factored
 * out here so the new normalize module can share the SegFormer call,
 * mask-or-merge, and bbox math without code duplication. Pure move:
 * function signatures and behavior are bit-identical to the
 * pre-refactor inline versions.
 *
 * Model: mattmdjaga/segformer_b2_clothes (ATR taxonomy, 18 classes).
 * Routed through router.huggingface.co/hf-inference (HF removed the
 * legacy api-inference.huggingface.co host in late 2025).
 */

import sharp from "sharp";
import { readEnv } from "./env";

const SEGFORMER_URL =
  "https://router.huggingface.co/hf-inference/models/mattmdjaga/segformer_b2_clothes";

const SEGFORMER_FETCH_TIMEOUT_MS = 30_000;

/** ATR class label as returned by SegFormer-B2. Free-form string so
 *  a future fine-tune that adds a class (e.g. "Neck") doesn't break
 *  type-checking; callers filter by name. */
export type SegformerMaskClass = {
  label?: string;
  score?: number;
  mask?: string; // base64-encoded PNG
};

export type Bbox = { x: number; y: number; w: number; h: number };

/**
 * POST the photo bytes to SegFormer-B2 and return the full per-class
 * response. Throws on missing token, non-200, or non-array body.
 */
export async function callSegFormer(
  photoBuffer: Buffer
): Promise<SegformerMaskClass[]> {
  const token = readEnv("HF_API_TOKEN");
  if (!token) {
    throw new Error("HF_API_TOKEN not set");
  }
  const resp = await fetch(SEGFORMER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
    },
    body: new Uint8Array(photoBuffer),
    signal: AbortSignal.timeout(SEGFORMER_FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`segformer ${resp.status}: ${text.slice(0, 400)}`);
  }
  const json = (await resp.json()) as SegformerMaskClass[];
  if (!Array.isArray(json)) {
    throw new Error("segformer returned non-array body");
  }
  return json;
}

/**
 * OR-merge a subset of per-class masks into a single 1-channel
 * grayscale binary buffer. Resizes each class mask to match the
 * requested dimensions (SegFormer returns at the input's resolution
 * so this is usually a no-op, but pinned for safety).
 *
 * Returns null when no class in `wantedSet` is present in the response.
 *
 * IMPORTANT: sharp's `.greyscale()` does NOT collapse to 1 channel;
 * it sets the colorspace to "grayscale" but the raw output stays as
 * 3 identical channels (W*H*3 bytes). We follow with
 * `.extractChannel(0)` to force a true 1-channel raw (W*H bytes),
 * which every downstream consumer assumes. Without this, bbox
 * computation, coverage math, and the alpha builder all read at the
 * wrong stride and produce silently-wrong masks.
 */
export async function orMergeClasses(
  classes: SegformerMaskClass[],
  wantedSet: Set<string>,
  width: number,
  height: number
): Promise<{ merged: Buffer; classesUsed: string[] } | null> {
  const wanted = classes.filter(
    (c) => typeof c.label === "string" && wantedSet.has(c.label) && c.mask
  );
  if (wanted.length === 0) return null;
  const expectedLen = width * height;
  let merged: Buffer | null = null;
  const classesUsed: string[] = [];
  for (const c of wanted) {
    const classMaskRaw = Buffer.from(c.mask as string, "base64");
    const flat = await sharp(classMaskRaw)
      .resize({ width, height, fit: "fill" })
      .greyscale()
      .extractChannel(0)
      .raw()
      .toBuffer();
    if (flat.length !== expectedLen) {
      throw new Error(
        `orMergeClasses: class mask ${c.label} produced wrong size: ${flat.length} vs expected ${expectedLen} (${width}x${height} 1ch)`
      );
    }
    if (!merged) {
      merged = Buffer.from(flat);
    } else {
      for (let i = 0; i < expectedLen; i++) {
        if (flat[i] > merged[i]) merged[i] = flat[i];
      }
    }
    classesUsed.push(c.label as string);
  }
  return { merged: merged as Buffer, classesUsed };
}

/**
 * Compute the tight bounding box of all pixels above the binary
 * threshold (127) in a 1-channel grayscale buffer. Returns null when
 * the buffer is all-zero (no positive pixels).
 */
export function bboxFromMask(
  raw: Buffer,
  width: number,
  height: number
): Bbox | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      if (raw[rowStart + x] > 127) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0 || maxY < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Count pixels above the binary threshold (127). */
export function countPositive(raw: Buffer): number {
  let n = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] > 127) n++;
  }
  return n;
}
