/**
 * Local end-to-end test for the inpaint render pipeline.
 *
 * Pulls jd.methfessel@gmail.com's actual try-on photo from Supabase,
 * picks the first Madison fashion item with an image_url, runs the
 * SegFormer → gpt-image-1 → head-composite → branding pipeline, and
 * writes the result + every intermediate buffer to /tmp/ so we can
 * eyeball the alignment and seam quality before committing the
 * code change to main.
 *
 * Requires in .env.local:
 *   OPENAI_API_KEY
 *   HF_API_TOKEN
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Run:
 *   node --env-file=.env.local scripts/test-inpaint-render.mjs
 *
 * Writes to /tmp/inpaint-test/:
 *   00-source-photo.<ext>          original Supabase download
 *   01-normalized-person.png       1024x1536 contain-fit
 *   02-editable-mask.png           OpenAI mask (clothing transparent)
 *   03-head-mask-raw.png           SegFormer Face+Hair binary
 *   04-product-ref.<ext>           product reference fetched
 *   05-openai-raw.png              gpt-image-1 output, pre-composite
 *   06-feathered-overlay.png       input photo + blurred head alpha
 *   07-after-composite.png         after head composite, pre-branding
 *   08-final.png                   final render (post-branding)
 *   manifest.json                  bboxes, alignment decision, etc.
 *
 * The script intentionally duplicates the runRender flow from
 * src/lib/render.ts so it works without dynamic-import / Next.js
 * runtime quirks. The OpenAI call and the SegFormer call are
 * byte-identical to the production path.
 */

import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const OUT_DIR = "/tmp/inpaint-test";
const TARGET_W = 1024;
const TARGET_H = 1536;
const OPENAI_MODEL = "gpt-image-1";
const OPENAI_SIZE = "1024x1536";
const OPENAI_QUALITY = "medium";
const SEGFORMER_URL =
  "https://router.huggingface.co/hf-inference/models/mattmdjaga/segformer_b2_clothes";
const EDITABLE_CLASSES = new Set([
  "Upper-clothes",
  "Skirt",
  "Pants",
  "Dress",
  "Belt",
  "Scarf",
]);
const HEAD_CLASSES = new Set(["Face", "Hair"]);
const PROMPT =
  "A photorealistic image of the person from the first image, wearing the clothing shown in the reference image(s). Match the references' color, pattern, fabric, and cut as closely as possible. Natural fit and draping. The image stays non-sexual and the person stays fully clothed.";

function need(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`ERROR: ${name} not set in .env.local`);
    process.exit(1);
  }
  return v.trim();
}

function readBboxFromBinary(raw, width, height) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
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
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

async function orMergeClasses(classes, wantedSet, width, height) {
  const wanted = classes.filter(
    (c) => typeof c.label === "string" && wantedSet.has(c.label) && c.mask
  );
  if (wanted.length === 0) return null;
  let merged = null;
  const used = [];
  for (const c of wanted) {
    const flat = await sharp(Buffer.from(c.mask, "base64"))
      .resize({ width, height, fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer();
    if (!merged) merged = Buffer.from(flat);
    else for (let i = 0; i < merged.length; i++) if (flat[i] > merged[i]) merged[i] = flat[i];
    used.push(c.label);
  }
  return { merged, used };
}

async function callSegFormer(token, buffer) {
  const resp = await fetch(SEGFORMER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
    },
    body: new Uint8Array(buffer),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`segformer ${resp.status}: ${text.slice(0, 300)}`);
  }
  return resp.json();
}

