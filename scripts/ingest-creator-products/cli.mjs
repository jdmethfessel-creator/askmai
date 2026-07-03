#!/usr/bin/env node
// CLI for the new try-on grid ingestion pipeline (PHASE 1).
//
// Usage:
//   node --env-file=.env.local scripts/ingest-creator-products/cli.mjs \
//     --creator <slug> --url <wishlist-url>
//
//   node --env-file=.env.local scripts/ingest-creator-products/cli.mjs \
//     --creator <slug> --csv path/to/file.csv
//
//   node --env-file=.env.local scripts/ingest-creator-products/cli.mjs \
//     --creator <slug> --shopmy-collection 3711656
//
// Flags:
//   --apply        Actually upsert into Supabase. Default is dry-run
//                  (parses, prints report, writes nothing).
//   --json         Print parsed rows as JSON (default: summary table).
//
// IMPORTANT: this CLI does NOT run as part of any deploy / build. It's
// a manual operator tool and lives outside the Next app entirely.

import { readFile } from "node:fs/promises";
import {
  ingestUrl,
  parseCsv,
  fetchShopMyCollection,
  detectNetwork,
} from "./parsers.mjs";

const args = parseArgs(process.argv.slice(2));
if (args._help || (!args.url && !args.csv && !args["shopmy-collection"])) {
  console.log(
    "usage: cli.mjs --creator <slug> (--url <url> | --csv <path> | --shopmy-collection <id>) [--apply] [--json]"
  );
  process.exit(args._help ? 0 : 1);
}

const creatorSlug = args.creator;
if (!creatorSlug) {
  console.error("missing --creator <slug>");
  process.exit(1);
}

const apply = !!args.apply;

let rows = [];
if (args.url) {
  console.log(`[fetch] ${args.url}`);
  rows = await ingestUrl(args.url);
} else if (args.csv) {
  const text = await readFile(args.csv, "utf8");
  rows = parseCsv({ text, sourceLabel: `csv:${args.csv}` });
} else if (args["shopmy-collection"]) {
  rows = await fetchShopMyCollection({
    collectionId: args["shopmy-collection"],
    creatorSlug,
  });
}

report(rows, { json: !!args.json });

if (!apply) {
  console.log("\n[dry-run] no DB writes. Re-run with --apply to upsert.");
  process.exit(0);
}

await upsertRows({ creatorSlug, rows });

// ---------------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      out._help = true;
      continue;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function report(rows, { json }) {
  console.log(`[parsed] ${rows.length} products`);
  if (rows.length === 0) return;
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  // Summary: count + first/last sample
  const byNet = {};
  for (const r of rows) byNet[r.source_network] = (byNet[r.source_network] || 0) + 1;
  console.log(`  by network: ${JSON.stringify(byNet)}`);
  console.log("  first 3:");
  for (const r of rows.slice(0, 3)) console.log(formatRow(r));
  console.log("  last 1:");
  for (const r of rows.slice(-1)) console.log(formatRow(r));
}

function formatRow(r) {
  return `    [${r.source_network}/${r.source_external_id || "—"}] ${(r.brand || "—").padEnd(24)} ${r.product_title} (${r.price_display || "?"})\n      img: ${r.image_url}\n      url: ${r.affiliate_url}`;
}

async function upsertRows({ creatorSlug, rows }) {
  const { createClient } = await import("@supabase/supabase-js");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("missing Supabase env vars");
    process.exit(1);
  }
  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: creator, error: cErr } = await sb
    .from("creators")
    .select("id")
    .eq("slug", creatorSlug)
    .maybeSingle();
  if (cErr || !creator) {
    console.error(`creator slug "${creatorSlug}" not found`);
    process.exit(1);
  }

  // Upsert in chunks; conflict target is the partial unique index.
  const payload = rows.map((r) => ({ ...r, creator_id: creator.id }));
  // Split with-external-id rows from without; only the former can use
  // onConflict ('creator_id,source_network,source_external_id').
  const withId = payload.filter((r) => r.source_external_id);
  const withoutId = payload.filter((r) => !r.source_external_id);

  if (withId.length) {
    const { error } = await sb
      .from("creator_products")
      .upsert(withId, {
        onConflict: "creator_id,source_network,source_external_id",
      });
    if (error) {
      console.error("upsert (withId) failed:", error.message);
      process.exit(1);
    }
  }
  if (withoutId.length) {
    const { error } = await sb.from("creator_products").insert(withoutId);
    if (error) {
      console.error("insert (withoutId) failed:", error.message);
      process.exit(1);
    }
  }
  console.log(`[apply] upserted ${withId.length} + inserted ${withoutId.length}`);

  // Snapshot prices for sale-drop detection. Best-effort; a missing
  // price_snapshots table (unmigrated env) just skips silently.
  try {
    const priced = payload.filter(
      (r) => r.source_external_id && r.price != null && r.price > 0
    );
    if (priced.length === 0) return;
    const ids = await sb
      .from("creator_products")
      .select("id, source_network, source_external_id, price")
      .eq("creator_id", creator.id)
      .in(
        "source_external_id",
        priced.map((r) => r.source_external_id)
      );
    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const idRows = ids.data ?? [];
    const snapshotBatch = [];
    for (const row of idRows) {
      const { data: recent } = await sb
        .from("price_snapshots")
        .select("id")
        .eq("product_id", row.id)
        .gte("captured_at", twelveHoursAgo)
        .limit(1);
      if (Array.isArray(recent) && recent.length > 0) continue;
      snapshotBatch.push({ product_id: row.id, price: row.price });
    }
    if (snapshotBatch.length > 0) {
      const { error } = await sb.from("price_snapshots").insert(snapshotBatch);
      if (!error) {
        console.log(`[apply] snapshotted ${snapshotBatch.length} prices`);
      }
    }
  } catch (err) {
    console.log(
      `[apply] price snapshot skipped (${err instanceof Error ? err.message : String(err)})`
    );
  }
}
