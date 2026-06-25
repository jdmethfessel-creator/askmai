#!/usr/bin/env node
/**
 * Catalog importer runner.
 *
 * Pluggable per-platform connectors live under scripts/import/connectors/*.
 * The runner orchestrates: parse args → resolve creator → call connector
 * → validate every product's attribution host → optional dry-run report
 * → bulk insert into products.
 *
 * Usage:
 *   node --env-file=.env.local scripts/import/runner.mjs \
 *     --creator madisonwaller \
 *     --connector shopmy \
 *     --identifier madisonwaller \
 *     [--dry-run] \
 *     [--verify-count 2]
 */

import { createClient } from "@supabase/supabase-js";
import { connector as shopmyConnector } from "./connectors/shopmy.mjs";

const CONNECTORS = {
  shopmy: shopmyConnector,
};

function arg(flag, def = null) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const creatorSlug = arg("--creator");
const connectorName = arg("--connector");
const identifier = arg("--identifier");
const dryRun = arg("--dry-run", false) === true;
const verifyCount = Number(arg("--verify-count", 2));

if (!creatorSlug || !connectorName || !identifier) {
  console.error(
    "Usage: --creator <slug> --connector <shopmy|ltk> --identifier <handle> [--dry-run] [--verify-count N]"
  );
  process.exit(1);
}
const connector = CONNECTORS[connectorName];
if (!connector) {
  console.error(`Unknown connector "${connectorName}". Have: ${Object.keys(CONNECTORS).join(", ")}`);
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing Supabase env vars.");
  process.exit(1);
}
const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const creatorRow = await sb
  .from("creators")
  .select("id, slug, name")
  .eq("slug", creatorSlug)
  .maybeSingle();
if (creatorRow.error || !creatorRow.data) {
  console.error(`Creator slug "${creatorSlug}" not found in creators table.`);
  process.exit(1);
}
const { id: creatorId, name: creatorName } = creatorRow.data;

console.log(
  `\n=== importer ===\n` +
    `  creator   : ${creatorName} (${creatorSlug}, id=${creatorId})\n` +
    `  connector : ${connectorName}  network=${connector.network}\n` +
    `  identifier: ${identifier}\n` +
    `  dry-run   : ${dryRun}\n`
);

console.log("Fetching products from connector…");
const products = await connector.fetchProducts({ identifier });
console.log(`  connector returned ${products.length} candidate products\n`);

// Attribution gate — reject anything whose link host doesn't match.
const valid = [];
const rejected = [];
for (const p of products) {
  let host;
  try {
    host = new URL(p.affiliate_url).hostname;
  } catch {
    rejected.push({ reason: "malformed_url", product: p });
    continue;
  }
  if (!connector.isAttributingHost(host)) {
    rejected.push({ reason: `not_attributing_host: ${host}`, product: p });
    continue;
  }
  if (!p.name) {
    rejected.push({ reason: "missing_name", product: p });
    continue;
  }
  valid.push(p);
}
if (rejected.length > 0) {
  console.log(`Skipped ${rejected.length} candidates:`);
  for (const r of rejected.slice(0, 5)) {
    console.log(`  - ${r.reason}: ${r.product.name ?? "?"} (${r.product.affiliate_url ?? "?"})`);
  }
  if (rejected.length > 5) {
    console.log(`  (… ${rejected.length - 5} more)`);
  }
  console.log("");
}

if (valid.length === 0) {
  console.error("No valid products. Aborting without insert.");
  process.exit(2);
}

// Sample print.
console.log("Sample of 5 valid products:");
for (const p of valid.slice(0, 5)) {
  const priceShown = p.price ?? "?";
  const brandShown = p.brand ?? "?";
  console.log(
    `  - ${brandShown.padEnd(20).slice(0, 20)} | ${p.name.slice(0, 50).padEnd(50)} | ${priceShown.padEnd(8)} | ${p.affiliate_url}`
  );
}
console.log("");

// Attribution verification — click through N sample links and see
// where the redirect chain ends.
if (verifyCount > 0 && valid.length > 0) {
  console.log(`Verifying attribution on ${verifyCount} sample links…`);
  const samples = valid.slice(0, verifyCount);
  for (const p of samples) {
    const chain = await traceRedirectChain(p.affiliate_url);
    console.log(`  ${p.name.slice(0, 40)}`);
    for (const hop of chain) {
      console.log(`    → ${hop.status} ${hop.url}`);
    }
  }
  console.log("");
}

if (dryRun) {
  console.log(`Dry run — would have inserted ${valid.length} rows.`);
  process.exit(0);
}

console.log(`Inserting ${valid.length} rows into products…`);
// products.price is numeric; parse leading $ off.
const rows = valid.map((p) => ({
  creator_id: creatorId,
  name: p.name,
  brand: p.brand,
  category: p.category,
  price: parsePriceNumber(p.price),
  image_url: p.image_url,
  affiliate_url: p.affiliate_url,
  network: p.network,
}));

const ins = await sb.from("products").insert(rows).select("id");
if (ins.error) {
  console.error("Insert failed:", ins.error.message);
  process.exit(1);
}
console.log(`Inserted ${ins.data?.length ?? 0} rows.`);

function parsePriceNumber(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{1,5}(?:,\d{3})*(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

async function traceRedirectChain(start, max = 6) {
  const chain = [];
  let current = start;
  for (let i = 0; i < max; i++) {
    let res;
    try {
      res = await fetch(current, {
        redirect: "manual",
        headers: { "User-Agent": "Mozilla/5.0 askmai-importer" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      chain.push({ status: "ERR", url: `${current} — ${e.message}` });
      break;
    }
    chain.push({ status: res.status, url: current });
    if (![301, 302, 303, 307, 308].includes(res.status)) break;
    const loc = res.headers.get("location");
    if (!loc) break;
    try {
      current = new URL(loc, current).toString();
    } catch {
      break;
    }
  }
  return chain;
}
