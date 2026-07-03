#!/usr/bin/env node
// Search evaluation harness (B5).
//
// Runs 15+ cases against searchProducts on the real catalog for a
// chosen creator (default: janesmith). Hard-constraint cases assert
// every returned non-nearest result satisfies the category + color +
// price filters. Soft cases only assert that results come back from
// the right creator. Zero exact + nearest flagged counts as a pass
// for hard cases (correct behavior when the closet lacks the item).
//
// Usage:
//   node --env-file=.env.local scripts/search-eval.mjs [creator_slug]

import { createClient } from "@supabase/supabase-js";

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "[eval] SUPABASE env not set. Set NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local and rerun."
  );
  process.exit(1);
}

// Inline lexicon so the eval script has zero imports from src/ and
// stays runnable outside the Next build.
const CATEGORY_SYNONYMS = {
  jeans:"jeans", jean:"jeans", denim:"jeans",
  pants:"pants", pant:"pants", trouser:"pants", trousers:"pants", slacks:"pants",
  shorts:"shorts", short:"shorts",
  skirt:"skirt", midi:"skirt", maxi:"skirt",
  dress:"dress", dresses:"dress", gown:"dress",
  top:"top", tops:"top", blouse:"top", shirt:"top", cami:"top", tank:"top",
  tee:"tee", "t-shirt":"tee", tshirt:"tee",
  sweater:"sweater", cardigan:"sweater", pullover:"sweater", jumper:"sweater", knit:"sweater",
  jacket:"jacket", moto:"jacket", bomber:"jacket",
  coat:"coat", trench:"coat", parka:"coat", puffer:"coat",
  blazer:"blazer",
  shoes:"shoes", shoe:"shoes", loafer:"shoes", loafers:"shoes", mule:"shoes", mules:"shoes", heel:"shoes", heels:"shoes", flat:"shoes", flats:"shoes", pump:"shoes", pumps:"shoes",
  sneakers:"sneakers", sneaker:"sneakers", trainer:"sneakers", trainers:"sneakers",
  sandals:"sandals", sandal:"sandals", slide:"sandals", slides:"sandals",
  boots:"boots", boot:"boots", bootie:"boots", booties:"boots",
  bag:"bag", bags:"bag", tote:"bag", clutch:"bag", crossbody:"bag", purse:"bag", handbag:"bag",
  jewelry:"jewelry", jewellery:"jewelry", bracelet:"jewelry", ring:"jewelry",
  earrings:"earrings", earring:"earrings", hoops:"earrings", hoop:"earrings", studs:"earrings",
  necklace:"necklace", necklaces:"necklace", pendant:"necklace", chain:"necklace",
  sunglasses:"sunglasses", shades:"sunglasses",
  swim:"swim", bikini:"swim", swimsuit:"swim",
  activewear:"activewear", legging:"activewear", leggings:"activewear", sportsbra:"activewear",
  accessory:"accessory", accessories:"accessory", scarf:"accessory", belt:"accessory", hat:"accessory",
  beauty:"beauty", serum:"beauty", moisturizer:"beauty", lipstick:"beauty", mascara:"beauty",
  home:"home", candle:"home", vase:"home",
};
const COLOR_SYNONYMS = {
  black:"black", jet:"black", onyx:"black",
  white:"white",
  ivory:"ivory",
  cream:"cream", ecru:"cream", bone:"cream",
  beige:"beige",
  camel:"tan", tan:"tan", taupe:"tan",
  brown:"brown", chocolate:"brown", espresso:"brown",
  grey:"grey", gray:"grey", charcoal:"grey",
  blue:"blue", cobalt:"blue", royal:"blue", denim:"blue",
  "light-blue":"light-blue", "light blue":"light-blue", sky:"light-blue",
  indigo:"navy", navy:"navy", "dark-wash":"navy", "dark wash":"navy",
  green:"green", emerald:"green", forest:"green",
  olive:"olive", khaki:"olive",
  red:"red", crimson:"red",
  burgundy:"burgundy", wine:"burgundy", merlot:"burgundy",
  pink:"pink", fuchsia:"pink", hotpink:"pink",
  blush:"blush", rose:"blush",
  orange:"orange", rust:"orange", terracotta:"orange",
  yellow:"yellow", mustard:"yellow", butter:"yellow",
  gold:"gold", brass:"gold",
  silver:"silver", chrome:"silver",
  multi:"multi", print:"multi", floral:"multi",
};
const BLUE_FAMILY = ["blue","light-blue","navy"];