async function main() {
  const OPENAI_API_KEY = need("OPENAI_API_KEY");
  const HF_API_TOKEN = need("HF_API_TOKEN");
  const SUPABASE_URL = need("NEXT_PUBLIC_SUPABASE_URL");
  const SUPABASE_KEY = need("SUPABASE_SERVICE_ROLE_KEY");

  await mkdir(OUT_DIR, { recursive: true });

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. Find jd's user + tryon_photo_path.
  const userRow = await sb
    .from("users")
    .select("id, email, tryon_photo_path")
    .eq("email", "jd.methfessel@gmail.com")
    .maybeSingle();
  if (userRow.error || !userRow.data) {
    console.error("could not find jd user row:", userRow.error?.message);
    process.exit(2);
  }
  const photoPath = userRow.data.tryon_photo_path;
  if (!photoPath) {
    console.error("user has no tryon_photo_path; upload a photo first");
    process.exit(2);
  }
  console.log("user.id =", userRow.data.id);
  console.log("user.tryon_photo_path =", photoPath);

  // 2. Download the photo.
  const dl = await sb.storage.from("tryon-photos").download(photoPath);
  if (dl.error || !dl.data) {
    console.error("photo download failed:", dl.error?.message);
    process.exit(2);
  }
  const photoBytes = Buffer.from(await dl.data.arrayBuffer());
  const photoMime = dl.data.type || "image/jpeg";
  const sourceExt =
    photoMime.includes("png") ? "png" :
    photoMime.includes("webp") ? "webp" : "jpg";
  await writeFile(join(OUT_DIR, `00-source-photo.${sourceExt}`), photoBytes);
  console.log("source photo:", photoBytes.length, "bytes,", photoMime);

  // 3. Normalize to 1024x1536, contain-fit, neutral pad.
  const normalized = await sharp(photoBytes)
    .resize({
      width: TARGET_W,
      height: TARGET_H,
      fit: "contain",
      background: { r: 245, g: 245, b: 245, alpha: 1 },
    })
    .png()
    .toBuffer();
  await writeFile(join(OUT_DIR, "01-normalized-person.png"), normalized);
  console.log("normalized to 1024x1536");

  // 4. Pick a Madison fashion item.
  const item = await sb
    .from("products")
    .select("id, name, brand, category, price, image_url")
    .eq("creator_id", "629db2be-2a72-4430-a001-55985bde14a3")
    .eq("category", "fashion")
    .not("image_url", "is", null)
    .limit(20);
  if (item.error || !item.data?.length) {
    console.error("no fashion item with image_url found");
    process.exit(2);
  }
  // Prefer Reformation Balia Linen Dress if present (the Miami $400 demo item)
  const balia = item.data.find((p) => /balia/i.test(p.name || ""));
  const picked = balia ?? item.data[0];
  console.log("picked item:", picked.brand, "—", picked.name, "$" + picked.price);
  console.log("item image_url:", picked.image_url);

  // 5. Fetch the product reference image.
  const refResp = await fetch(picked.image_url, {
    headers: { "User-Agent": "Mozilla/5.0 askmai-test" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!refResp.ok) {
    console.error("ref image fetch failed:", refResp.status);
    process.exit(2);
  }
  const refCt = (refResp.headers.get("content-type") ?? "").toLowerCase();
  const refMime = refCt.includes("png") ? "image/png" :
                  refCt.includes("webp") ? "image/webp" : "image/jpeg";
  const refExt = refMime.includes("png") ? "png" :
                 refMime.includes("webp") ? "webp" : "jpg";
  const refBytes = Buffer.from(await refResp.arrayBuffer());
  await writeFile(join(OUT_DIR, `04-product-ref.${refExt}`), refBytes);
  console.log("product ref fetched:", refBytes.length, "bytes");

  // 6. SegFormer on the normalized input.
  console.log("\n--- SegFormer (input) ---");
  const inputClasses = await callSegFormer(HF_API_TOKEN, normalized);
  const editable = await orMergeClasses(inputClasses, EDITABLE_CLASSES, TARGET_W, TARGET_H);
  if (!editable) {
    console.error("no clothing classes detected in input");
    process.exit(2);
  }
  const head = await orMergeClasses(inputClasses, HEAD_CLASSES, TARGET_W, TARGET_H);
  const inputHeadBbox = head ? readBboxFromBinary(head.merged, TARGET_W, TARGET_H) : null;
  console.log("editable classes:", editable.used.join(","));
  console.log("head classes:", head?.used.join(",") ?? "(none)");
  console.log("input head bbox:", inputHeadBbox);

  // Save editable mask (RGBA, alpha=0 over clothing).
  const totalPx = TARGET_W * TARGET_H;
  const editableRgba = Buffer.alloc(totalPx * 4);
  for (let i = 0; i < totalPx; i++) {
    const isEditable = editable.merged[i] > 127;
    const b = i * 4;
    editableRgba[b] = 255; editableRgba[b+1] = 255; editableRgba[b+2] = 255;
    editableRgba[b+3] = isEditable ? 0 : 255;
  }
  const editableMaskPng = await sharp(editableRgba, {
    raw: { width: TARGET_W, height: TARGET_H, channels: 4 },
  }).png().toBuffer();
  await writeFile(join(OUT_DIR, "02-editable-mask.png"), editableMaskPng);

  // Save head mask as a visualization PNG (grayscale).
  const headRaw = head?.merged ?? Buffer.alloc(totalPx);
  const headViz = await sharp(headRaw, {
    raw: { width: TARGET_W, height: TARGET_H, channels: 1 },
  }).png().toBuffer();
  await writeFile(join(OUT_DIR, "03-head-mask-raw.png"), headViz);

  // 7. Call gpt-image-1 with the editable mask.
  console.log("\n--- gpt-image-1 /v1/images/edits ---");
  const form = new FormData();
  form.append("model", OPENAI_MODEL);
  form.append("prompt", PROMPT);
  form.append("size", OPENAI_SIZE);
  form.append("quality", OPENAI_QUALITY);
  form.append("n", "1");
  form.append("image[]", new Blob([new Uint8Array(normalized)], { type: "image/png" }), "person.png");
  form.append("image[]", new Blob([new Uint8Array(refBytes)], { type: refMime }), `item-0.${refExt}`);
  form.append("mask", new Blob([new Uint8Array(editableMaskPng)], { type: "image/png" }), "mask.png");
  const t0 = Date.now();
  const openaiResp = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(250_000),
  });
  console.log("OpenAI response after", ((Date.now()-t0)/1000).toFixed(1), "s; status =", openaiResp.status);
  if (!openaiResp.ok) {
    const txt = await openaiResp.text().catch(() => "");
    console.error("OpenAI error:", txt.slice(0, 500));
    process.exit(3);
  }
  const openaiJson = await openaiResp.json();
  const b64 = openaiJson?.data?.[0]?.b64_json;
  if (!b64) {
    console.error("no b64 in OpenAI response");
    process.exit(3);
  }
  const openaiRaw = Buffer.from(b64, "base64");
  await writeFile(join(OUT_DIR, "05-openai-raw.png"), openaiRaw);
  console.log("openai output saved:", openaiRaw.length, "bytes");

  // 8. SegFormer on the OpenAI output to find the output head bbox.
  console.log("\n--- SegFormer (output) ---");
  const outClasses = await callSegFormer(HF_API_TOKEN, openaiRaw);
  const outHead = await orMergeClasses(outClasses, HEAD_CLASSES, TARGET_W, TARGET_H);
  const outputHeadBbox = outHead ? readBboxFromBinary(outHead.merged, TARGET_W, TARGET_H) : null;
  console.log("output head bbox:", outputHeadBbox);

  // 9. Alignment check.
  let aligned = false;
  let alignmentDetail = "";
  if (inputHeadBbox && outputHeadBbox) {
    const imageDimMax = Math.max(TARGET_W, TARGET_H);
    const inCx = inputHeadBbox.x + inputHeadBbox.w / 2;
    const inCy = inputHeadBbox.y + inputHeadBbox.h / 2;
    const outCx = outputHeadBbox.x + outputHeadBbox.w / 2;
    const outCy = outputHeadBbox.y + outputHeadBbox.h / 2;
    const centerShift = Math.hypot(inCx - outCx, inCy - outCy);
    const centerShiftPct = centerShift / imageDimMax;
    const inArea = Math.max(1, inputHeadBbox.w * inputHeadBbox.h);
    const outArea = Math.max(1, outputHeadBbox.w * outputHeadBbox.h);
    const areaRatio = Math.abs(inArea - outArea) / inArea;
    aligned = centerShiftPct <= 0.08 && areaRatio <= 0.3;
    alignmentDetail = `centerShiftPct=${(centerShiftPct*100).toFixed(2)}% (threshold 8%), areaRatio=${(areaRatio*100).toFixed(2)}% (threshold 30%)`;
    console.log("alignment:", alignmentDetail, "→", aligned ? "ALIGNED" : "MISALIGNED");
  } else {
    alignmentDetail = `input.head=${inputHeadBbox?"ok":"none"} output.head=${outputHeadBbox?"ok":"none"}`;
    console.log("alignment: cannot compute (", alignmentDetail, ")");
  }

  // 10. Head composite (when aligned).
  let composited = openaiRaw;
  if (aligned && head) {
    console.log("\n--- head composite ---");
    const featheredAlpha = await sharp(head.merged, {
      raw: { width: TARGET_W, height: TARGET_H, channels: 1 },
    }).blur(8).raw().toBuffer();
    const rgbObj = await sharp(normalized).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const overlay = Buffer.alloc(totalPx * 4);
    for (let i = 0; i < totalPx; i++) {
      const b = i * 4;
      overlay[b]   = rgbObj.data[i*3];
      overlay[b+1] = rgbObj.data[i*3+1];
      overlay[b+2] = rgbObj.data[i*3+2];
      overlay[b+3] = featheredAlpha[i];
    }
    const overlayPng = await sharp(overlay, {
      raw: { width: TARGET_W, height: TARGET_H, channels: 4 },
    }).png().toBuffer();
    await writeFile(join(OUT_DIR, "06-feathered-overlay.png"), overlayPng);

    composited = await sharp(openaiRaw)
      .composite([{ input: overlayPng, top: 0, left: 0, blend: "over" }])
      .png()
      .toBuffer();
    await writeFile(join(OUT_DIR, "07-after-composite.png"), composited);
    console.log("composite applied");
  } else {
    console.log("composite SKIPPED:", aligned ? "(aligned but no head mask)" : "(misaligned or null bbox)");
  }

  // 11. Branding overlay.
  console.log("\n--- branding overlay ---");
  const WORDMARK = await sharp("src/lib/render-assets/wordmark-askmai.png")
    .resize({ width: Math.round(TARGET_W * 0.13) })
    .png().toBuffer();
  const URL_PNG = await sharp("src/lib/render-assets/url-askmai-co.png")
    .resize({ width: Math.round(TARGET_W * 0.17) })
    .png().toBuffer();
  const wmm = await sharp(WORDMARK).metadata();
  const um = await sharp(URL_PNG).metadata();
  const padX = Math.round(TARGET_W * 0.022);
  const padY = Math.round(TARGET_W * 0.008);
  const tW = wmm.width + padX*2, tH = wmm.height + padY*2;
  const bW = um.width + padX*2, bH = um.height + padY*2;
  const edge = Math.round(TARGET_H * 0.018);
  function pill(w, h) {
    const r = Math.round(h/2);
    return Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect x="0" y="0" width="${w}" height="${h}" rx="${r}" ry="${r}" fill="black" fill-opacity="0.22"/></svg>`
    );
  }
  const final = await sharp(composited)
    .composite([
      { input: pill(tW,tH), top: edge, left: Math.round((TARGET_W-tW)/2) },
      { input: WORDMARK, top: edge+padY, left: Math.round((TARGET_W-wmm.width)/2) },
      { input: pill(bW,bH), top: TARGET_H-bH-edge, left: Math.round((TARGET_W-bW)/2) },
      { input: URL_PNG, top: TARGET_H-bH-edge+padY, left: Math.round((TARGET_W-um.width)/2) },
    ])
    .png()
    .toBuffer();
  await writeFile(join(OUT_DIR, "08-final.png"), final);
  console.log("final render saved");

  await writeFile(join(OUT_DIR, "manifest.json"), JSON.stringify({
    user_id: userRow.data.id,
    user_email: userRow.data.email,
    photo_path: photoPath,
    photo_mime: photoMime,
    item: {
      id: picked.id, name: picked.name, brand: picked.brand, price: picked.price,
      image_url: picked.image_url,
    },
    input: { width: TARGET_W, height: TARGET_H, head_bbox: inputHeadBbox, editable_classes: editable.used },
    output: { width: TARGET_W, height: TARGET_H, head_bbox: outputHeadBbox },
    alignment: { aligned, detail: alignmentDetail, composite_applied: aligned && !!head },
    files: {
      source_photo: `00-source-photo.${sourceExt}`,
      normalized_person: "01-normalized-person.png",
      editable_mask: "02-editable-mask.png",
      head_mask_raw: "03-head-mask-raw.png",
      product_ref: `04-product-ref.${refExt}`,
      openai_raw: "05-openai-raw.png",
      feathered_overlay: aligned && head ? "06-feathered-overlay.png" : null,
      after_composite: aligned && head ? "07-after-composite.png" : null,
      final: "08-final.png",
    },
  }, null, 2));

  console.log("\n=== DONE ===");
  console.log("outputs in:", OUT_DIR);
  console.log("open /tmp/inpaint-test/08-final.png to see the final render");
  console.log("open /tmp/inpaint-test/05-openai-raw.png to see the pre-composite output");
  console.log("open /tmp/inpaint-test/manifest.json for bboxes + alignment decision");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
