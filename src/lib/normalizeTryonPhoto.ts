/**
 * Try-on photo input-normalization. Phase A of the design at
 * docs/input-normalization-design.md.
 *
 * Goal: every photo reaching gpt-image-1 is an isolated person on a
 * clean neutral canvas at a fixed known position, scale, and aspect,
 * so the model's job becomes "dress this controlled figure" not
 * "regenerate this scene with new clothes."
 *
 * Pipeline (~5-15 s, runs ONCE at upload):
 *   1. SegFormer-B2 over the original photo (one HF inference call).
 *   2. OR all non-Background classes into a person mask. Hard-reject
 *      if no person detected (coverage < 3%) or multiple people
 *      (>=2 connected components each >5% of canvas).
 *   3. Detect head bbox (Face+Hair) and legs presence (Left/Right-leg)
 *      for the anchor ladder.
 *   4. Pick a scale anchor:
 *        feet detected           -> head-to-feet
 *        legs detected, no feet  -> head-to-hip
 *        face only               -> head-size (1/7 figure rule)
 *      Never fake the missing part of the body. partial_body=true
 *      when feet aren't detected; visible body lands where it lands,
 *      gray below.
 *   5. Crop the person bbox from the original, scale by the chosen
 *      anchor, composite onto a 1024x1536 mid-neutral-gray (#909090)
 *      canvas with the head top anchored at y=100 and body centered
 *      horizontally on x=512. Feather the cutout edge ~3 px so it
 *      doesn't look like a paper-cutout sticker.
 *   6. Return the canonical 1024x1536 PNG + the geometry blob the
 *      render-time face composite reads from users.tryon_geometry.
 *
 * The render pipeline (src/lib/render.ts) is NOT touched by this
 * module. It still reads users.tryon_photo_path; after Phase A that
 * path points at the normalized PNG instead of the raw upload, and
 * everything downstream behaves identically with a much better input.
 */

import sharp from "sharp";
import {
  bboxFromMask,
  callSegFormer,
  countPositive,
  orMergeClasses,
  type Bbox,
} from "./segformer";

// ---- Constants (tunable; design-doc defaults) -----------------------------

const CANVAS_W = 1024;
const CANVAS_H = 1536;
/** Mid-neutral gray. Per the design: light blows out body lighting,
 *  black crushes it. ~#888-999 produces even neutral light. */
const CANVAS_COLOR = "#909090";

/** Anchor A: head-to-feet. Target person height = 87.9% of canvas. */
const TARGET_PERSON_HEIGHT_PX = 1350;
/** Anchor B: head-to-hip. 765px = ~50% of canvas. */
const TARGET_HEAD_TO_HIP_PX = 765;
/** Anchor C: head-size only. 215px = ~1/7 of canvas (classical figure rule). */
const TARGET_HEAD_HEIGHT_PX = 215;
/** Top of head lands here in the final canvas. */
const TARGET_HEAD_TOP_Y = 100;

/** Cap on linear scale so a small input isn't blown up beyond resolution. */
const MAX_LINEAR_UPSCALE = 4.0;

/** Edge feather sigma (px) on the person-cutout alpha. */
const CUTOUT_FEATHER_SIGMA = 3;

/** Garment-void feather sigma (px). The original-clothing region gets
 *  replaced with a flat neutral fill so gpt-image-1 can't see the
 *  user's actual garment pattern through its soft inpaint and bleed
 *  it through into the new garment (the bug Option A solves). A
 *  small Gaussian on the mask boundary keeps the skin/void transition
 *  from looking like a hard pixel cut. */
const GARMENT_VOID_FEATHER_SIGMA = 2;

/** Neutral fill color for the original-clothing region. Slightly
 *  lighter than the canvas (#909090) so the boundary reads as
 *  "clothing-shaped placeholder" rather than "background bleeding
 *  inward across the body silhouette." */
const GARMENT_VOID_RGB = { r: 0xB0, g: 0xB0, b: 0xB0 };

/** SegFormer classes whose pixels we wipe to GARMENT_VOID_RGB before
 *  storing the normalized PNG. These are the same classes the render
 *  route uses as the editable (transparent-in-mask) region, so the
 *  pixel we blank IS the region gpt-image-1 is about to repaint. */
const EDITABLE_CLOTHING_CLASSES = new Set<string>([
  "Upper-clothes",
  "Skirt",
  "Pants",
  "Dress",
  "Belt",
  "Scarf",
]);

/** Min person coverage to consider the input usable. < this = hard reject. */
const MIN_PERSON_COVERAGE_PCT = 3;

/** Per-component min coverage to count as a separate person in the
 *  multi-person check. < this is treated as noise (e.g. a reflection). */
