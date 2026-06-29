#!/usr/bin/env node
// One-off runner: UPDATE creators SET hidden=true for the five seeded
// slugs via supabase-js (service role). Logs the resulting visibility
// row by row so you can confirm before / after.
//
// Run with: node --env-file=.env.local scripts/hide-all-seeded-creators.mjs

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing Supabase env vars.");
  process.exit(1);
}

const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const SLUGS = ["janesmith", "tezza", "weworewhat", "somethingnavy", "emilyhenderson"];

const before = await sb
  .from("creators")
  .select("slug, name, hidden")
  .order("created_at");
if (before.error) {
  console.error("before snapshot failed:", before.error.message);
  process.exit(1);
}
console.log("BEFORE:");
for (const r of before.data ?? []) {
  console.log(`  ${r.slug.padEnd(18)} hidden=${r.hidden}`);
}

const updated = await sb
  .from("creators")
  .update({ hidden: true })
  .in("slug", SLUGS)
  .select("slug, hidden");
if (updated.error) {
  console.error("update failed:", updated.error.message);
  process.exit(1);
}

console.log(`\nUPDATED ${updated.data?.length ?? 0} row(s).\n`);

const after = await sb
  .from("creators")
  .select("slug, name, hidden")
  .order("created_at");
console.log("AFTER:");
for (const r of after.data ?? []) {
  console.log(`  ${r.slug.padEnd(18)} hidden=${r.hidden}`);
}
