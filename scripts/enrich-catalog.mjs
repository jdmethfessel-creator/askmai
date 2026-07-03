#!/usr/bin/env node
// Catalog enrichment (B2).
//
// For every creator_products row with enriched_version < 1, batch 25
// at a time to Anthropic claude-haiku-4-5, parse strict JSON into the
// fixed taxonomy, write attributes + search_text + enriched_version=1.
//
// Two-pass color resolution:
//   1) text pass: title + description (if any) mapped into the taxonomy
//   2) image pass: for rows that end with colors=[] after (1), send the
//      primary image with vision and extract colors only.
//
// Idempotent, resumable, rate-limit aware (429 -> exponential backoff).
// Prints totals + cost estimate at the end.
//
// Usage:
//   node --env-file=.env.local scripts/enrich-catalog.mjs [creator_slug]

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

const MODEL = "claude-haiku-4-5-20251001";
const BATCH_SIZE = 25;
const INPUT_PRICE_USD_PER_MTOK = 1.0; // Haiku 4.5 input
const OUTPUT_PRICE_USD_PER_MTOK = 5.0; // Haiku 4.5 output
const VISION_MAX_ROWS = 300; // safety ceiling on image-pass volume per run

const CATEGORIES = [
  "jeans","pants","shorts","skirt","dress","top","tee","sweater","jacket",
  "coat","blazer","shoes","sneakers","sandals","boots","bag","jewelry",
  "earrings","necklace","sunglasses","swim","activewear","accessory",
  "beauty","home","other",
];
const COLORS = [
  "black","white","ivory","cream","beige","tan","brown","grey","blue",
  "light-blue","navy","green","olive","red","burgundy","pink","blush",
  "orange","yellow","gold","silver","multi",
];
const MATERIALS = [
  "linen","cotton","silk","cashmere","wool","leather","suede","denim",
  "satin","velvet","knit","mesh","nylon","polyester",
];
const STYLES = [
  "casual","dressy","workwear","beach","evening","sport","streetwear",
  "coastal","editorial","minimalist","boho","preppy",
];

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("[enrich] ANTHROPIC_API_KEY not set. Aborting.");
  process.exit(1);
}
if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("[enrich] Supabase env not set. Aborting.");
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const stats = {
  totalScanned: 0,
  enriched: 0,
  colorResolvedByText: 0,
  colorResolvedByImage: 0,
  colorEmpty: 0,
  batchesRun: 0,
  inputTokens: 0,
  outputTokens: 0,
  errors: 0,
};

async function selectQueue(creatorSlug) {
  let q = sb
    .from("creator_products")
    .select("id, creator_id, product_title, brand, product_subcategory, image_url")
    .lt("enriched_version", 1)
    .limit(5000);
  if (creatorSlug) {
    const cr = await sb.from("creators").select("id").eq("slug", creatorSlug).maybeSingle();
    if (!cr.data) {
      console.error(`[enrich] creator "${creatorSlug}" not found`);
      process.exit(1);
    }
    q = q.eq("creator_id", cr.data.id);
  }
  const { data, error } = await q;
  if (error) {
    if (error.code === "42703") {
      console.error(
        "[enrich] attributes/enriched_version columns missing. Apply scratch/migration2.sql first."
      );
      process.exit(1);
    }
    console.error("[enrich] queue query failed:", error.message);
    process.exit(1);
  }
  return data || [];
}

function textPromptBatch(items) {
  const list = items
    .map((r, i) => {
      const parts = [`ID:${r.id}`];
      if (r.brand) parts.push(`Brand:${r.brand}`);
      parts.push(`Title:${r.product_title}`);
      if (r.product_subcategory) parts.push(`SourceCategory:${r.product_subcategory}`);
      return `[${i + 1}] ${parts.join(" | ")}`;
    })
    .join("\n");
  return `You are enriching a fashion catalog. Return STRICT JSON only, no prose.

TAXONOMY:
category (exactly one from): ${CATEGORIES.join(", ")}
colors (zero or more from): ${COLORS.join(", ")}
materials (zero or more from): ${MATERIALS.join(", ")}
styles (zero or more from): ${STYLES.join(", ")}

RULES:
- category: exactly one. Pick the most specific match; "other" is a valid fallback.
- colors: only include colors clearly supported by the text. Empty array is correct when the text does not say.
- materials + styles: same discipline; empty arrays when the text does not say.
- Do NOT invent. Do NOT infer color from brand vibes.

INPUT (${items.length} items):
${list}

Return JSON of shape:
{ "items": [ { "id": "<uuid>", "category": "<one>", "colors": [...], "materials": [...], "styles": [...] } ] }
Return one entry per input, same order.`;
}

async function callWithRetry(fn, label) {
  let attempt = 0;
  const maxAttempts = 5;
  while (attempt < maxAttempts) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = err?.status;
      attempt++;
      if (status === 429 || /rate|overloaded|529/i.test(msg)) {
        const wait = 1000 * Math.pow(2, attempt);
        console.warn(`[enrich] ${label} rate-limit (attempt ${attempt}), backing off ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (attempt >= maxAttempts) throw err;
      const wait = 500 * attempt;
      console.warn(`[enrich] ${label} err (${msg}), retry ${attempt} in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error("callWithRetry exhausted");
}

function extractJson(raw) {
  const trimmed = raw.trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace < 0) return null;
  const slice = trimmed.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

function filterInto(list, allowed) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const v of list) {
    const s = String(v).toLowerCase();
    if (allowed.includes(s)) out.push(s);
  }
  return Array.from(new Set(out));
}

