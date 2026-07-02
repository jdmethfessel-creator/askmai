/**
 * Try-on share card composition (Option A).
 *
 * One composition, no chooser: every render exits the pipeline as a
 * 1080x1920 (9:16) branded PNG that both Save and Share hand to
 * followers verbatim. Instagram Stories, TikTok, Reels — one card,
 * same everywhere.
 *
 * Layers, bottom to top:
 *   1. Blur-extend background. The try-on photo is scaled to COVER
 *      the 9:16 frame (crops one axis), softened by a heavy blur
 *      + saturation trim so it reads as an atmospheric wash of the
 *      photo's own colors — never flat gray. This is the "fill" for
 *      the letterbox band a 2:3 VTON output would otherwise leave
 *      when centered in a 9:16 frame.
 *   2. Foreground photo. Same source, CONTAIN-fit so nothing gets
 *      cropped: head-to-feet always visible. Centered horizontally
 *      and vertically.
 *   3. Top-left brand pill. Cream fill, "ask" + italic "mai"
 *      wordmark rendered from the checked-in Fraunces woff2. The
 *      pill scrim guarantees legibility even over a bright / busy
 *      top of frame.
 *   4. Bottom scrim + context line. Subtle ink gradient at the
 *      bottom third (transparent → ~35% ink) so the tracked-out
 *      "{creator} · askmai.co" line reads on any photo. Cream-white
 *      text, DM Sans, tracked at 3px, centered.
 *
 * Everything is rendered with @napi-rs/canvas so text kerning and
 * italic weight are consistent across dev + Vercel Fluid Compute.
 * Fonts are loaded once per Node instance at module import time.
 * The composition itself is fast (a single 1080x1920 canvas + one
 * sharp blur pass, ~150-250ms on Fluid Compute).
 */

import path from "node:path";
import sharp from "sharp";
import {
  createCanvas,
  loadImage,
  GlobalFonts,
} from "@napi-rs/canvas";

// Runtime font registration. Runs once per Node instance. Fonts are
// checked in under render-assets/ so the deploy bundle is
// self-contained; the @fontsource devDep only exists to source the
// original .woff2 bytes.
const FONT_DIR = path.join(process.cwd(), "src/lib/render-assets");
let fontsRegistered = false;
function registerFontsOnce(): void {
  if (fontsRegistered) return;
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
  fontsRegistered = true;
}

const CARD_W = 1080;
const CARD_H = 1920;

// Cream/tan product palette — matches src/app/_tryon/tryon.css:
//   --t-bg:      #fafaf7  (cream)
//   --t-ink:     #18140e  (near-black)
// Accent lifted from the creator OG (a warm terracotta italic mai).
const CREAM = "#fafaf7";
const INK = "#18140e";
const ACCENT = "#a26a5a";

const PILL_X = 44;
const PILL_Y = 56;
const PILL_W = 210;
const PILL_H = 72;
const PILL_R = 36;

// Bottom context strip geometry.
const STRIP_TEXT_Y = CARD_H - 74;
const STRIP_SCRIM_TOP = CARD_H - 260; // scrim ramps in over ~260px

export type ShareCardOptions = {
  /** Display label for the bottom strip, e.g. "MADISON WALLER" or a
   *  first name. Rendered uppercase + tracked. Falls back to just
   *  "askmai.co" (no leading label) when null/empty. */
  creatorLabel: string | null;
};

/**
 * Compose the final 1080x1920 share card from a VTON-output PNG.
 *
 * The caller passes the raw VTON output (typically 864x1296 from
 * FASHN or 768x1024 from Replicate IDM-VTON). This function does
 * all the branding + framing and returns a PNG that both Save and
 * Share deliver identically.
 */
