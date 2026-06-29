/**
 * THROWAWAY virtual try-on quality spike — DO NOT INTEGRATE.
 *
 * Tests OpenAI's gpt-image-1 image-edit endpoint as a virtual try-on
 * surface: given a person photo and a garment product shot, render
 * the same person wearing that garment, photorealistic, preserving
 * face/body identity and the garment's real color/cut.
 *
 * INPUTS  (user provides)
 *   scripts/tryon-test/people/*.{jpg,jpeg,png}   — 3 person photos
 *   scripts/tryon-test/garments/*.jpg            — 5 catalog garments
 *                                                  (already downloaded)
 *
 * OUTPUTS
 *   scripts/tryon-test/output/<person>-<garment>.png
 *
 * PRICING (verified 2026-06-27 from
 *          https://developers.openai.com/api/docs/guides/image-generation)
 *   gpt-image-1, 1024×1024:
 *     low    = $0.011 / image
 *     medium = $0.042 / image
 *     high   = $0.167 / image   ← this script uses high
 *   Note: gpt-image-1 is marked as legacy. Newer alternatives on the
 *   pricing page include gpt-image-2, gpt-image-1.5, gpt-image-1-mini.
 *   Spec asked for gpt-image-1 explicitly so that's what runs here.
 *
 * SECRETS
 *   OPENAI_API_KEY read from env (.env.local picked up by --env-file).
 *   Never hard-coded.
 *
 * Run:
 *   node --env-file=.env.local scripts/test-tryon.mjs
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "tryon-test");
const PEOPLE_DIR = join(ROOT, "people");
const GARMENTS_DIR = join(ROOT, "garments");
const OUTPUT_DIR = join(ROOT, "output");

const MODEL = "gpt-image-1";
const SIZE = "1024x1024";
const QUALITY = "high";
const PRICE_PER_IMAGE_USD = 0.167; // verified 2026-06-27, high@1024x1024

const PROMPT_TEMPLATE = ({ personFile, garmentFile }) => `
Render a photorealistic full-body image of the EXACT person shown in
the first image wearing the EXACT garment shown in the second image.

HARD CONSTRAINTS:
  - Preserve the person's face, hairstyle, skin tone, and body
    proportions identically to the first image. Do not idealize or
    restyle the person.
  - Preserve the garment's silhouette, fabric, color, neckline,
    sleeve length, hem, and any visible details (jacquard, plissé,
    satin sheen, etc.) exactly as shown in the second image.
  - Studio-quality photographic look. Clean neutral background.
    Natural daylight. Sharp focus on the person and garment.
  - The garment must FIT the person realistically — drape, length,
    and proportion all consistent with how it would actually wear.

Filenames for reference: person=${personFile}, garment=${garmentFile}
`.trim();

function fmtUsd(n) {
  return "$" + n.toFixed(4);
}

function basenameNoExt(p) {
  return basename(p, extname(p));
}

async function listImages(dir) {
  const all = await readdir(dir).catch(() => []);
  return all
    .filter((f) =>
      /\.(jpe?g|png|webp)$/i.test(f) && !f.startsWith(".")
    )
    .sort();
}

async function fileToBlob(path) {
  const buf = await readFile(path);
  // Sniff content-type from extension. gpt-image-1 accepts png + webp +
  // jpeg according to the docs; default to image/jpeg.
  const ext = extname(path).toLowerCase();
  const mime =
    ext === ".png"
      ? "image/png"
      : ext === ".webp"
      ? "image/webp"
      : "image/jpeg";
  // Web Blob (Node 18+ provides Blob globally).
  return new Blob([buf], { type: mime });
}

async function runOne({ personPath, garmentPath, apiKey }) {
  const personFile = basename(personPath);
  const garmentFile = basename(garmentPath);
  const prompt = PROMPT_TEMPLATE({ personFile, garmentFile });

  const form = new FormData();
  form.append("model", MODEL);
  form.append("prompt", prompt);
  form.append("size", SIZE);
  form.append("quality", QUALITY);
  form.append("n", "1");
  // gpt-image-1 edits accept multiple input images via the image[]
  // array form. The Node fetch FormData spec uses repeated keys.
  form.append("image[]", await fileToBlob(personPath), personFile);
  form.append("image[]", await fileToBlob(garmentPath), garmentFile);

  const t0 = Date.now();
  const res = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey },
    body: form,
  });
  const elapsedMs = Date.now() - t0;

  if (!res.ok) {
    const text = await res.text();
    return {
      ok: false,
      elapsedMs,
      error: `HTTP ${res.status}: ${text.slice(0, 400)}`,
    };
  }
  const json = await res.json();
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) {
    return {
      ok: false,
      elapsedMs,
      error: "no b64_json in response: " + JSON.stringify(json).slice(0, 400),
    };
  }
  // OpenAI returns usage on some image responses; surface it if present.
  const usage = json?.usage ?? null;
  return { ok: true, elapsedMs, b64, usage };
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error(
      "ERROR: OPENAI_API_KEY not set. Add to .env.local and re-run with --env-file=.env.local."
    );
    process.exit(1);
  }

  await mkdir(OUTPUT_DIR, { recursive: true });

  const peopleFiles = await listImages(PEOPLE_DIR);
  const garmentFiles = await listImages(GARMENTS_DIR);

  if (peopleFiles.length === 0) {
    console.error(
      `ERROR: no person photos in ${PEOPLE_DIR}. Drop 3 full-body images (jpg/png/webp) there and re-run.`
    );
    process.exit(2);
  }
  if (garmentFiles.length === 0) {
    console.error(
      `ERROR: no garment photos in ${GARMENTS_DIR}. Re-run the download step in test-tryon README.`
    );
    process.exit(2);
  }

  console.log(
    `=== Try-on spike — gpt-image-1 (legacy), high quality, 1024×1024 ===`
  );
  console.log(`  people:   ${peopleFiles.length}  (${peopleFiles.join(", ")})`);
  console.log(`  garments: ${garmentFiles.length}  (${garmentFiles.join(", ")})`);
  console.log(
    `  combos:   ${peopleFiles.length * garmentFiles.length}`
  );
  console.log(`  unit:     ${fmtUsd(PRICE_PER_IMAGE_USD)} per image`);
  console.log(
    `  est cost: ${fmtUsd(
      peopleFiles.length * garmentFiles.length * PRICE_PER_IMAGE_USD
    )}`
  );
  console.log("");

  const rows = [];
  const t0 = Date.now();
  let succeeded = 0;
  let failed = 0;

  for (const personFile of peopleFiles) {
    for (const garmentFile of garmentFiles) {
      const personPath = join(PEOPLE_DIR, personFile);
      const garmentPath = join(GARMENTS_DIR, garmentFile);
      const personSlug = basenameNoExt(personFile);
      const garmentSlug = basenameNoExt(garmentFile);
      const outName = `${personSlug}-${garmentSlug}.png`;
      const outPath = join(OUTPUT_DIR, outName);

      process.stdout.write(`→ ${personFile} × ${garmentFile} ... `);
      const r = await runOne({ personPath, garmentPath, apiKey });
      if (r.ok) {
        await writeFile(outPath, Buffer.from(r.b64, "base64"));
        succeeded++;
        process.stdout.write(`OK ${r.elapsedMs}ms\n`);
        rows.push({
          combo: outName,
          ok: true,
          ms: r.elapsedMs,
          cost: PRICE_PER_IMAGE_USD,
          usage: r.usage,
        });
      } else {
        failed++;
        process.stdout.write(`FAIL ${r.elapsedMs}ms\n   ${r.error}\n`);
        rows.push({
          combo: outName,
          ok: false,
          ms: r.elapsedMs,
          cost: 0, // OpenAI charges on success only for image edits
          error: r.error,
        });
      }
    }
  }

  const totalMs = Date.now() - t0;
  const totalCost = rows.reduce((s, r) => s + r.cost, 0);

  console.log("");
  console.log("=== Summary ===");
  console.log(
    "  combo".padEnd(58) + "  status   ms     cost"
  );
  for (const r of rows) {
    console.log(
      "  " +
        r.combo.padEnd(56) +
        "  " +
        (r.ok ? "OK  " : "FAIL") +
        "  " +
        String(r.ms).padStart(5) +
        "  " +
        fmtUsd(r.cost)
    );
  }
  console.log("");
  console.log(
    `  succeeded: ${succeeded}/${rows.length}    failed: ${failed}`
  );
  console.log(`  total elapsed: ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`  total cost:    ${fmtUsd(totalCost)}`);
  console.log(`  outputs in:    ${OUTPUT_DIR}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