const COMPONENT_MIN_COVERAGE_PCT = 5;

/** Feet considered "detected" when the bottom of the person bbox is
 *  this many px above the source image's bottom edge. If the bbox
 *  hugs the bottom, feet are presumed cropped. */
const FEET_GAP_PX = 10;

// SegFormer-B2 ATR class set. Everything except Background is part
// of the person. (Class list documented in src/lib/segmentClothing.ts.)
const PERSON_CLASSES = new Set<string>([
  "Hat",
  "Hair",
  "Sunglasses",
  "Upper-clothes",
  "Skirt",
  "Pants",
  "Dress",
  "Belt",
  "Left-shoe",
  "Right-shoe",
  "Face",
  "Left-leg",
  "Right-leg",
  "Left-arm",
  "Right-arm",
  "Bag",
  "Scarf",
]);
const HEAD_CLASSES = new Set<string>(["Face", "Hair"]);
const LEG_CLASSES = new Set<string>(["Left-leg", "Right-leg"]);

// ---- Types -----------------------------------------------------------------

export type NormalizationAnchor =
  | "head-to-feet"
  | "head-to-hip"
  | "head-size";

/**
 * Versioned geometry record stored on users.tryon_geometry. Phase C
 * (render reads pre-computed geometry) consumes this directly.
 */
export type TryonGeometry = {
  version: 1;
  canvas: { width: number; height: number; color: string };
  source: { width: number; height: number; aspect: number };
  anchor_used: NormalizationAnchor;
  scale: number;
  partial_body: boolean;
  source_bboxes: {
    person: Bbox;
    head: Bbox | null;
    legs: Bbox | null;
  };
  canvas_layout: {
    person_offset_x: number;
    person_offset_y: number;
    person_scaled_w: number;
    person_scaled_h: number;
    head_in_canvas: Bbox | null;
  };
};

export type NormalizationRejectReason = "no_person" | "multiple_people";

export type NormalizationResult =
  | {
      ok: true;
      pngBuffer: Buffer; // 1024x1536 PNG
      geometry: TryonGeometry;
    }
  | {
      ok: false;
      rejectReason: NormalizationRejectReason;
      detail: string;
    };

// ---- Main entry ------------------------------------------------------------

