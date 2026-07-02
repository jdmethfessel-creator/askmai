#!/usr/bin/env node
// Backfill / refresh product_fit for creator_products rows.
//
// Second-stage ingestion: the collection-page parsers land basic
// fields (title, price, affiliate URL, category) into
// creator_products; this pass hits each PDP and populates the
// separate product_fit table with model reference, retailer fit
// prose, review consensus, and size chart when the PDP exposes them.
//
// Rows without extractable fit data (Shopmy destinations off-network,
// long-tail brands) leave product_fit NULL and the engine correctly
// degrades to "no rec." Nothing in the app fails when a row is
// missing.
//
// Usage:
//   node --env-file=.env.local scripts/ingest-fit.mjs [creator_slug]
//
// Passing a creator slug narrows the pass to that creator's catalog;
// omitting it walks every product. Concurrency defaults to 6.

import { createClient } from "@supabase/supabase-js";
import { fetchHtml } from "./ingest-creator-products/fetch.mjs";
import { parsePdp } from "./ingest-creator-products/pdp-parsers.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CONCURRENCY = Number(process.env.FIT_CONCURRENCY || 6);
const PDP_TIMEOUT_MS = 20_000;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function selectProducts(creatorSlug) {
  // Pull product ids + affiliate URLs (source_network limits us to the
  // ones our PDP parsers understand; ShopMy rows resolve through the
  // affiliate URL directly, so we let them through and rely on
  // parsePdp() to detect a supported destination).
  let query = sb
    .from("creator_products")
    .select(
      "id, creator_id, source_network, affiliate_url, product_subcategory"
    )
    .not("affiliate_url", "is", null);
  if (creatorSlug) {
    const creator = await sb
      .from("creators")
      .select("id")
      .eq("slug", creatorSlug)
      .maybeSingle();
    if (!creator.data) {
      console.error(`creator not found: ${creatorSlug}`);
      process.exit(1);
    }
    query = query.eq("creator_id", creator.data.id);
  }
  const { data, error } = await query;
  if (error) {
    console.error("query failed:", error.message);
    process.exit(1);
  }
  return data || [];
}

const RENDERABLE_FOR_FIT = new Set([
  "tops",
  "bottoms",
  "dresses",
  "outerwear",
  "swim",
]);

async function upsertFit(row, fit) {
  const payload = {
    product_id: row.id,
    model_height_cm: fit.model_height_cm,
    model_size: fit.model_size,
    model_size_scale: fit.model_size_scale,
    fit_note: fit.fit_note,
    fit_run: fit.fit_run,
    fit_consensus: fit.fit_consensus,
    size_chart: fit.size_chart,
    source_network: fit.source_network,
  };
  const { error } = await sb
    .from("product_fit")
    .upsert(payload, { onConflict: "product_id" });
  if (error) throw new Error(`upsert: ${error.message}`);
}

async function processOne(row) {
  if (!RENDERABLE_FOR_FIT.has(row.product_subcategory)) {
    return { skipped: "not-fit-relevant" };
  }
  const url = row.affiliate_url;
  let html;
  try {
    html = await fetchHtml(url, { timeoutMs: PDP_TIMEOUT_MS });
  } catch (err) {
    return { skipped: `fetch: ${err.message}` };
  }
  const fit = parsePdp({ html, url });
  if (!fit) return { skipped: "off-network" };
  // If literally every field is null, don't write a row -- the
  // absence of a product_fit row is the correct signal for "no
  // data." Writing empty rows would waste index space.
  const any =
    fit.model_height_cm != null ||
    fit.model_size != null ||
    fit.fit_note != null ||
    fit.fit_run != null ||
    fit.fit_consensus != null ||
    fit.size_chart != null;
  if (!any) return { skipped: "no-fields" };
  await upsertFit(row, fit);
  return { ok: true, fit };
}

async function main() {
  const slugArg = process.argv[2] || null;
  const rows = await selectProducts(slugArg);
  console.log(
    `[fit] processing ${rows.length} product(s)${slugArg ? ` for ${slugArg}` : ""} at concurrency=${CONCURRENCY}`
  );

  let ok = 0;
  let skipped = 0;
  let errored = 0;
  const skipReasons = new Map();

  const queue = rows.slice();
  async function worker() {
    while (queue.length > 0) {
      const row = queue.shift();
      if (!row) return;
      try {
        const res = await processOne(row);
        if (res.ok) {
          ok++;
        } else {
          skipped++;
          skipReasons.set(
            res.skipped,
            (skipReasons.get(res.skipped) ?? 0) + 1
          );
        }
      } catch (err) {
        errored++;
        console.warn("[fit] error", row.id, err.message);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`[fit] done. ok=${ok} skipped=${skipped} errored=${errored}`);
  if (skipReasons.size > 0) {
    console.log("[fit] skip breakdown:");
    for (const [reason, count] of skipReasons) {
      console.log(`  ${count.toString().padStart(4)}  ${reason}`);
    }
  }
}

await main();
