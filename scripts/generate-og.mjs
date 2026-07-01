/**
 * Generates the 1200x630 OG image for /forcreators.
 *
 * Post-Mai redesign: cream product palette (matches the actual
 * creator page at askmai.co/<slug>), with a mockup of the product
 * surface on the left half so the share card actually shows what
 * AskMai looks like rather than an abstract wordmark.
 *
 * Composition:
 *   Left  ~55%: phone-shaped device frame with the three-tab creator
 *               header (Shop / Ask / Try On), a product card, and a
 *               Mai chat bubble underneath. Cream product palette.
 *   Right ~45%: eyebrow + h1 + tagline + askmai.co, in the same cream
 *               palette so the two halves feel like one card, not two
 *               pasted together.
 *
 * Run: node scripts/generate-og.mjs
 * Output: public/og/forcreators.png (committed, referenced from the
 *         page's Next.js metadata export).
 */

import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const W = 1200;
const H = 630;
const OUT = "public/og/forcreators.png";

// Palette pulled directly from src/app/_tryon/tryon.css so the OG
// card matches the actual product surface.
const BG = "#fafaf7"; // --t-bg
const SURFACE = "#ffffff";
const INK = "#18140e"; // --t-ink
const INK_SOFT = "#3a342a";
const MUTED = "#6a6256"; // --t-muted
const MUTED_DIM = "#a9a193";
const LINE = "#e6e1d5";
const ACCENT = "#a26a5a"; // creator theme accent

