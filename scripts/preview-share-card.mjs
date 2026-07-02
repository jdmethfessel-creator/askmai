/**
 * Renders a sample of the try-on share card so you can eyeball the
 * composition before we wire it into /api/render. Uses a checked-in
 * demo photo as a stand-in for a real VTON output — the framing,
 * blur-extend, cream pill, and bottom context line render exactly
 * the same in prod because the code path is identical.
 *
 * Run: node scripts/preview-share-card.mjs
 * Output: public/og/tryon-share-preview.png
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Load the runtime TypeScript module via a raw esbuild-free path:
// re-implement composeShareCard inline here would drift; instead we
// dynamically import from tsx. But avoid adding tsx as a dep — the
// module is small enough to duplicate the flow here.

import sharp from "sharp";
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";

const ROOT = process.cwd();
const FONT_DIR = path.join(ROOT, "src/lib/render-assets");

GlobalFonts.registerFromPath(
  path.join(FONT_DIR, "fraunces-500-normal.woff2"),
  "Fraunces AskMai"
);
GlobalFonts.registerFromPath(
  path.join(FONT_DIR, "fraunces-500-italic.woff2"),
  "Fraunces AskMai Italic"
);
GlobalFonts.registerFromPath(
  path.join(FONT_DIR, "dm-sans-500-normal.woff2"),
  "DM Sans AskMai"
);

const CARD_W = 1080;
const CARD_H = 1920;
const CREAM = "#fafaf7";
const INK = "#18140e";
const ACCENT = "#a26a5a";
const PILL_X = 44;
const PILL_Y = 56;
const PILL_W = 210;
const PILL_H = 72;
const PILL_R = 36;
const STRIP_TEXT_Y = CARD_H - 74;
const STRIP_SCRIM_TOP = CARD_H - 260;

async function composeShareCard(vtonPngBuffer, opts) {
  const blurredBg = await sharp(vtonPngBuffer)
    .resize({ width: CARD_W, height: CARD_H, fit: "cover" })
    .blur(48)
    .modulate({ saturation: 0.9, brightness: 1.02 })
    .png()
    .toBuffer();

  const fgFitted = await sharp(vtonPngBuffer)
    .resize({
      width: CARD_W,
      height: CARD_H,
      fit: "inside",
      withoutEnlargement: false,
    })
    .png()
    .toBuffer();

  const fgMeta = await sharp(fgFitted).metadata();
  const fgW = fgMeta.width ?? CARD_W;
  const fgH = fgMeta.height ?? CARD_H;
  const fgLeft = Math.round((CARD_W - fgW) / 2);
  const fgTop = Math.round((CARD_H - fgH) / 2);

  const composited = await sharp(blurredBg)
    .composite([{ input: fgFitted, left: fgLeft, top: fgTop }])
    .png()
    .toBuffer();

  const canvas = createCanvas(CARD_W, CARD_H);
  const ctx = canvas.getContext("2d");
  const baseImg = await loadImage(composited);
  ctx.drawImage(baseImg, 0, 0, CARD_W, CARD_H);

  // Pill
  ctx.save();
  ctx.shadowColor = "rgba(24, 20, 14, 0.18)";
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 4;
  roundedRect(ctx, PILL_X, PILL_Y, PILL_W, PILL_H, PILL_R);
  ctx.fillStyle = CREAM;
  ctx.fill();
  ctx.restore();

  // Wordmark
  const wordmarkY = PILL_Y + PILL_H / 2 + 12;
  ctx.textBaseline = "alphabetic";
  ctx.font = '500 40px "Fraunces AskMai"';
  const askText = "ask";
  const askW = ctx.measureText(askText).width;
  ctx.font = 'italic 500 40px "Fraunces AskMai Italic"';
  const maiW = ctx.measureText("mai").width;
  const wordmarkTotal = askW + maiW;
  let wx = PILL_X + (PILL_W - wordmarkTotal) / 2;
  ctx.font = '500 40px "Fraunces AskMai"';
  ctx.fillStyle = INK;
  ctx.fillText(askText, wx, wordmarkY);
  wx += askW;
  ctx.font = 'italic 500 40px "Fraunces AskMai Italic"';
  ctx.fillStyle = ACCENT;
  ctx.fillText("mai", wx, wordmarkY);

  // Bottom scrim
  const scrim = ctx.createLinearGradient(0, STRIP_SCRIM_TOP, 0, CARD_H);
  scrim.addColorStop(0, "rgba(24, 20, 14, 0)");
  scrim.addColorStop(1, "rgba(24, 20, 14, 0.38)");
  ctx.fillStyle = scrim;
  ctx.fillRect(0, STRIP_SCRIM_TOP, CARD_W, CARD_H - STRIP_SCRIM_TOP);

  // Bottom context
  const label = (opts.creatorLabel ?? "").trim();
  const strip = label ? `${label.toUpperCase()}  ·  ASKMAI.CO` : "ASKMAI.CO";
  ctx.font = '500 22px "DM Sans AskMai"';
  ctx.fillStyle = "rgba(250, 250, 247, 0.94)";
  drawTracked(ctx, strip, CARD_W / 2, STRIP_TEXT_Y, 3);

  return canvas.toBuffer("image/png");
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawTracked(ctx, text, cx, y, spacing) {
  const widths = [];
  let total = 0;
  for (const ch of text) {
    const w = ctx.measureText(ch).width;
    widths.push(w);
    total += w + spacing;
  }
  total -= spacing;
  let x = cx - total / 2;
  const prev = ctx.textAlign;
  ctx.textAlign = "left";
  let i = 0;
  for (const ch of text) {
    ctx.fillText(ch, x, y);
    x += widths[i] + spacing;
    i++;
  }
  ctx.textAlign = prev;
}

// ---------- CLI ---------------------------------------------------

const SAMPLE = path.join(ROOT, "public/demo/packing/frankies-bikini.jpg");
const OUT = path.join(ROOT, "public/og/tryon-share-preview.png");
const CREATOR = "Madison Waller";

mkdirSync(path.dirname(OUT), { recursive: true });
const raw = readFileSync(SAMPLE);
// Normalize the sample to PNG since composeShareCard expects PNG bytes
// (matches the VTON pipeline: FASHN + Replicate both hand us PNG).
const asPng = await sharp(raw).png().toBuffer();
const out = await composeShareCard(asPng, { creatorLabel: CREATOR });
writeFileSync(OUT, out);
console.log(
  `wrote ${OUT} — ${out.length.toLocaleString()} bytes ` +
    `(sample=frankies-bikini.jpg, creator="${CREATOR}")`
);
console.log(`open with:  open ${OUT}`);
