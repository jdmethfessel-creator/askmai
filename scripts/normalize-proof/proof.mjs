#!/usr/bin/env node
/**
 * One-image proof for the input-normalization design.
 *
 * BEFORE building the full Phase A pipeline, this script manually runs
 * a single photo through the proposed normalization (SegFormer person
 * mask -> mid-gray canvas -> scale/center to canonical layout) and
 * then through gpt-image-1 with one garment, so JD can eyeball whether
 * the architecture actually moves the needle on render quality.
 *
 * NOT a production code path. Writes everything to disk at
 * scripts/normalize-proof/output/ for visual inspection.
 *
 * Usage:
 *   node --env-file=.env.local scripts/normalize-proof/proof.mjs
 *
 * Optional flags:
 *   --user-email <email>   default: jd.methfessel@gmail.com
 *   --garment-url <url>    default: Cass's Magda Butrym red dress
 *   --canvas-color <hex>   default: #909090 (mid-neutral gray per design)
 *   --skip-render          stop after writing the normalized intermediate;
 *                          don't call gpt-image-1 (saves ~$0.063, useful
 *                          for iterating on the segmentation+scale math
 *                          without burning credits)
 *
 * Required env (.env.local or process env):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY    (to download user's photo)
 *   HF_API_TOKEN                 (SegFormer-B2 call)
 *   OPENAI_API_KEY               (gpt-image-1; not needed with --skip-render)
 *
 * Cost per run: ~$0.001 segmentation + ~$0.063 render = ~$0.064.
 *
 * Output files (scripts/normalize-proof/output/):
 *   01-original.jpg          the stored photo, byte-identical
 *   02-person-mask.png       binary person mask (white = person)
 *   03-normalized.png        the final 1024x1536 canvas fed to gpt-image-1
 *   04-geometry.json         head_bbox, person_bbox, anchor used, etc.
 *   05-render-normalized.png the gpt-image-1 output
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, "output");

// ---- Config ----------------------------------------------------------------

const CANVAS_W = 1024;
const CANVAS_H = 1536;

// Target person-height when feet ARE detected. 1350px = 87.9% of canvas
// height, leaving ~6.5% head room and ~5.6% floor room.
const TARGET_PERSON_HEIGHT_PX = 1350;

// Target head-to-hip when feet are NOT detected but legs ARE. 765px =
// 50% of canvas height (head at y=100, hip at y=865, body extends
// below the hip).
const TARGET_HEAD_TO_HIP_PX = 765;

// Target head height when ONLY the face is detected (waist-up crop /
// selfie). 215px = ~1/7 of canvas height per the classical figure
// rule (head ≈ 1/7 of full figure).
const TARGET_HEAD_HEIGHT_PX = 215;

// Anchor head top at this y in the canvas.
const TARGET_HEAD_TOP_Y = 100;

// Per-anchor cap on linear scale so a small input doesn't get blown
// up beyond the resolution it can support. Above this, mark
// partial_body so downstream code knows we're rendering a person who
// only partially fills the canvas at native resolution.
const MAX_LINEAR_UPSCALE = 4.0;

// Mid-neutral gray, per design (NORMALIZED_CANVAS_COLOR). Light blows
// out the body; black crushes it. ~#888-999 is the sweet spot.
const DEFAULT_CANVAS_COLOR = "#909090";

const SEGFORMER_URL =
  "https://router.huggingface.co/hf-inference/models/mattmdjaga/segformer_b2_clothes";

// SegFormer-B2 ATR-taxonomy classes. Everything except Background is
// part of the person; OR-merge for the person mask.
const PERSON_CLASSES = new Set([
  "Hat", "Hair", "Sunglasses", "Upper-clothes", "Skirt", "Pants",
  "Dress", "Belt", "Left-shoe", "Right-shoe", "Face",
  "Left-leg", "Right-leg", "Left-arm", "Right-arm", "Bag", "Scarf",
]);
const HEAD_CLASSES = new Set(["Face", "Hair"]);
const LEG_CLASSES = new Set(["Left-leg", "Right-leg"]);

const OPENAI_MODEL = "gpt-image-1";
const OPENAI_SIZE = "1024x1536";
const OPENAI_QUALITY = "medium";
const OPENAI_URL = "https://api.openai.com/v1/images/edits";
const RENDER_PROMPT =
  "A photorealistic image of the person from the first image, wearing the clothing shown in the reference image(s). Match the references' color, pattern, fabric, and cut as closely as possible. Natural fit and draping. The image stays non-sexual and the person stays fully clothed.";

// Cass's Magda Butrym Sleeveless Mini Dress in red. Pulled from
// creator_products earlier; URL is stable on the FWRD CDN. Clean
// single-garment catalog shot, good test case for "does the model
// drape one item on the figure properly."
const DEFAULT_GARMENT_URL =
  "https://is4.fwrdassets.com/images/p/fw/p/MAGF-WD125_V1.jpg";

// ---- Args + env ------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const userEmail = args["user-email"] || "jd.methfessel@gmail.com";
const garmentUrl = args["garment-url"] || DEFAULT_GARMENT_URL;
const canvasColor = args["canvas-color"] || DEFAULT_CANVAS_COLOR;
const skipRender = !!args["skip-render"];

requireEnv("NEXT_PUBLIC_SUPABASE_URL");
requireEnv("SUPABASE_SERVICE_ROLE_KEY");
requireEnv("HF_API_TOKEN");
if (!skipRender) requireEnv("OPENAI_API_KEY");

await mkdir(OUTPUT_DIR, { recursive: true });

console.log("================================================================");
console.log("  INPUT NORMALIZATION ONE-IMAGE PROOF");
console.log("================================================================");
console.log(`  user:          ${userEmail}`);
console.log(`  garment:       ${garmentUrl}`);
console.log(`  canvas color:  ${canvasColor}`);
console.log(`  canvas size:   ${CANVAS_W}x${CANVAS_H}`);
console.log(`  output dir:    ${OUTPUT_DIR}`);
console.log(`  render:        ${skipRender ? "SKIPPED" : "yes (gpt-image-1 medium)"}`);
console.log();

// ---- 1. Pull the user's stored photo --------------------------------------

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);
const userRow = await sb
  .from("users")
  .select("id, tryon_photo_path")
  .eq("email", userEmail)
  .maybeSingle();
if (userRow.error || !userRow.data) {
  fail(`user lookup failed: ${userRow.error?.message ?? "not found"}`);
}
if (!userRow.data.tryon_photo_path) {
  fail(`user ${userEmail} has no tryon_photo_path set`);
}
console.log(`[1/5] pulling photo from tryon-photos/${userRow.data.tryon_photo_path}`);
const dl = await sb.storage
  .from("tryon-photos")
  .download(userRow.data.tryon_photo_path);
if (dl.error) fail(`download failed: ${dl.error.message}`);
const original = Buffer.from(await dl.data.arrayBuffer());
await writeFile(join(OUTPUT_DIR, "01-original.jpg"), original);
const origMeta = await sharp(original).metadata();
console.log(`      ${origMeta.format} ${origMeta.width}x${origMeta.height}  ${(original.length/1024).toFixed(1)} KB  aspect=${(origMeta.width/origMeta.height).toFixed(3)}`);

// ---- 2. SegFormer-B2 segmentation -----------------------------------------

console.log(`[2/5] calling SegFormer-B2 on hf-inference router…`);
const t0 = Date.now();
const classes = await callSegFormer(original);
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`      ${classes.length} class masks returned in ${elapsed}s`);
console.log(`      classes present: ${classes.map((c) => c.label).join(", ")}`);

// Build the masks we care about (person, head, legs). All sized to the
// ORIGINAL photo's dimensions; we'll resize in step 3 when we pick a
// scale factor.
const W0 = origMeta.width;
const H0 = origMeta.height;
const personMaskRaw = await orMergeClasses(classes, PERSON_CLASSES, W0, H0);
const headMaskRaw = await orMergeClasses(classes, HEAD_CLASSES, W0, H0);
const legsMaskRaw = await orMergeClasses(classes, LEG_CLASSES, W0, H0);
if (!personMaskRaw) fail("SegFormer returned no person classes");
await writeFile(
  join(OUTPUT_DIR, "02-person-mask.png"),
  await sharp(personMaskRaw, { raw: { width: W0, height: H0, channels: 1 } }).png().toBuffer()
);

const personCoveragePct = countPositive(personMaskRaw) / (W0 * H0) * 100;
console.log(`      person mask coverage: ${personCoveragePct.toFixed(1)}% of source`);
if (personCoveragePct < 3) {
  fail(`HARD REJECT: person coverage <3% (no person detected). Pick a different photo.`);
}
// Multi-person check would go here for the real implementation
// (connected components in personMaskRaw); skipping for the proof.

// ---- 3. Anchor-ladder scale + position ------------------------------------

const personBbox = bboxOf(personMaskRaw, W0, H0);
const headBbox = headMaskRaw ? bboxOf(headMaskRaw, W0, H0) : null;
const legsBbox = legsMaskRaw ? bboxOf(legsMaskRaw, W0, H0) : null;

// Feet detected? Person bbox bottom is at least 10px above the source's
// bottom edge. (If it's at the very bottom, the person is likely cropped.)
const FEET_GAP_PX = 10;
const feetDetected = personBbox.y + personBbox.h <= H0 - FEET_GAP_PX;

let anchor, scale;
if (feetDetected && headBbox) {
  // A: head-to-feet
  scale = TARGET_PERSON_HEIGHT_PX / personBbox.h;
  anchor = "head-to-feet";
} else if (legsBbox && headBbox) {
  // B: head-to-hip (top of legs ≈ hip)
  const hipY = legsBbox.y;
  const headTopY = headBbox.y;
  scale = TARGET_HEAD_TO_HIP_PX / Math.max(1, hipY - headTopY);
  anchor = "head-to-hip";
} else if (headBbox) {
  // C: head-size only
  scale = TARGET_HEAD_HEIGHT_PX / Math.max(1, headBbox.h);
  anchor = "head-size";
} else {
  fail("HARD REJECT: no face detected in input photo");
}

if (scale > MAX_LINEAR_UPSCALE) {
  console.log(`      warn: anchor ${anchor} suggests scale=${scale.toFixed(2)}, clamping to ${MAX_LINEAR_UPSCALE}`);
  scale = MAX_LINEAR_UPSCALE;
}

const scaledW = Math.round(personBbox.w * scale);
const scaledH = Math.round(personBbox.h * scale);
const scaledHeadTopAbs = headBbox ? Math.round((headBbox.y - personBbox.y) * scale) : 0;
// Position so head top lands at TARGET_HEAD_TOP_Y in canvas; center horizontally.
// personCenterX (relative to crop): personBbox.w / 2
const offsetX = Math.round(CANVAS_W / 2 - scaledW / 2);
const offsetY = TARGET_HEAD_TOP_Y - scaledHeadTopAbs;

const partialBody = !feetDetected;

console.log(`[3/5] anchor=${anchor}  scale=${scale.toFixed(3)}  partial_body=${partialBody}`);
console.log(`      person bbox in source:  x=${personBbox.x} y=${personBbox.y} w=${personBbox.w} h=${personBbox.h}`);
if (headBbox) console.log(`      head bbox in source:    x=${headBbox.x} y=${headBbox.y} w=${headBbox.w} h=${headBbox.h}`);
if (legsBbox) console.log(`      legs bbox in source:    x=${legsBbox.x} y=${legsBbox.y} w=${legsBbox.w} h=${legsBbox.h}`);
console.log(`      scaled person size:     ${scaledW}x${scaledH}`);
console.log(`      canvas offset:          x=${offsetX} y=${offsetY}`);

// Build the person-only RGBA (RGB from original, alpha from feathered person mask)
// then resize and composite onto the mid-gray canvas.
const featheredMask = await sharp(personMaskRaw, { raw: { width: W0, height: H0, channels: 1 } })
  .blur(3)
  .extractChannel(0)
  .raw()
  .toBuffer();
const { data: rgb0, info: info0 } = await sharp(original)
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
if (info0.channels !== 3) fail(`unexpected original channel count: ${info0.channels}`);
const personRgba = Buffer.alloc(W0 * H0 * 4);
for (let i = 0; i < W0 * H0; i++) {
  const b = i * 4;
  personRgba[b]     = rgb0[i * 3];
  personRgba[b + 1] = rgb0[i * 3 + 1];
  personRgba[b + 2] = rgb0[i * 3 + 2];
  personRgba[b + 3] = featheredMask[i];
}
// Crop to person bbox, scale, then composite onto canvas at offset.
const cropped = await sharp(personRgba, { raw: { width: W0, height: H0, channels: 4 } })
  .extract({ left: personBbox.x, top: personBbox.y, width: personBbox.w, height: personBbox.h })
  .resize({ width: scaledW, height: scaledH, fit: "fill" })
  .png()
  .toBuffer();
const canvas = await sharp({
  create: {
    width: CANVAS_W,
    height: CANVAS_H,
    channels: 3,
    background: canvasColor,
  },
})
  .composite([{ input: cropped, left: offsetX, top: offsetY, blend: "over" }])
  .png()
  .toBuffer();
await writeFile(join(OUTPUT_DIR, "03-normalized.png"), canvas);
console.log(`      wrote 03-normalized.png  (${(canvas.length / 1024).toFixed(1)} KB)`);

// ---- 4. Geometry JSON -----------------------------------------------------

const geometry = {
  version: 1,
  user_email: userEmail,
  source: { width: W0, height: H0, aspect: +(W0 / H0).toFixed(3) },
  canvas: { width: CANVAS_W, height: CANVAS_H, color: canvasColor },
  anchor_used: anchor,
  scale: +scale.toFixed(4),
  partial_body: partialBody,
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
    head_in_canvas: headBbox
      ? {
          x: offsetX + Math.round((headBbox.x - personBbox.x) * scale),
          y: offsetY + Math.round((headBbox.y - personBbox.y) * scale),
          w: Math.round(headBbox.w * scale),
          h: Math.round(headBbox.h * scale),
        }
      : null,
  },
};
await writeFile(
  join(OUTPUT_DIR, "04-geometry.json"),
  JSON.stringify(geometry, null, 2)
);
console.log("[4/5] wrote 04-geometry.json");

// ---- 5. gpt-image-1 render ------------------------------------------------

if (skipRender) {
  console.log("[5/5] SKIPPED (--skip-render). Inspect 03-normalized.png to validate the segmentation+scale before paying for the OpenAI call.");
  process.exit(0);
}

// Build a clothing mask from the existing EDITABLE_CLASSES, scaled to
// the canvas, in OpenAI's RGBA-with-transparent-editable shape.
const EDITABLE_CLASSES = new Set([
  "Upper-clothes", "Skirt", "Pants", "Dress", "Belt", "Scarf",
]);
const editableMaskSrc = await orMergeClasses(classes, EDITABLE_CLASSES, W0, H0);
if (!editableMaskSrc) fail("no editable clothing classes detected; the mask would be empty");

// Resize + composite the editable mask in the same layout we used for the person.
const editableScaled = await sharp(editableMaskSrc, { raw: { width: W0, height: H0, channels: 1 } })
  .extract({ left: personBbox.x, top: personBbox.y, width: personBbox.w, height: personBbox.h })
  .resize({ width: scaledW, height: scaledH, fit: "fill" })
  .raw()
  .toBuffer();
// Place onto a canvas-sized 1-channel buffer at the same offset.
const maskCanvas = Buffer.alloc(CANVAS_W * CANVAS_H);
for (let y = 0; y < scaledH; y++) {
  for (let x = 0; x < scaledW; x++) {
    const cx = offsetX + x;
    const cy = offsetY + y;
    if (cx < 0 || cx >= CANVAS_W || cy < 0 || cy >= CANVAS_H) continue;
    maskCanvas[cy * CANVAS_W + cx] = editableScaled[y * scaledW + x];
  }
}
// OpenAI mask: RGBA, transparent (alpha=0) over editable, opaque (alpha=255) elsewhere.
const maskRgba = Buffer.alloc(CANVAS_W * CANVAS_H * 4);
for (let i = 0; i < CANVAS_W * CANVAS_H; i++) {
  const b = i * 4;
  maskRgba[b]     = 255;
  maskRgba[b + 1] = 255;
  maskRgba[b + 2] = 255;
  maskRgba[b + 3] = maskCanvas[i] > 127 ? 0 : 255;
}
const maskPng = await sharp(maskRgba, {
  raw: { width: CANVAS_W, height: CANVAS_H, channels: 4 },
})
  .png()
  .toBuffer();

console.log(`[5/5] fetching garment & calling gpt-image-1 (${OPENAI_MODEL}, ${OPENAI_QUALITY} quality, ${OPENAI_SIZE})…`);
const garmentResp = await fetch(garmentUrl);
if (!garmentResp.ok) fail(`garment fetch HTTP ${garmentResp.status}: ${garmentUrl}`);
const garmentBuf = Buffer.from(await garmentResp.arrayBuffer());

const form = new FormData();
form.append("model", OPENAI_MODEL);
form.append("prompt", RENDER_PROMPT);
form.append("size", OPENAI_SIZE);
form.append("quality", OPENAI_QUALITY);
form.append("n", "1");
form.append(
  "image[]",
  new Blob([new Uint8Array(canvas)], { type: "image/png" }),
  "person.png"
);
form.append(
  "image[]",
  new Blob([new Uint8Array(garmentBuf)], { type: "image/jpeg" }),
  "garment.jpg"
);
form.append(
  "mask",
  new Blob([new Uint8Array(maskPng)], { type: "image/png" }),
  "mask.png"
);

const t1 = Date.now();
const openaiResp = await fetch(OPENAI_URL, {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
  body: form,
  signal: AbortSignal.timeout(250_000),
});
const renderElapsed = ((Date.now() - t1) / 1000).toFixed(1);
if (!openaiResp.ok) {
  const errText = await openaiResp.text().catch(() => "");
  fail(`gpt-image-1 HTTP ${openaiResp.status} after ${renderElapsed}s: ${errText.slice(0, 400)}`);
}
const json = await openaiResp.json();
const b64 = json?.data?.[0]?.b64_json;
if (!b64) fail("gpt-image-1 returned no image data");
const renderBuf = Buffer.from(b64, "base64");
await writeFile(join(OUTPUT_DIR, "05-render-normalized.png"), renderBuf);
console.log(`      gpt-image-1 returned in ${renderElapsed}s, wrote 05-render-normalized.png (${(renderBuf.length / 1024).toFixed(1)} KB)`);

console.log();
console.log("================================================================");
console.log("  DONE. Eyeball the output:");
console.log(`    ${join(OUTPUT_DIR, "03-normalized.png")}   <- input to model`);
console.log(`    ${join(OUTPUT_DIR, "05-render-normalized.png")} <- model output`);
console.log("  Acceptance:");
console.log("    - No hallucinated scene background?");
console.log("    - Body proportions match the original?");
console.log("    - Garment lands on the figure without weird drape?");
console.log("    - Face visibly recognizable?");
console.log("  If YES on all 4 -> greenlight Phase A.");
console.log("  If NO on any   -> architecture revisit before more code.");
console.log("================================================================");

// ---- helpers --------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}
function requireEnv(name) {
  if (!process.env[name]) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
}
function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

async function callSegFormer(photoBuffer) {
  const res = await fetch(SEGFORMER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.HF_API_TOKEN}`,
      "Content-Type": "application/octet-stream",
    },
    body: new Uint8Array(photoBuffer),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`SegFormer HTTP ${res.status}: ${txt.slice(0, 400)}`);
  }
  return res.json();
}

async function orMergeClasses(classes, wantedSet, width, height) {
  const wanted = classes.filter((c) => wantedSet.has(c.label) && c.mask);
  if (wanted.length === 0) return null;
  const expectedLen = width * height;
  let merged = null;
  for (const c of wanted) {
    const classMaskRaw = Buffer.from(c.mask, "base64");
    const flat = await sharp(classMaskRaw)
      .resize({ width, height, fit: "fill" })
      .greyscale()
      .extractChannel(0)
      .raw()
      .toBuffer();
    if (flat.length !== expectedLen) {
      throw new Error(
        `orMergeClasses: class ${c.label} produced ${flat.length} vs expected ${expectedLen}`
      );
    }
    if (!merged) {
      merged = Buffer.from(flat);
    } else {
      for (let i = 0; i < expectedLen; i++) {
        if (flat[i] > merged[i]) merged[i] = flat[i];
      }
    }
  }
  return merged;
}

function countPositive(mask) {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] > 127) n++;
  return n;
}

function bboxOf(mask, w, h) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (mask[row + x] > 127) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