export async function composeShareCard(
  vtonPngBuffer: Buffer,
  opts: ShareCardOptions
): Promise<Buffer> {
  registerFontsOnce();

  // 1) Blur-extend background: cover the whole 1080x1920 frame with
  //    the photo (crops one axis), heavy blur, mild desaturation.
  const blurredBg = await sharp(vtonPngBuffer)
    .resize({ width: CARD_W, height: CARD_H, fit: "cover" })
    .blur(48)
    .modulate({ saturation: 0.9, brightness: 1.02 })
    .png()
    .toBuffer();

  // 2) Foreground: contain-fit inside the 9:16 frame. No crop, ever.
  const fgFitted = await sharp(vtonPngBuffer)
    .resize({
      width: CARD_W,
      height: CARD_H,
      fit: "inside",
      withoutEnlargement: false,
    })
    .png()
    .toBuffer();

  // 3) Composite bg + fg centered, via sharp — canvas would do this
  //    too but sharp's raster path is measurably faster for the big
  //    image ops. Text/pill/scrim happen on the canvas step below.
  const fgMeta = await sharp(fgFitted).metadata();
  const fgW = fgMeta.width ?? CARD_W;
  const fgH = fgMeta.height ?? CARD_H;
  const fgLeft = Math.round((CARD_W - fgW) / 2);
  const fgTop = Math.round((CARD_H - fgH) / 2);

  const composited = await sharp(blurredBg)
    .composite([{ input: fgFitted, left: fgLeft, top: fgTop }])
    .png()
    .toBuffer();

  // 4) Load into canvas for the branding layer.
  const canvas = createCanvas(CARD_W, CARD_H);
  const ctx = canvas.getContext("2d");
  const baseImg = await loadImage(composited);
  ctx.drawImage(baseImg, 0, 0, CARD_W, CARD_H);

  // 4a) Top-left brand pill.
  //     Cream fill with a whisper of shadow, so the wordmark stays
  //     legible over the busiest possible photo top.
  ctx.save();
  ctx.shadowColor = "rgba(24, 20, 14, 0.18)";
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 4;
  roundedRect(ctx, PILL_X, PILL_Y, PILL_W, PILL_H, PILL_R);
  ctx.fillStyle = CREAM;
  ctx.fill();
  ctx.restore();

  // 4b) Wordmark: "ask" (Fraunces 500) + "mai" (Fraunces italic 500,
  //     accent color). Baseline centered inside the pill.
  const wordmarkY = PILL_Y + PILL_H / 2 + 12; // baseline nudge for optical center
  ctx.textBaseline = "alphabetic";
  ctx.font = '500 40px "Fraunces AskMai"';
  ctx.fillStyle = INK;
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

  // 4c) Bottom scrim: subtle ink gradient (transparent at the top,
  //     ~38% ink at the bottom) so the context strip reads on any
  //     photo, without a hard black bar.
  const scrim = ctx.createLinearGradient(0, STRIP_SCRIM_TOP, 0, CARD_H);
  scrim.addColorStop(0, "rgba(24, 20, 14, 0)");
  scrim.addColorStop(1, "rgba(24, 20, 14, 0.38)");
  ctx.fillStyle = scrim;
  ctx.fillRect(0, STRIP_SCRIM_TOP, CARD_W, CARD_H - STRIP_SCRIM_TOP);

  // 4d) Context line: "{CREATOR} · ASKMAI.CO" or just "ASKMAI.CO".
  //     DM Sans, uppercase, letter-spacing baked in via drawTracked.
  const label = (opts.creatorLabel ?? "").trim();
  const strip = label
    ? `${label.toUpperCase()}  ·  ASKMAI.CO`
    : `ASKMAI.CO`;
  ctx.font = '500 22px "DM Sans AskMai"';
  ctx.fillStyle = "rgba(250, 250, 247, 0.94)";
  drawTracked(ctx, strip, CARD_W / 2, STRIP_TEXT_Y, 3);

  return canvas.toBuffer("image/png");
}

function roundedRect(
  ctx: import("@napi-rs/canvas").SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
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

/**
 * Draw text with fixed per-character letter-spacing centered at
 * (cx, y). @napi-rs/canvas does not expose ctx.letterSpacing, so we
 * measure + advance manually for the tracked-out marketing look.
 */
function drawTracked(
  ctx: import("@napi-rs/canvas").SKRSContext2D,
  text: string,
  cx: number,
  y: number,
  spacing: number
): void {
  const widths: number[] = [];
  let total = 0;
  for (const ch of text) {
    const w = ctx.measureText(ch).width;
    widths.push(w);
    total += w + spacing;
  }
  total -= spacing; // no trailing gap
  let x = cx - total / 2;
  const prevAlign = ctx.textAlign;
  ctx.textAlign = "left";
  let i = 0;
  for (const ch of text) {
    ctx.fillText(ch, x, y);
    x += widths[i] + spacing;
    i++;
  }
  ctx.textAlign = prevAlign;
}