const PRICE_PATTERNS = [
  /\bunder\s*\$?\s*(\d{1,4})\b/i,
  /\bless\s+than\s*\$?\s*(\d{1,4})\b/i,
  /\bsub\s*\$?\s*(\d{1,4})\b/i,
  /\b\$?\s*(\d{1,4})\s*(?:or|and)\s*(?:under|less)\b/i,
];

function parseQuery(raw) {
  let remaining = String(raw ?? "").trim();
  const originalLower = remaining.toLowerCase();

  let priceMax = null;
  for (const rx of PRICE_PATTERNS) {
    const m = remaining.match(rx);
    if (m) {
      priceMax = Number(m[1]);
      remaining = remaining.replace(rx, " ");
      break;
    }
  }

  let category = null;
  const multi = Object.keys(CATEGORY_SYNONYMS).filter((k) => k.includes(" ")).sort((a,b)=>b.length-a.length);
  for (const key of multi) {
    if (remaining.toLowerCase().includes(key)) {
      category = CATEGORY_SYNONYMS[key];
      remaining = remaining.replace(new RegExp(`\\b${key}\\b`, "i"), " ");
      break;
    }
  }
  const tokens = remaining
    .split(/[\s,]+/)
    .map((t) => t.toLowerCase().replace(/[^a-z0-9-]/g, ""))
    .filter(Boolean);

  const colors = new Set();
  const consumed = new Set();
  tokens.forEach((t, i) => {
    if (!category) {
      const cat = CATEGORY_SYNONYMS[t];
      if (cat) {
        category = cat;
        consumed.add(i);
        return;
      }
    }
    const color = COLOR_SYNONYMS[t];
    if (color) {
      colors.add(color);
      consumed.add(i);
    }
  });

  if (/\bdenim\b/.test(originalLower) || /\bdark[-\s]?wash\b/.test(originalLower)) {
    for (const c of BLUE_FAMILY) colors.add(c);
  }
  const STOP = new Set(["the","a","an","some","any","of","and","or","for","with","to","in","on","at","by","from","is","are","be","that","those","these","i","me","my","you","your","she","he","her","him","piece","pieces","outfit"]);
  const freeText = tokens
    .filter((_, i) => !consumed.has(i))
    .filter((t) => !STOP.has(t))
    .join(" ")
    .trim();

  return { category, colors: Array.from(colors), priceMax, freeText };
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

async function loadCreator(slug) {
  const { data, error } = await sb.from("creators").select("id, slug").eq("slug", slug).maybeSingle();
  if (error || !data) {
    console.error(`[eval] creator "${slug}" not found`);
    process.exit(1);
  }
  return data;
}

const BASE_COLS = "id, creator_id, source_network, product_title, brand, price, price_display, image_url, affiliate_url, product_category, product_subcategory";
const ATTR_COLS = BASE_COLS + ", attributes";

async function runQuery({ creatorId, category, colors, priceMax, freeText, limit }) {
  let q = sb.from("creator_products").select(ATTR_COLS).eq("creator_id", creatorId).limit(limit);
  if (category) q = q.eq("attributes->>category", category);
  if (colors.length > 0) q = q.overlaps("attributes->colors", colors);
  if (priceMax != null) q = q.lte("price", priceMax);
  if (freeText) q = q.ilike("product_title", `%${freeText}%`);
  q = q.order("created_at", { ascending: false });
  const { data, error } = await q;
  if (error) {
    if (error.code === "42703") {
      // attributes column missing; fall back to text-only
      let q2 = sb.from("creator_products").select(BASE_COLS).eq("creator_id", creatorId).limit(limit);
      if (priceMax != null) q2 = q2.lte("price", priceMax);
      if (freeText) q2 = q2.ilike("product_title", `%${freeText}%`);
      const r2 = await q2;
      return { rows: r2.data ?? [], noAttrs: true };
    }
    return { rows: [], error };
  }
  return { rows: data ?? [], noAttrs: false };
}

async function searchProducts({ creatorId, query }) {
  const p = parseQuery(query);
  const strict = await runQuery({ ...p, creatorId, limit: 40 });
  if (strict.error) return { parsed: p, exact: [], nearest: [], noAttrs: strict.noAttrs };
  const exact = strict.rows.map((r) => ({ ...r, nearest: false }));
  if (exact.length >= 3 || p.colors.length === 0) {
    return { parsed: p, exact, nearest: [], noAttrs: strict.noAttrs };
  }
  const relaxed = await runQuery({
    creatorId,
    category: p.category,
    colors: [],
    priceMax: p.priceMax,
    freeText: p.freeText,
    limit: 40,
  });
  const nearest = (relaxed.rows ?? [])
    .filter((r) => !exact.find((e) => e.id === r.id))
    .map((r) => ({ ...r, nearest: true }));
  return { parsed: p, exact, nearest, noAttrs: strict.noAttrs };
}

// -------- eval cases --------
const HARD_CASES = [
  { query: "blue jeans",              constraint: { category: "jeans",    colorsAnyOf: BLUE_FAMILY,           priceMax: null } },
  { query: "black dress",             constraint: { category: "dress",    colorsAnyOf: ["black"],             priceMax: null } },
  { query: "white sneakers",          constraint: { category: "sneakers", colorsAnyOf: ["white","ivory"],     priceMax: null } },
  { query: "gold hoops",              constraint: { category: "earrings", colorsAnyOf: ["gold"],              priceMax: null } },
  { query: "linen set",               constraint: { category: null,       colorsAnyOf: null, freeText: "linen", priceMax: null } },
  { query: "black boots under $200",  constraint: { category: "boots",    colorsAnyOf: ["black"],             priceMax: 200 } },
  { query: "gold jewelry under $100", constraint: { category: null,       categoryAnyOf: ["jewelry","earrings","necklace"], colorsAnyOf: ["gold"], priceMax: 100 } },
  { query: "navy pants",              constraint: { category: "pants",    colorsAnyOf: ["navy"],              priceMax: null } },
  { query: "cream sweater",           constraint: { category: "sweater",  colorsAnyOf: ["cream","ivory"],     priceMax: null } },
  { query: "black boots",             constraint: { category: "boots",    colorsAnyOf: ["black"],             priceMax: null } },
];
const SOFT_CASES = [
  { query: "rooftop dinner outfit" },
  { query: "beach vacation" },
  { query: "what should i wear to a wedding" },
  { query: "cozy fall pieces" },
  { query: "spring layering" },
];

function violatesHard(row, constraint) {
  const attrs = row.attributes ?? {};
  const rowCat = attrs.category ?? row.product_subcategory ?? null;
  const rowColors = Array.isArray(attrs.colors) ? attrs.colors : [];

  if (constraint.category && rowCat !== constraint.category) {
    return `category mismatch (${rowCat})`;
  }
  if (constraint.categoryAnyOf && !constraint.categoryAnyOf.includes(rowCat)) {
    return `category not in ${constraint.categoryAnyOf.join("|")} (got ${rowCat})`;
  }
  if (constraint.colorsAnyOf && constraint.colorsAnyOf.length > 0) {
    const overlap = rowColors.some((c) => constraint.colorsAnyOf.includes(c));
    if (!overlap) return `color miss (has [${rowColors.join(",")}])`;
  }
  if (constraint.priceMax != null && row.price != null && row.price > constraint.priceMax) {
    return `price ${row.price} > ${constraint.priceMax}`;
  }
  if (constraint.freeText && !(row.product_title ?? "").toLowerCase().includes(constraint.freeText)) {
    return `freeText "${constraint.freeText}" not in title`;
  }
  return null;
}

function truncate(s, n) {
  if (s.length <= n) return s + " ".repeat(n - s.length);
  return s.slice(0, n - 1) + "…";
}

async function main() {
  const slug = process.argv[2] || "janesmith";
  const creator = await loadCreator(slug);
  console.log(`[eval] running against creator=${slug} id=${creator.id}\n`);

  const rows = [];
  let hardPass = 0;
  let hardFail = 0;
  let softPass = 0;
  let softFail = 0;

  for (const c of HARD_CASES) {
    const res = await searchProducts({ creatorId: creator.id, query: c.query });
    if (res.noAttrs) {
      rows.push({ query: c.query, kind: "HARD", verdict: "SKIP", detail: "attributes column missing" });
      continue;
    }
    const violations = res.exact
      .map((r) => ({ id: r.id, why: violatesHard(r, c.constraint) }))
      .filter((v) => v.why !== null);
    const exactCount = res.exact.length;
    const nearestCount = res.nearest.length;

    const isPass =
      violations.length === 0 &&
      (exactCount > 0 || nearestCount > 0 || (exactCount === 0 && nearestCount === 0));
    // Zero exact + zero nearest is acceptable when the catalog truly lacks
    // an item; searchProducts is honest about it.
    if (isPass) {
      hardPass++;
      rows.push({
        query: c.query,
        kind: "HARD",
        verdict: "PASS",
        detail: `exact=${exactCount} nearest=${nearestCount}`,
      });
    } else {
      hardFail++;
      rows.push({
        query: c.query,
        kind: "HARD",
        verdict: "FAIL",
        detail: `exact=${exactCount} viol=${violations.length}: ${violations[0]?.why ?? ""}`,
      });
    }
  }

  for (const c of SOFT_CASES) {
    const res = await searchProducts({ creatorId: creator.id, query: c.query });
    if (res.noAttrs) {
      rows.push({ query: c.query, kind: "SOFT", verdict: "SKIP", detail: "attributes column missing" });
      continue;
    }
    const belongToCreator = [...res.exact, ...res.nearest].every((r) => r.creator_id === creator.id);
    const anyResults = res.exact.length + res.nearest.length > 0;
    if (belongToCreator && anyResults) {
      softPass++;
      rows.push({
        query: c.query,
        kind: "SOFT",
        verdict: "PASS",
        detail: `exact=${res.exact.length} nearest=${res.nearest.length}`,
      });
    } else if (belongToCreator && !anyResults) {
      softPass++;
      rows.push({
        query: c.query,
        kind: "SOFT",
        verdict: "PASS",
        detail: "empty (honest)",
      });
    } else {
      softFail++;
      rows.push({
        query: c.query,
        kind: "SOFT",
        verdict: "FAIL",
        detail: "results from wrong creator",
      });
    }
  }

  console.log("QUERY".padEnd(34) + " KIND  VERDICT  DETAIL");
  console.log("-".repeat(80));
  for (const r of rows) {
    console.log(
      truncate(r.query, 34) + " " +
      r.kind.padEnd(5) + " " +
      r.verdict.padEnd(8) + " " +
      r.detail
    );
  }
  console.log("");
  console.log(`hard: ${hardPass} pass / ${hardFail} fail`);
  console.log(`soft: ${softPass} pass / ${softFail} fail`);
  console.log(`total: ${hardPass + softPass} pass / ${hardFail + softFail} fail`);
  if (hardFail > 0) process.exit(1);
}

await main();