export async function normalizeTryonPhoto(
  photoBuffer: Buffer
): Promise<NormalizationResult> {
  const meta = await sharp(photoBuffer).metadata();
  const W0 = meta.width;
  const H0 = meta.height;
  if (!W0 || !H0) {
    return {
      ok: false,
      rejectReason: "no_person",
      detail: "Could not read photo dimensions.",
    };
  }
  const sourceTotal = W0 * H0;

  // 1. One SegFormer-B2 call. Returns all 18 ATR class masks.
  const classes = await callSegFormer(photoBuffer);

  // 2. Person mask (OR all non-Background classes).
  const personMerged = await orMergeClasses(
    classes,
    PERSON_CLASSES,
    W0,
    H0
  );
  if (!personMerged) {
    return {
      ok: false,
      rejectReason: "no_person",
      detail: "We couldn't find you in this photo. Try one with more contrast between you and the background.",
    };
  }
  const personMask = personMerged.merged;
  const personCoveragePct = (countPositive(personMask) / sourceTotal) * 100;
  if (personCoveragePct < MIN_PERSON_COVERAGE_PCT) {
    return {
      ok: false,
      rejectReason: "no_person",
      detail: `Person coverage ${personCoveragePct.toFixed(1)}% is below the ${MIN_PERSON_COVERAGE_PCT}% threshold; we couldn't isolate you cleanly.`,
    };
  }

  // 3. Multi-person check via flood-fill connected components on the
  //    person mask. Each component >= COMPONENT_MIN_COVERAGE_PCT counts
  //    as a separate person. >= 2 such components = hard reject.
  const significantComponents = countSignificantComponents(
    personMask,
    W0,
    H0,
    Math.ceil((sourceTotal * COMPONENT_MIN_COVERAGE_PCT) / 100)
  );
  if (significantComponents >= 2) {
    return {
      ok: false,
      rejectReason: "multiple_people",
      detail: `Detected ${significantComponents} people in the frame. Please upload a solo photo.`,
    };
  }

  // 4. Head + legs bboxes (sub-class masks).
  const headMerged = await orMergeClasses(classes, HEAD_CLASSES, W0, H0);
  const legsMerged = await orMergeClasses(classes, LEG_CLASSES, W0, H0);
  const personBbox = bboxFromMask(personMask, W0, H0);
  if (!personBbox) {
    return {
      ok: false,
      rejectReason: "no_person",
      detail: "Person mask returned no positive pixels.",
    };
  }
  const headBbox = headMerged ? bboxFromMask(headMerged.merged, W0, H0) : null;
  const legsBbox = legsMerged ? bboxFromMask(legsMerged.merged, W0, H0) : null;

  // Feet detected when the person bbox bottom sits >= FEET_GAP_PX
  // above the source's bottom edge. If it hugs the bottom, the feet
  // are presumed cropped.
  const feetDetected = personBbox.y + personBbox.h <= H0 - FEET_GAP_PX;

  // 5. Anchor ladder. Pick the most accurate scale anchor available.
  let anchor: NormalizationAnchor;
  let scale: number;
  if (feetDetected && headBbox) {
    anchor = "head-to-feet";
    scale = TARGET_PERSON_HEIGHT_PX / personBbox.h;
  } else if (legsBbox && headBbox) {
    // Top of the legs mask is approximately the hip.
    const hipY = legsBbox.y;
    const headTopY = headBbox.y;
    const headToHip = Math.max(1, hipY - headTopY);
    anchor = "head-to-hip";
    scale = TARGET_HEAD_TO_HIP_PX / headToHip;
  } else if (headBbox) {
    anchor = "head-size";
    scale = TARGET_HEAD_HEIGHT_PX / Math.max(1, headBbox.h);
  } else {
    // No face AND not even legs visible. Best we can do is fit the
    // person to the canvas height. Mark partial_body, anchor=head-size
    // since that's the most defensive default.
    anchor = "head-size";
    scale = (CANVAS_H * 0.8) / personBbox.h;
  }
  if (scale > MAX_LINEAR_UPSCALE) {
    scale = MAX_LINEAR_UPSCALE;
  }

  const scaledW = Math.max(1, Math.round(personBbox.w * scale));
  const scaledH = Math.max(1, Math.round(personBbox.h * scale));
  // Head top position relative to top of person bbox, scaled to canvas.
  const scaledHeadTopAbs = headBbox
    ? Math.round((headBbox.y - personBbox.y) * scale)
    : 0;
  // Anchor head top to y=100; center body horizontally on x=512.
  // Never clamp to keep the figure inside the canvas. A partial body
  // lands where it lands; the rest stays gray. Stretching to "fake
  // feet to the bottom" is exactly the artifact we're killing.
  const offsetX = Math.round(CANVAS_W / 2 - scaledW / 2);
  const offsetY = TARGET_HEAD_TOP_Y - scaledHeadTopAbs;

  // 6. Build the person RGBA (original RGB + feathered person alpha),
  //    crop to the person bbox, resize by scale, composite onto canvas.
  const featheredAlpha = await sharp(personMask, {
    raw: { width: W0, height: H0, channels: 1 },
  })
    .blur(CUTOUT_FEATHER_SIGMA)
    .extractChannel(0)
    .raw()
    .toBuffer();

  // 6b. Original-garment neutralization (Option A from the seam-bleed
  //     diagnosis). gpt-image-1's inpaint is soft — when the masked
  //     region in image[0] contains a strong existing pattern, the
  //     model paints the new garment semi-translucently over it,
  //     producing the "blue lace top bleeds through the white dress"
  //     artifact. Fix: replace the original-clothing region in the
  //     STORED normalized PNG with a flat neutral fill, before any
  //     render fires. The render code is unchanged; the image it
  //     points at just has nothing to bleed.
  //
  //     The editable-clothing mask comes from the same SegFormer
  //     response (no extra inference). Feather it by sigma=2 so the
  //     skin-to-void boundary reads as a soft clothing line rather
  //     than a hard pixel cut.
  const garmentMerged = await orMergeClasses(
    classes,
    EDITABLE_CLOTHING_CLASSES,
    W0,
    H0
  );
  const garmentAlpha = garmentMerged
    ? await sharp(garmentMerged.merged, {
        raw: { width: W0, height: H0, channels: 1 },
      })
        .blur(GARMENT_VOID_FEATHER_SIGMA)
        .extractChannel(0)
        .raw()
        .toBuffer()
    : null;

  const { data: rgb0, info: info0 } = await sharp(photoBuffer)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info0.channels !== 3 || rgb0.length !== sourceTotal * 3) {
    throw new Error(
      `normalizeTryonPhoto: original RGB unexpected shape ${rgb0.length} ch=${info0.channels}`
    );
  }

  const personRgba = Buffer.alloc(sourceTotal * 4);
  for (let i = 0; i < sourceTotal; i++) {
    let r = rgb0[i * 3];
    let g = rgb0[i * 3 + 1];
    let b = rgb0[i * 3 + 2];
    // Blend in neutral fill where the editable-clothing mask is
    // positive. Alpha is the feathered garment-mask value normalized
    // to [0, 1]. Skin/hair/leg/arm pixels have garmentAlpha=0 and
    // pass through unchanged; deep-garment-interior pixels have
    // garmentAlpha=255 and become pure neutral; the boundary band
    // smoothly fades.
    if (garmentAlpha) {
      const gAlpha = garmentAlpha[i] / 255;
      if (gAlpha > 0) {
        const inv = 1 - gAlpha;
        r = Math.round(GARMENT_VOID_RGB.r * gAlpha + r * inv);
        g = Math.round(GARMENT_VOID_RGB.g * gAlpha + g * inv);
        b = Math.round(GARMENT_VOID_RGB.b * gAlpha + b * inv);
      }
    }
    const off = i * 4;
    personRgba[off] = r;
    personRgba[off + 1] = g;
    personRgba[off + 2] = b;
    personRgba[off + 3] = featheredAlpha[i];
  }
  const personCutoutScaled = await sharp(personRgba, {
    raw: { width: W0, height: H0, channels: 4 },
  })
    .extract({
      left: personBbox.x,
      top: personBbox.y,
      width: personBbox.w,
      height: personBbox.h,
    })
    .resize({ width: scaledW, height: scaledH, fit: "fill" })
    .png()
    .toBuffer();

  const pngBuffer = await sharp({
    create: {
      width: CANVAS_W,
      height: CANVAS_H,
      channels: 3,
      background: CANVAS_COLOR,
    },
  })
    .composite([
      {
        input: personCutoutScaled,
        left: offsetX,
        top: offsetY,
        blend: "over",
      },
    ])
    .png()
    .toBuffer();

  const headInCanvas: Bbox | null = headBbox
    ? {
        x: offsetX + Math.round((headBbox.x - personBbox.x) * scale),
        y: offsetY + Math.round((headBbox.y - personBbox.y) * scale),
        w: Math.round(headBbox.w * scale),
        h: Math.round(headBbox.h * scale),
      }
    : null;

  const geometry: TryonGeometry = {
    version: 1,
    canvas: { width: CANVAS_W, height: CANVAS_H, color: CANVAS_COLOR },
    source: {
      width: W0,
      height: H0,
      aspect: +(W0 / H0).toFixed(3),
    },
    anchor_used: anchor,
    scale: +scale.toFixed(4),
    partial_body: !feetDetected,
    source_bboxes: {
      person: personBbox,
      head: headBbox,
      legs: legsBbox,
    },
    canvas_layout: {
      person_offset_x: offsetX,
      person_offset_y: offsetY,
      person_scaled_w: scaledW,
      person_scaled_h: scaledH,
      head_in_canvas: headInCanvas,
    },
  };

  return { ok: true, pngBuffer, geometry };
}

