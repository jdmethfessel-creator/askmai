/**
 * Generates the 1200x630 OG cards for the homepage and /forcreators.
 *
 * Both cards render in the cream/tan product palette (matches
 * src/app/_tryon/tryon.css) so a share preview reads as one system.
 * Copy comes from the current marketing pages; regenerate whenever
 * the headline copy changes.
 *
 * Run: node scripts/generate-og.mjs
 * Outputs:
 *   public/og/home.png          -> homepage (follower-facing)
 *   public/og/forcreators.png   -> creator pitch page
 */

import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const W = 1200;
const H = 630;

// Palette identical to landing.css cream/tan tokens.
const BG = "#fafaf7";
const SURFACE = "#ffffff";
const INK = "#18140e";
const INK_SOFT = "#3a342a";
const MUTED = "#6a6256";
const MUTED_DIM = "#a9a193";
const LINE = "#e6e0d4";
const ACCENT = "#a26a5a";

function baseWash(gradientId) {
  return `
    <defs>
      <radialGradient id="${gradientId}" cx="90%" cy="88%" r="55%">
        <stop offset="0%" stop-color="${ACCENT}" stop-opacity="0.12"/>
        <stop offset="100%" stop-color="${ACCENT}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="${BG}"/>
    <rect width="${W}" height="${H}" fill="url(#${gradientId})"/>
  `;
}

/* Homepage: follower-facing, hero on left, phone frame on right
 * showing a Try-On result placeholder. */
