/**
 * One-off: generates the 1200×630 OG image for /forcreators.
 *
 * Design follows the AskMai landing palette: dark surface, warm gold
 * accent, soft ink-on-warm-black body text. Matches the wordmark style
 * used in the actual site nav ("ask" + italic-gold "mai") rather than
 * inventing a different mark for the share card. Clean composition —
 * no live-screenshot stitching, which would require headless Chrome.
 *
 * Run: node scripts/generate-og.mjs
 * Output: public/og/forcreators.png  (committed, then referenced from
 *         the page's Next.js metadata export).
 */

import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const W = 1200;
const H = 630;
const OUT = "public/og/forcreators.png";

// Palette pulled directly from src/app/_marketing/landing.css.
const BG = "#0c0a07";
const SURFACE = "#14110c";
const GOLD = "#c89863";
const GOLD_DIM = "#8a6437";
const INK = "#f1e8d8";
const INK_SOFT = "#d9cdb8";
const MUTED = "#978977";

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <!-- Subtle radial glow in the top-right, matching the landing's
         atmospheric gold glow. Keeps the card from feeling like a
         flat slide. -->
    <radialGradient id="glow" cx="78%" cy="22%" r="55%">
      <stop offset="0%" stop-color="${GOLD}" stop-opacity="0.18"/>
      <stop offset="60%" stop-color="${GOLD}" stop-opacity="0.04"/>
      <stop offset="100%" stop-color="${GOLD}" stop-opacity="0"/>
    </radialGradient>
    <!-- Soft second glow lower-left for depth balance. -->
    <radialGradient id="glow2" cx="18%" cy="80%" r="50%">
      <stop offset="0%" stop-color="${GOLD_DIM}" stop-opacity="0.14"/>
      <stop offset="100%" stop-color="${GOLD_DIM}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <!-- Base + glow layers. -->
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <rect width="${W}" height="${H}" fill="url(#glow2)"/>

  <!-- Eyebrow / category label. -->
  <text x="${W / 2}" y="195" text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="22"
        letter-spacing="6"
        fill="${MUTED}">FOR CREATORS</text>

  <!-- Wordmark "ask + italic-gold mai". Matches site nav rather than
       inventing a new mark for share. -->
  <text x="${W / 2}" y="345"
        text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="158"
        font-weight="500"
        fill="${INK}"
        letter-spacing="-3">ask<tspan font-style="italic" fill="${GOLD}">mai</tspan></text>

  <!-- Description, split across two lines for hierarchy. The two
       clauses each carry one of the value props from the page's own
       copy. -->
  <text x="${W / 2}" y="450" text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="30"
        fill="${INK_SOFT}">Better engagement with your followers.</text>
  <text x="${W / 2}" y="495" text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="30"
        fill="${INK_SOFT}">More revenue from your affiliate links.</text>

  <!-- Subtle hairline + tag at the bottom — gives the card a finished
       editorial feel rather than empty space. -->
  <line x1="475" y1="555" x2="725" y2="555"
        stroke="${MUTED}" stroke-opacity="0.4" stroke-width="1"/>
  <text x="${W / 2}" y="592" text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="18"
        letter-spacing="4"
        fill="${MUTED}">askmai.co</text>
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
