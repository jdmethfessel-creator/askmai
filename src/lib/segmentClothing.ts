/**
 * Human-figure segmentation for the render inpaint pipeline.
 *
 * Calls the SegFormer-B2 clothing model on Hugging Face's Inference
 * Providers router (mattmdjaga/segformer_b2_clothes — pretrained on
 * the iMaterialist Fashion dataset) and returns:
 *
 *   1. An OpenAI-compatible mask PNG for /v1/images/edits
 *      (RGBA: alpha=0 over clothing, alpha=255 elsewhere).
 *
 *   2. A separate raw binary mask of Face + Hair, plus that region's
 *      bounding box. The route uses these for the post-hoc head
 *      composite — the gpt-image-1 mask is treated as a hint by the
 *      model and doesn't strictly preserve the face, so the route
 *      runs SegFormer a second time on the model's output and paints
 *      the user's actual head pixels back over the result.
 *
 * Class mapping:
 *
 *   editable (the clothing — alpha=0 in the OpenAI mask):
 *     Upper-clothes, Skirt, Pants, Dress, Belt, Scarf
 *
 *   head-preserve (used for the post-hoc face composite):
 *     Face, Hair
 *
 *   other-preserve (alpha=255 in the OpenAI mask, no special handling):
 *     Hat, Sunglasses, Left/Right-arm, Left/Right-leg,
 *     Left/Right-shoe, Bag, Background
 *
 * Shoes stay preserved in v1 — try-on for footwear is a separate
 * follow-up that needs category-aware mask selection.
 *
 * Throws (never returns) when:
 *   - HF_API_TOKEN is missing
 *   - HF returns non-200
 *   - HF returns no clothing classes when expected (input photo);
 *     the output-photo path swallows this and returns headBbox=null
 *     because absence-of-face on the OpenAI output is meaningful data,
 *     not a failure
 *   - mask coverage falls outside the 5-90% sanity band
 *
 * Failed segmentation costs the user nothing — the route's runRender
 * try/catch returns 500 render_failed without consuming a credit.
 */

import sharp from "sharp";
import {
  bboxFromMask,
  callSegFormer,
  orMergeClasses,
  type Bbox as SegformerBbox,
} from "./segformer";

// Re-exported below as `Bbox` for back-compat with this file's
// existing consumers (render.ts imports { Bbox, segmentForRender }).

const EDITABLE_CLASSES = new Set<string>([
  "Upper-clothes",
  "Skirt",
  "Pants",
  "Dress",
  "Belt",
  "Scarf",
]);

// "Neck" is included as a belt-and-suspenders: SegFormer-B2's ATR
// taxonomy (Background, Hat, Hair, Sunglasses, Upper-clothes, Skirt,
// Pants, Dress, Belt, Left-shoe, Right-shoe, Face, Left-leg,
// Right-leg, Left-arm, Right-arm, Bag, Scarf) has NO "Neck" label in
// the 18-class set, so this is a no-op against the current model.
// Kept here in case a future fine-tune emits it; the actual seam
// push-down lives in render.ts as a downward dilation of the
// Face+Hair mask, since the model just labels neck pixels as
// Face or Background.
const HEAD_PRESERVE_CLASSES = new Set<string>(["Face", "Hair", "Neck"]);

const MIN_COVERAGE_PCT = 5;
const MAX_COVERAGE_PCT = 90;

export type Bbox = SegformerBbox;

export type SegmentResult = {
  /** PNG buffer ready to pass to OpenAI as the `mask` field. */
  editableMaskPng: Buffer;
  /** Percentage of pixels in the editable (transparent) region. */
  editableCoveragePct: number;
  /** Class labels that contributed to the editable mask. */
  editableClassesUsed: string[];
  /**
   * Raw 1-channel grayscale buffer covering Face + Hair (255 = head,
   * 0 = not head). Length = width * height. Used by the post-hoc
   * face composite in runRender; never sent to OpenAI.
   */
  headMaskRaw: Buffer;
  /**
   * Bounding box of the head region in pixel coordinates, or null
   * when SegFormer detected no Face/Hair (e.g., the model's output
   * recomposed the body so the face is gone). The composite step
   * uses this to verify alignment between input and output.
   */
  headBbox: Bbox | null;
  width: number;
  height: number;
};

export type OutputHeadProbe = {
  width: number;
  height: number;
  headBbox: Bbox | null;
};

// callSegFormer, orMergeClasses, and bboxFromMask moved to
// src/lib/segformer.ts so the new normalizeTryonPhoto module can
// share them. Same signatures, bit-identical behavior.