// ---- Connected components for multi-person detection ----------------------

/**
 * Count connected components in the binary mask whose area is >=
 * `minPixels`. Used as a cheap multi-person check on the person mask.
 *
 * Iterative flood-fill (not recursive — recursion blows the stack on
 * a full-resolution photo). 4-connected neighborhood; we don't need
 * diagonals.
 */
function countSignificantComponents(
  mask: Buffer,
  width: number,
  height: number,
  minPixels: number
): number {
  const total = width * height;
  const visited = new Uint8Array(total);
  let bigComponentCount = 0;
  const stack: number[] = [];
  for (let i = 0; i < total; i++) {
    if (visited[i] || mask[i] <= 127) continue;
    // BFS/DFS flood-fill from i, counting area.
    let area = 0;
    stack.length = 0;
    stack.push(i);
    visited[i] = 1;
    while (stack.length > 0) {
      const p = stack.pop() as number;
      area++;
      const x = p % width;
      const y = (p - x) / width;
      // 4-neighbors
      if (x > 0) {
        const n = p - 1;
        if (!visited[n] && mask[n] > 127) {
          visited[n] = 1;
          stack.push(n);
        }
      }
      if (x < width - 1) {
        const n = p + 1;
        if (!visited[n] && mask[n] > 127) {
          visited[n] = 1;
          stack.push(n);
        }
      }
      if (y > 0) {
        const n = p - width;
        if (!visited[n] && mask[n] > 127) {
          visited[n] = 1;
          stack.push(n);
        }
      }
      if (y < height - 1) {
        const n = p + width;
        if (!visited[n] && mask[n] > 127) {
          visited[n] = 1;
          stack.push(n);
        }
      }
    }
    if (area >= minPixels) bigComponentCount++;
    // Early exit: if we've already found 2+, we know it's multi-person;
    // no need to scan the rest of the image.
    if (bigComponentCount >= 2) return bigComponentCount;
  }
  return bigComponentCount;
}
