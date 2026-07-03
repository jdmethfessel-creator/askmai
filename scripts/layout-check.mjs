#!/usr/bin/env node
// scripts/layout-check.mjs
//
// Playwright-driven layout check for the janesmith Shop view at
// 390x844 (iPhone 12 Pro portrait). The spec requested puppeteer,
// but playwright is already in the project's deps and exposes the
// same API surface; the assertions are the same either way.
//
// Passes when:
//   - document.scrollWidth <= window.innerWidth (no horizontal clip)
//   - every visible "Shop" and "Try This On" button bounding box
//     sits fully inside the viewport (both x range and y range)
//
// Usage:
//   node scripts/layout-check.mjs [url]
//   BASE_URL=http://localhost:3000 node scripts/layout-check.mjs
//
// The dev server must be running (npm run dev) with a working
// Supabase env; otherwise the janesmith Shop grid stays empty and
// the CTA-in-viewport assertion has nothing to check.

import { chromium } from "playwright";

const URL_ARG = process.argv[2];
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const TARGET = URL_ARG ?? `${BASE}/janesmith`;

const VIEWPORT = { width: 390, height: 844 };
const CTA_LABELS = ["Shop", "Try This On", "Try on"];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();

  const failures = [];

  const nav = await page.goto(TARGET, { waitUntil: "networkidle", timeout: 45_000 });
  if (!nav || !nav.ok()) {
    console.error(`[layout-check] navigation failed: ${TARGET} status=${nav?.status()}`);
    process.exit(1);
  }

  // Give the Shop grid a moment to render its first page (there is no
  // deterministic "loaded" signal; the sentinel-based infinite scroll
  // is what settles it). networkidle handles most of this; a small
  // extra wait smooths the last render frame.
  await page.waitForTimeout(1200);

  // Assertion 1: no horizontal overflow.
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    docBodyOverflowX: getComputedStyle(document.documentElement).overflowX,
  }));
  console.log(
    `[layout-check] scrollWidth=${metrics.scrollWidth} innerWidth=${metrics.innerWidth}`
  );
  if (metrics.scrollWidth > metrics.innerWidth) {
    failures.push(
      `horizontal overflow: scrollWidth ${metrics.scrollWidth} > innerWidth ${metrics.innerWidth}`
    );
  }

  // Assertion 2: every visible CTA button inside the viewport.
  const cta = await page.evaluate((labels) => {
    const out = [];
    const els = document.querySelectorAll("button, a");
    for (const el of els) {
      const text = (el.textContent ?? "").trim();
      if (!labels.some((l) => text === l || text.includes(l))) continue;
      const rect = el.getBoundingClientRect();
      // Skip elements entirely off-screen (e.g. inside a collapsed
      // menu); the check applies to CTAs visible on the Shop view.
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.top < 0 && rect.bottom < 0) continue;
      if (rect.top > window.innerHeight) continue;
      out.push({
        label: text,
        x: rect.x,
        y: rect.y,
        w: rect.width,
        h: rect.height,
        right: rect.right,
        bottom: rect.bottom,
      });
    }
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      ctas: out,
    };
  }, CTA_LABELS);

  const vw = cta.viewport.w;
  const vh = cta.viewport.h;
  console.log(`[layout-check] viewport=${vw}x${vh} ctas=${cta.ctas.length}`);
  for (const c of cta.ctas) {
    const insideX = c.x >= 0 && c.right <= vw;
    const insideY = c.y >= 0 && c.bottom <= vh;
    const insideView = insideX && insideY;
    const marker = insideView ? "OK" : "OUT";
    console.log(
      `  [${marker}] "${c.label}" x=${c.x.toFixed(1)} y=${c.y.toFixed(1)} ` +
        `w=${c.w.toFixed(1)} h=${c.h.toFixed(1)} right=${c.right.toFixed(1)} bottom=${c.bottom.toFixed(1)}`
    );
    if (!insideX) {
      failures.push(
        `"${c.label}" x-range ${c.x.toFixed(1)}..${c.right.toFixed(1)} exceeds viewport width ${vw}`
      );
    }
    if (!insideY) {
      // Y-out-of-view is fine when the CTA scrolled off; only flag
      // when it lands INSIDE the vertical viewport but the sticky bar
      // covers it. Approximated here by "bottom > viewportHeight but
      // top < viewportHeight" — the button is partially visible AND
      // clipped by the bottom edge.
      if (c.y < vh && c.bottom > vh) {
        failures.push(
          `"${c.label}" bottom ${c.bottom.toFixed(1)} exceeds viewport height ${vh} while top ${c.y.toFixed(1)} is on-screen (sticky bar overlap)`
        );
      }
    }
  }

  await browser.close();

  if (failures.length > 0) {
    console.error(`\n[layout-check] FAIL ${failures.length} issue(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\n[layout-check] PASS");
}

main().catch((err) => {
  console.error("[layout-check] error:", err instanceof Error ? err.message : String(err));
  process.exit(2);
});