/**
 * Full segmentation on the user's normalized photo. Returns the
 * editable mask (for OpenAI), the head-preserve mask + bbox (for the
 * post-hoc composite), and the photo's dimensions.
 *
 * Throws on missing token, HF non-200, no clothing detected, or
 * coverage outside the sanity band.
 */
export async function segmentForRender(
  photoBuffer: Buffer
): Promise<SegmentResult> {
  const photoMeta = await sharp(photoBuffer).metadata();
  const width = photoMeta.width;
  const height = photoMeta.height;
  if (!width || !height) {
    throw new Error("could not read photo dimensions");
  }
  const totalPixels = width * height;

  const classes = await callSegFormer(photoBuffer);

  const editable = await orMergeClasses(
    classes,
    EDITABLE_CLASSES,
    width,
    height
  );
  if (!editable) {
    throw new Error("segformer detected no clothing classes");
  }
  const merged = editable.merged;
  if (merged.length !== totalPixels) {
    throw new Error(
      `segmentForRender: editable mask wrong size: ${merged.length} vs expected ${totalPixels} (${width}x${height} 1ch)`
    );
  }

  let editableCount = 0;
  for (let i = 0; i < totalPixels; i++) {
    if (merged[i] > 127) editableCount++;
  }
  const editableCoveragePct = (editableCount / totalPixels) * 100;
  if (
    editableCoveragePct < MIN_COVERAGE_PCT ||
    editableCoveragePct > MAX_COVERAGE_PCT
  ) {
    throw new Error(
      `mask coverage ${editableCoveragePct.toFixed(1)}% outside sanity band ${MIN_COVERAGE_PCT}-${MAX_COVERAGE_PCT}%`
    );
  }

  // Build the RGBA PNG OpenAI expects:
  //   editable pixel (merged[i] > 127):  RGBA = (255,255,255,0)       transparent
  //   preserved pixel:                   RGBA = (255,255,255,255)     opaque
  const rgba = Buffer.alloc(totalPixels * 4);
  for (let i = 0; i < totalPixels; i++) {
    const isEditable = merged[i] > 127;
    const base = i * 4;
    rgba[base] = 255;
    rgba[base + 1] = 255;
    rgba[base + 2] = 255;
    rgba[base + 3] = isEditable ? 0 : 255;
  }
  const editableMaskPng = await sharp(rgba, {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();

  // Head mask: Face + Hair OR-merged into a single 1-channel binary.
  // headBbox is null when no Face/Hair is detected — unusual for an
  // input photo, but we don't throw because the composite step can
  // handle null (it just skips). Better to ship the render than fail
  // the whole pipeline over an unusual photo.
  const head = await orMergeClasses(
    classes,
    HEAD_PRESERVE_CLASSES,
    width,
    height
  );
  const headMaskRaw = head?.merged ?? Buffer.alloc(totalPixels);
  if (headMaskRaw.length !== totalPixels) {
    throw new Error(
      `segmentForRender: head mask wrong size: ${headMaskRaw.length} vs expected ${totalPixels} (${width}x${height} 1ch)`
    );
  }
  const headBbox = head ? bboxFromMask(head.merged, width, height) : null;

  return {
    editableMaskPng,
    editableCoveragePct,
    editableClassesUsed: editable.classesUsed,
    headMaskRaw,
    headBbox,
    width,
    height,
  };
}

/**
 * Lightweight probe used after the OpenAI edit call: re-run SegFormer
 * on the model's output and return ONLY the head bbox. This is the
 * cheap signal the composite step uses to verify the model didn't
 * recompose the body so much that pasting the user's head back would
 * land in the wrong spot.
 *
 * Does NOT throw on "no clothing detected" (the output may not have
 * any recognizable garment in the SegFormer training set, e.g. the
 * model generated a swimsuit-shape that the model labels as Background).
 * Does NOT throw on "no head detected" (returns headBbox=null and the
 * composite step skips on null). Only throws on infra failures (token
 * missing, HF non-200) so that those still fail closed without
 * consuming a credit.
 */
export async function probeHeadBbox(
  imageBuffer: Buffer
): Promise<OutputHeadProbe> {
  const meta = await sharp(imageBuffer).metadata();
  const width = meta.width;
  const height = meta.height;
  if (!width || !height) {
    throw new Error("could not read output dimensions");
  }
  const classes = await callSegFormer(imageBuffer);
  const head = await orMergeClasses(
    classes,
    HEAD_PRESERVE_CLASSES,
    width,
    height
  );
  const headBbox = head ? bboxFromMask(head.merged, width, height) : null;
  return { width, height, headBbox };
}

/**
 * Backward-compat shim. The previous public name; routes still
 * importing the old function get the new shape via segmentForRender.
 * Safe to remove once no caller references this name.
 */
export const segmentClothingMask = segmentForRender;