// Phone geometry
const PH_X = 60;
const PH_Y = 60;
const PH_W = 420;
const PH_H = 510;
const PH_BEZEL = 12;
const PH_SCREEN_X = PH_X + PH_BEZEL;
const PH_SCREEN_Y = PH_Y + PH_BEZEL;
const PH_SCREEN_W = PH_W - PH_BEZEL * 2;
const PH_SCREEN_H = PH_H - PH_BEZEL * 2;

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <!-- Warm radial glow behind the phone to lift the mockup off the
         cream background without turning the card into a flat slide. -->
    <radialGradient id="phoneShadow" cx="50%" cy="55%" r="55%">
      <stop offset="0%" stop-color="#000" stop-opacity="0.18"/>
      <stop offset="70%" stop-color="#000" stop-opacity="0.02"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0"/>
    </radialGradient>
    <!-- Subtle brand-accent wash lower-right so the right half doesn't
         read as empty. -->
    <radialGradient id="accentWash" cx="88%" cy="82%" r="45%">
      <stop offset="0%" stop-color="${ACCENT}" stop-opacity="0.10"/>
      <stop offset="100%" stop-color="${ACCENT}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <!-- Base + accent wash -->
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <rect width="${W}" height="${H}" fill="url(#accentWash)"/>

  <!-- Phone drop shadow ellipse -->
  <ellipse cx="${PH_X + PH_W / 2}" cy="${PH_Y + PH_H + 24}"
           rx="${PH_W * 0.55}" ry="24"
           fill="url(#phoneShadow)"/>

  <!-- Phone bezel -->
  <rect x="${PH_X}" y="${PH_Y}" width="${PH_W}" height="${PH_H}"
        rx="42" ry="42"
        fill="#14100a"/>
  <!-- Phone notch -->
  <rect x="${PH_X + PH_W / 2 - 44}" y="${PH_Y + 14}" width="88" height="10"
        rx="5" ry="5" fill="#050301"/>

  <!-- Screen -->
  <rect x="${PH_SCREEN_X}" y="${PH_SCREEN_Y}" width="${PH_SCREEN_W}" height="${PH_SCREEN_H}"
        rx="30" ry="30"
        fill="${BG}"/>

  <!-- ============ Screen content ============ -->

  <!-- Header eyebrow -->
  <text x="${PH_SCREEN_X + PH_SCREEN_W / 2}" y="${PH_SCREEN_Y + 60}"
        text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="12"
        letter-spacing="2.5"
        fill="${MUTED}">SEARCH MY CLOSET AND FAVORITE FINDS</text>

  <!-- Creator name -->
  <text x="${PH_SCREEN_X + PH_SCREEN_W / 2}" y="${PH_SCREEN_Y + 100}"
        text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="30"
        font-weight="600"
        letter-spacing="-0.5"
        fill="${INK}">Cass</text>

  <!-- Shop / Ask / Try On toggle -->
  ${(() => {
    const cy = PH_SCREEN_Y + 130;
    const toggleW = 260;
    const toggleH = 34;
    const toggleX = PH_SCREEN_X + (PH_SCREEN_W - toggleW) / 2;
    const btnW = (toggleW - 8) / 3;
    return `
      <rect x="${toggleX}" y="${cy}" width="${toggleW}" height="${toggleH}"
            rx="17" ry="17"
            fill="${SURFACE}" stroke="${LINE}" stroke-width="1"/>
      <rect x="${toggleX + 4}" y="${cy + 4}" width="${btnW}" height="${toggleH - 8}"
            rx="13" ry="13"
            fill="${INK}"/>
      <text x="${toggleX + 4 + btnW / 2}" y="${cy + 22}" text-anchor="middle"
            font-family="ui-sans-serif, system-ui, sans-serif"
            font-size="14" font-weight="600" fill="${SURFACE}">Shop</text>
      <text x="${toggleX + 4 + btnW + btnW / 2}" y="${cy + 22}" text-anchor="middle"
            font-family="ui-sans-serif, system-ui, sans-serif"
            font-size="14" font-weight="600" fill="${MUTED}">Ask</text>
      <text x="${toggleX + 4 + 2 * btnW + btnW / 2}" y="${cy + 22}" text-anchor="middle"
            font-family="ui-sans-serif, system-ui, sans-serif"
            font-size="14" font-weight="600" fill="${MUTED}">Try On</text>
    `;
  })()}

  <!-- Product card (Shop-style). Sized to fit inside PH_SCREEN_H
       (486px available) with the toggle above (~130px). Card total
       is 290px, giving a small bottom margin. Chat bubble removed
       from earlier composition to eliminate overlap. -->
  ${(() => {
    const cardX = PH_SCREEN_X + 20;
    const cardY = PH_SCREEN_Y + 180;
    const cardW = PH_SCREEN_W - 40;
    const imgH = 170;
    const metaH = 120;
    return `
      <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${imgH + metaH}"
            rx="14" ry="14"
            fill="${SURFACE}" stroke="${LINE}" stroke-width="1"/>
      <!-- image area (clipped to top corners of the card via a
           second rect stacked underneath) -->
      <path d="M ${cardX + 14} ${cardY}
               L ${cardX + cardW - 14} ${cardY}
               Q ${cardX + cardW} ${cardY} ${cardX + cardW} ${cardY + 14}
               L ${cardX + cardW} ${cardY + imgH}
               L ${cardX} ${cardY + imgH}
               L ${cardX} ${cardY + 14}
               Q ${cardX} ${cardY} ${cardX + 14} ${cardY} Z"
            fill="#f1ede4"/>
      <!-- "+" button top-right -->
      <circle cx="${cardX + cardW - 22}" cy="${cardY + 22}" r="14"
              fill="${SURFACE}"/>
      <text x="${cardX + cardW - 22}" y="${cardY + 27}" text-anchor="middle"
            font-family="ui-sans-serif, system-ui, sans-serif"
            font-size="18" font-weight="600" fill="${INK}">+</text>
      <!-- Simplified midi-skirt silhouette. Deliberately abstract so
           the mockup doesn't look like a photo of a specific real
           product; reads as "there's a product here." -->
      <circle cx="${cardX + cardW / 2}" cy="${cardY + 62}" r="14" fill="${ACCENT}" opacity="0.35"/>
      <path d="M ${cardX + cardW / 2 - 26} ${cardY + 78}
               L ${cardX + cardW / 2 + 26} ${cardY + 78}
               L ${cardX + cardW / 2 + 46} ${cardY + imgH - 8}
               L ${cardX + cardW / 2 - 46} ${cardY + imgH - 8} Z"
            fill="${ACCENT}" opacity="0.35"/>
      <!-- meta -->
      <text x="${cardX + 16}" y="${cardY + imgH + 24}"
            font-family="ui-sans-serif, system-ui, sans-serif"
            font-size="10" letter-spacing="1.2" fill="${MUTED}">THE FRANKIE SHOP</text>
      <text x="${cardX + 16}" y="${cardY + imgH + 44}"
            font-family="ui-sans-serif, system-ui, sans-serif"
            font-size="14" fill="${INK}">Alrose Midi Skirt</text>
      <text x="${cardX + 16}" y="${cardY + imgH + 64}"
            font-family="ui-sans-serif, system-ui, sans-serif"
            font-size="12" font-weight="600" fill="${INK}">$285</text>
      <!-- action buttons -->
      <rect x="${cardX + 16}" y="${cardY + imgH + 78}" width="120" height="28"
            rx="14" ry="14" fill="${INK}"/>
      <text x="${cardX + 16 + 60}" y="${cardY + imgH + 97}"
            text-anchor="middle"
            font-family="ui-sans-serif, system-ui, sans-serif"
            font-size="11" font-weight="600" fill="${SURFACE}">Try This On</text>
      <rect x="${cardX + 144}" y="${cardY + imgH + 78}" width="80" height="28"
            rx="14" ry="14" fill="${SURFACE}" stroke="${LINE}" stroke-width="1"/>
      <text x="${cardX + 144 + 40}" y="${cardY + imgH + 97}"
            text-anchor="middle"
            font-family="ui-sans-serif, system-ui, sans-serif"
            font-size="11" font-weight="600" fill="${INK}">Shop</text>
    `;
  })()}

  <!-- ============ Right half ============ -->

  <!-- Eyebrow -->
  <text x="530" y="180"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="16"
        letter-spacing="4"
        fill="${MUTED}">FOR CREATORS · ASKMAI</text>

  <!-- Headline -->
  <text x="530" y="250"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="56"
        font-weight="500"
        letter-spacing="-1"
        fill="${INK}">Your affiliate wardrobe,</text>
  <text x="530" y="316"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="56"
        font-style="italic"
        font-weight="400"
        letter-spacing="-1"
        fill="${ACCENT}">on your followers.</text>

  <!-- Body -->
  <text x="530" y="380"
        font-family="ui-sans-serif, system-ui, sans-serif"
        font-size="20"
        fill="${INK_SOFT}">Every link, one page. Try before you buy.</text>
  <text x="530" y="410"
        font-family="ui-sans-serif, system-ui, sans-serif"
        font-size="20"
        fill="${INK_SOFT}">Mai answers everything you haven't linked.</text>

  <!-- Wordmark row -->
  <text x="530" y="530"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="34"
        font-weight="500"
        letter-spacing="-1"
        fill="${INK}">ask<tspan font-style="italic" fill="${ACCENT}">mai</tspan></text>
  <text x="530" y="562"
        font-family="ui-sans-serif, system-ui, sans-serif"
        font-size="14"
        letter-spacing="3"
        fill="${MUTED_DIM}">askmai.co/forcreators</text>
</svg>`;

await mkdir(dirname(OUT), { recursive: true });
const buf = await sharp(Buffer.from(svg)).png().toBuffer();
const meta = await sharp(buf).metadata();
const fs = await import("node:fs/promises");
await fs.writeFile(OUT, buf);
console.log(`Wrote ${OUT}`);
console.log(`  dimensions: ${meta.width}x${meta.height}`);
console.log(`  size: ${buf.length.toLocaleString()} bytes`);
if (meta.width !== W || meta.height !== H) {
  console.error(`  FAIL: expected ${W}x${H}`);
  process.exit(1);
}