async function textBatch(items) {
  stats.batchesRun++;
  const prompt = textPromptBatch(items);
  const resp = await callWithRetry(
    () =>
      anthropic.messages.create({
        model: MODEL,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    "text-batch"
  );
  stats.inputTokens += resp.usage?.input_tokens ?? 0;
  stats.outputTokens += resp.usage?.output_tokens ?? 0;
  const raw = resp.content?.[0]?.type === "text" ? resp.content[0].text : "";
  const parsed = extractJson(raw);
  const results = new Map();
  if (parsed && Array.isArray(parsed.items)) {
    for (const it of parsed.items) {
      if (!it || typeof it !== "object") continue;
      const id = String(it.id ?? "");
      const cat = String(it.category ?? "").toLowerCase();
      const colors = filterInto(it.colors, COLORS);
      const materials = filterInto(it.materials, MATERIALS);
      const styles = filterInto(it.styles, STYLES);
      results.set(id, {
        category: CATEGORIES.includes(cat) ? cat : "other",
        colors,
        materials,
        styles,
      });
    }
  }
  return results;
}

async function imageColorPass(row) {
  if (!row.image_url) return [];
  try {
    const resp = await callWithRetry(
      () =>
        anthropic.messages.create({
          model: MODEL,
          max_tokens: 300,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "url", url: row.image_url },
                },
                {
                  type: "text",
                  text: `Return STRICT JSON only: {"colors":[...]}. Values must come from this fixed list: ${COLORS.join(
                    ", "
                  )}. Only include colors visually dominant in the piece itself (not the background). Empty array is a valid answer.`,
                },
              ],
            },
          ],
        }),
      "image-color"
    );
    stats.inputTokens += resp.usage?.input_tokens ?? 0;
    stats.outputTokens += resp.usage?.output_tokens ?? 0;
    const raw = resp.content?.[0]?.type === "text" ? resp.content[0].text : "";
    const parsed = extractJson(raw);
    if (parsed && Array.isArray(parsed.colors)) {
      return filterInto(parsed.colors, COLORS);
    }
  } catch (err) {
    stats.errors++;
    console.warn(`[enrich] image pass failed for ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return [];
}

async function updateRow(row, attrs) {
  // search_text is refreshed by a BEFORE UPDATE trigger on the
  // attributes column (see scratch/migration2.sql). We only send
  // attributes + the version bump.
  const { error } = await sb
    .from("creator_products")
    .update({ attributes: attrs, enriched_version: 1 })
    .eq("id", row.id);
  if (error) {
    stats.errors++;
    console.warn(`[enrich] update failed for ${row.id}: ${error.message}`);
    return false;
  }
  return true;
}

async function processBatch(items) {
  const results = await textBatch(items);
  for (const row of items) {
    stats.totalScanned++;
    const attrs = results.get(row.id) ?? {
      category: "other",
      colors: [],
      materials: [],
      styles: [],
    };
    let usedImage = false;
    if (attrs.colors.length === 0 && row.image_url && stats.colorResolvedByImage < VISION_MAX_ROWS) {
      const colors = await imageColorPass(row);
      if (colors.length > 0) {
        attrs.colors = colors;
        usedImage = true;
        stats.colorResolvedByImage++;
      }
    }
    if (attrs.colors.length === 0) stats.colorEmpty++;
    else if (!usedImage) stats.colorResolvedByText++;

    const ok = await updateRow(row, attrs);
    if (ok) stats.enriched++;
  }
}

async function main() {
  const slug = process.argv[2] || null;
  const queue = await selectQueue(slug);
  console.log(`[enrich] queue size: ${queue.length}${slug ? ` (creator=${slug})` : ""}`);
  if (queue.length === 0) {
    console.log("[enrich] nothing to enrich.");
    printStats();
    return;
  }

  for (let i = 0; i < queue.length; i += BATCH_SIZE) {
    const chunk = queue.slice(i, i + BATCH_SIZE);
    console.log(`[enrich] batch ${Math.floor(i / BATCH_SIZE) + 1} (${chunk.length} items)`);
    try {
      await processBatch(chunk);
    } catch (err) {
      stats.errors++;
      console.warn(`[enrich] batch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  printStats();
}

function printStats() {
  const inCostUsd = (stats.inputTokens / 1_000_000) * INPUT_PRICE_USD_PER_MTOK;
  const outCostUsd = (stats.outputTokens / 1_000_000) * OUTPUT_PRICE_USD_PER_MTOK;
  const total = inCostUsd + outCostUsd;
  console.log("");
  console.log("=== enrichment stats ===");
  console.log(`  scanned            : ${stats.totalScanned}`);
  console.log(`  enriched           : ${stats.enriched}`);
  console.log(`  color-by-text      : ${stats.colorResolvedByText}`);
  console.log(`  color-by-image     : ${stats.colorResolvedByImage}`);
  console.log(`  color-empty        : ${stats.colorEmpty}`);
  console.log(`  batches            : ${stats.batchesRun}`);
  console.log(`  input tokens       : ${stats.inputTokens.toLocaleString()}`);
  console.log(`  output tokens      : ${stats.outputTokens.toLocaleString()}`);
  console.log(`  input cost USD     : $${inCostUsd.toFixed(4)}`);
  console.log(`  output cost USD    : $${outCostUsd.toFixed(4)}`);
  console.log(`  total est. USD     : $${total.toFixed(4)}`);
  console.log(`  errors             : ${stats.errors}`);
}

await main();