function homeSvg() {
  const phW = 300;
  const phH = 490;
  const phX = W - phW - 90;
  const phY = (H - phH) / 2;
  const bezel = 12;
  const screenX = phX + bezel;
  const screenY = phY + bezel;
  const screenW = phW - bezel * 2;
  const screenH = phH - bezel * 2;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${baseWash("homeWash")}

  <!-- Left copy stack -->
  <text x="90" y="180"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="14" letter-spacing="4"
        fill="${MUTED}">TRY IT ON · ASKMAI.CO</text>

  <text x="90" y="264"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="60" font-weight="600" letter-spacing="-1.5"
        fill="${INK}">See it on you</text>
  <text x="90" y="336"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="60" font-weight="500" font-style="italic"
        letter-spacing="-1.5" fill="${ACCENT}">before you buy.</text>

  <text x="90" y="404"
        font-family="ui-sans-serif, system-ui, sans-serif"
        font-size="20" fill="${INK_SOFT}">One photo of you, every look your</text>
  <text x="90" y="432"
        font-family="ui-sans-serif, system-ui, sans-serif"
        font-size="20" fill="${INK_SOFT}">favorite creator wears, on you.</text>

  <text x="90" y="530"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="30" font-weight="500" letter-spacing="-0.5"
        fill="${INK}">ask<tspan font-style="italic" fill="${ACCENT}">mai</tspan>.co</text>

  <!-- Phone frame with cream try-on placeholder -->
  <rect x="${phX}" y="${phY}" width="${phW}" height="${phH}"
        rx="42" ry="42" fill="#14100a"/>
  <rect x="${phX + phW / 2 - 40}" y="${phY + 14}" width="80" height="10"
        rx="5" ry="5" fill="#050301"/>
  <rect x="${screenX}" y="${screenY}" width="${screenW}" height="${screenH}"
        rx="30" ry="30" fill="${BG}"/>

  <!-- Try-on "figure" placeholder inside the screen -->
  <defs>
    <linearGradient id="figureWash" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#f1ede4"/>
      <stop offset="100%" stop-color="#dcd3c1"/>
    </linearGradient>
  </defs>
  <rect x="${screenX}" y="${screenY}" width="${screenW}" height="${screenH}"
        rx="30" ry="30" fill="url(#figureWash)"/>

  <!-- Cream brand pill top-left of the phone (matches the actual
       share card composition) -->
  <rect x="${screenX + 18}" y="${screenY + 22}" width="90" height="30"
        rx="15" ry="15" fill="${SURFACE}"/>
  <text x="${screenX + 63}" y="${screenY + 41}"
        text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="14" font-weight="500" fill="${INK}">
    ask<tspan font-style="italic" fill="${ACCENT}">mai</tspan>
  </text>

  <!-- Bottom label strip mirroring the share card -->
  <rect x="${screenX}" y="${screenY + screenH - 70}"
        width="${screenW}" height="70" fill="rgba(24, 20, 14, 0.22)"/>
  <text x="${screenX + screenW / 2}" y="${screenY + screenH - 34}"
        text-anchor="middle"
        font-family="ui-sans-serif, system-ui, sans-serif"
        font-size="10" letter-spacing="3" font-weight="500"
        fill="${BG}">ASKMAI.CO</text>
</svg>`;
}

/* /forcreators: creator pitch, hero on left, small preview on right */
function forCreatorsSvg() {
  const phW = 300;
  const phH = 490;
  const phX = W - phW - 90;
  const phY = (H - phH) / 2;
  const bezel = 12;
  const screenX = phX + bezel;
  const screenY = phY + bezel;
  const screenW = phW - bezel * 2;
  const screenH = phH - bezel * 2;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${baseWash("fcWash")}

  <text x="90" y="180"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="14" letter-spacing="4"
        fill="${MUTED}">FOR CREATORS · ASKMAI.CO</text>

  <text x="90" y="264"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="54" font-weight="600" letter-spacing="-1"
        fill="${INK}">The one link where</text>
  <text x="90" y="326"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="54" font-weight="600" letter-spacing="-1"
        fill="${INK}">your followers</text>
  <text x="90" y="388"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="54" font-weight="500" font-style="italic"
        letter-spacing="-1" fill="${ACCENT}">actually buy.</text>

  <text x="90" y="456"
        font-family="ui-sans-serif, system-ui, sans-serif"
        font-size="18" fill="${INK_SOFT}">Try-on. One-page catalog. 100% yours.</text>

  <text x="90" y="530"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="30" font-weight="500" letter-spacing="-0.5"
        fill="${INK}">ask<tspan font-style="italic" fill="${ACCENT}">mai</tspan>.co/forcreators</text>

  <!-- Phone frame preview showing a creator page shop tab -->
  <rect x="${phX}" y="${phY}" width="${phW}" height="${phH}"
        rx="42" ry="42" fill="#14100a"/>
  <rect x="${phX + phW / 2 - 40}" y="${phY + 14}" width="80" height="10"
        rx="5" ry="5" fill="#050301"/>
  <rect x="${screenX}" y="${screenY}" width="${screenW}" height="${screenH}"
        rx="30" ry="30" fill="${BG}"/>

  <!-- Shop/Ask/Try On tab strip -->
  <text x="${screenX + screenW / 2}" y="${screenY + 52}"
        text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="11" letter-spacing="2.5" fill="${MUTED}">SHOP · ASK · TRY ON</text>

  <text x="${screenX + screenW / 2}" y="${screenY + 92}"
        text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="24" font-weight="600" letter-spacing="-0.4"
        fill="${INK}">Your handle</text>

  <!-- 2x2 shop tiles -->
  ${(() => {
    const cardW = (screenW - 40) / 2;
    const cardH = 140;
    const cardStartY = screenY + 130;
    const gap = 10;
    const cards = [];
    for (let i = 0; i < 4; i++) {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const x = screenX + 15 + col * (cardW + gap);
      const y = cardStartY + row * (cardH + gap);
      cards.push(`
        <rect x="${x}" y="${y}" width="${cardW}" height="${cardH}" rx="10" ry="10"
              fill="${SURFACE}" stroke="${LINE}" stroke-width="1"/>
        <rect x="${x}" y="${y}" width="${cardW}" height="${cardH - 32}" rx="10" ry="10"
              fill="#f1ede4"/>
        <circle cx="${x + cardW / 2}" cy="${y + cardH / 2 - 28}" r="14"
                fill="${ACCENT}" opacity="0.4"/>
        <path d="M ${x + cardW / 2 - 22} ${y + cardH / 2 - 8}
                 L ${x + cardW / 2 + 22} ${y + cardH / 2 - 8}
                 L ${x + cardW / 2 + 30} ${y + cardH - 40}
                 L ${x + cardW / 2 - 30} ${y + cardH - 40} Z"
              fill="${ACCENT}" opacity="0.4"/>
        <text x="${x + 10}" y="${y + cardH - 12}"
              font-family="ui-sans-serif, system-ui, sans-serif"
              font-size="9" letter-spacing="1.2" fill="${MUTED_DIM}">BRAND</text>
      `);
    }
    return cards.join("\n");
  })()}
</svg>`;
}

async function writeCard(name, svg) {
  const out = `public/og/${name}`;
  await mkdir(dirname(out), { recursive: true });
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  const meta = await sharp(buf).metadata();
  await writeFile(out, buf);
  console.log(`Wrote ${out}`);
  console.log(`  dimensions: ${meta.width}x${meta.height}`);
  console.log(`  size: ${buf.length.toLocaleString()} bytes`);
  if (meta.width !== W || meta.height !== H) {
    console.error(`  FAIL: expected ${W}x${H}`);
    process.exit(1);
  }
}

await writeCard("home.png", homeSvg());
await writeCard("forcreators.png", forCreatorsSvg());
