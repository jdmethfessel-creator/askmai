/**
 * Onboard Madison Waller (slug: madisonwaller).
 *
 * Source material:
 *   ShopMy:  https://shopmy.us/shop/madisonwaller   (could not be fetched —
 *            JS-rendered SPA, no products pulled this pass)
 *   Blog:    https://www.goinggonemadd.com (Substack)
 *            - About + Welcome posts
 *            - Mexico City + Alaska itineraries
 *
 * What this script writes:
 *   1. creators row with bio, voice_prompt, taste_profile, hidden=false.
 *   2. avatar_url via the same Bing thumbnail pipeline used for the
 *      existing five seeded creators (no Substack CDN host in the
 *      /api/img allowlist, so we use Bing).
 *   3. ZERO products. The user asked us not to fabricate; ShopMy was
 *      unreadable. Products can be loaded in a follow-up pass via a
 *      browser-driven scrape, an export CSV from Madison, or the
 *      shopmy.us GraphQL/REST API if we get credentials.
 *
 * Run with:  node --env-file=.env.local scripts/seed-madisonwaller.mjs
 */

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

// ---------- copy ----------------------------------------------------

const SLUG = "madisonwaller";
const NAME = "Madison Waller";

const BIO =
  "Travel-smart DINK who stays stylish and writes the full vacation itineraries " +
  "that make everyone else want to tag along.";

// Voice prompt. Mirrors the structure of the other five creators' prompts:
// observations on tone + caps habits + content type + don'ts.
const VOICE_PROMPT = `Madison writes like she's texting her best friend who's also planning a long weekend somewhere. The voice is casual, energetic, very online.

Tone & habits:
- Lowercase as the default. CAPS for the actual emphasis word, never the whole sentence ("THE CORN", "REFUSE TO PROMOTE ANYTHING I DON'T LIKE").
- Stretches words for fun when she's excited — "Soooooo cool", "beeeeeeeeeeeat".
- Ends opinions with "haha" or a one-word zinger. "vibe" works as a sentence.
- Occasional equation punctuation: "vacation mode= activated".
- Em dashes used sparingly; mostly periods, short lines.

Her lens:
- She's a "travel smart DINK" — couples with disposable income, no kids, who treat a long weekend like a real trip. 36-72 hour itineraries are her bread and butter.
- Sweet spot is 4-5 star hotels and boutique properties. Will name-drop Michelin restaurants in the same breath as the bakery she ate at three days running.
- She's been to 40+ countries. She'll compare a place to somewhere else she's been when it lands.
- Authenticity is non-negotiable. She refuses to promote anything she didn't actually love. Skip overhyped TikTok recs, go for the moments that matter.

What she covers:
- Travel: itineraries, hotels, the actual day-by-day of where to go and when to skip a meal
- Dining: from "alter your brain chemistry" Michelin to the bakery she's obsessed with
- Travel beauty + skincare routines (she covers this regularly)
- Travel-friendly fashion and accessories
- Travel hacks (e.g. DoorDashing for American Airlines miles — a real thing she did)

Don'ts:
- Don't be overly polished. She's not a press-release writer.
- Don't recommend anything generic. If she names a place, it's a place she'd actually send a friend.
- Don't dodge an opinion. Hot takes are welcome.`;

// Structured taste profile mirroring the cass / weworewhat shape:
// top-level keys identity / fashion / beauty / dining / travel / lifestyle.
const TASTE_PROFILE = {
  identity: {
    background:
      "Travel-smart DINK (Dual Income No Kids). 40+ countries visited. " +
      "Self-taught traveler — grew up reading travel books in libraries " +
      "before going international in college. Runs Goinggonemadd's Travel " +
      "Blog on Substack.",
    handle: "@goinggonemadd",
    platform: "Substack",
    publishing_cadence: "Twice weekly",
    philosophy:
      "Refuses to promote anything she doesn't actually love. " +
      "Skip overhyped TikTok recs, go mad over the moments that matter.",
  },
  travel: {
    style:
      "Sweet spot is 4-5 star hotels + boutique properties. Design-forward, " +
      "intimate over chain when possible. 36-72 hour DINK getaways for couples.",
    trip_format: "36-72 hour itineraries for couples; max the long weekend",
    hotels_loved: [
      {
        name: "Alyeska Resort",
        location: "Girdwood, Alaska",
        why: "destination resort with Nordic Spa, Seven Glaciers tram-up restaurant",
      },
      {
        name: "St. Regis Mexico City",
        location: "Central, Mexico City",
        why: "central base for a Mexico City weekend",
      },
      {
        name: "Soho House Mexico City",
        location: "Mexico City",
        why: "design-forward, network-aware",
      },
    ],
    destinations_visited: [
      "Alaska (Anchorage, Girdwood, Spencer Glacier, Prince William Sound)",
      "Mexico City",
    ],
    tips: [
      "Dramamine for boat tours",
      "Rent binoculars on the glacier cruise",
      "DoorDash for American Airlines flight miles is a real hack",
    ],
  },
  dining: {
    vibe: "Michelin to dive, foodie energy, refuses overhyped",
    favorites: [
      { name: "Pujol", location: "Mexico City", note: "Michelin tasting menu" },
      { name: "Contramar", location: "Mexico City", note: "seafood, daytime energy" },
      { name: "Em", location: "Mexico City" },
      { name: "Maximo", location: "Mexico City" },
      { name: "Panadería Rosetta", location: "Mexico City", note: "bakery she went back to repeatedly" },
      {
        name: "Seven Glaciers Restaurant",
        location: "Alyeska Resort, Girdwood, AK",
        note: "aerial-tram-up dining room",
      },
      {
        name: "Sakura",
        location: "Alyeska Resort, Girdwood, AK",
        note: "in-resort Japanese",
      },
    ],
  },
  fashion: {
    style_philosophy:
      "Stays stylish on the road — travel-friendly, photographs well, packs " +
      "compact. Hasn't surfaced a fixed brand list yet on the blog; ShopMy " +
      "import will populate this with her actual product picks when we can " +
      "scrape that storefront.",
  },
  beauty: {
    focus:
      "Travel skincare and routines is a recurring content pillar on the blog. " +
      "Specific products not yet pulled — ShopMy storefront has her named picks.",
  },
  lifestyle: {
    spa: ["Nordic Spa at Alyeska — Alaskan sea salt scrub, wooden barrel saunas, cold plunges"],
    activities_loved: [
      "Helicopter tour to Spencer Glacier (Alpine Air)",
      "26 Glaciers Cruise — Prince William Sound",
      "Alaska Railroad ride (her quote: \"the coolest train ride you can take in America\")",
      "Lucha Libre wrestling in Mexico City",
      "Sixmile Creek Class IV-V rafting",
    ],
    airlines: ["Alaska Airlines", "American Airlines"],
  },
};

// ---------- bing avatar lookup (same flow as ingest-creator-avatars.mjs) -----

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const BING_THUMB_HOST_RE = /^ts\d+\.(?:mm|explicit)\.bing\.net$/;

async function bingHeadshot(query) {
  const u = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1`;
  let html;
  try {
    const r = await fetch(u, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return null;
    html = await r.text();
  } catch {
    return null;
  }
  const matches = html.match(/class="iusc"[^>]*m="([^"]+)"/g) ?? [];
  for (const m of matches) {
    const raw = m.match(/m="([^"]+)"/)?.[1];
    if (!raw) continue;
    const decoded = raw
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'");
    let obj;
    try { obj = JSON.parse(decoded); } catch { continue; }
    if (typeof obj.turl !== "string" || !obj.turl) continue;
    try {
      const host = new URL(obj.turl).hostname;
      if (BING_THUMB_HOST_RE.test(host)) {
        // Validate
        const probe = await fetch(obj.turl, {
          headers: { "User-Agent": UA },
          signal: AbortSignal.timeout(10_000),
        });
        if (!probe.ok) continue;
        const ct = probe.headers.get("content-type") ?? "";
        if (!ct.startsWith("image/")) continue;
        const buf = await probe.arrayBuffer();
        if (buf.byteLength < 500) continue;
        return obj.turl;
      }
    } catch { continue; }
  }
  return null;
}

// ---------- main ---------------------------------------------------

console.log("Searching Bing for Madison Waller headshot…");
const avatarUrl = await bingHeadshot("Madison Waller goinggonemadd travel blog");
console.log(`  avatar_url = ${avatarUrl ?? "(none found, will leave null)"}\n`);

console.log("Upserting creators row…");
const { data: row, error: upsertErr } = await sb
  .from("creators")
  .upsert(
    {
      slug: SLUG,
      name: NAME,
      bio: BIO,
      avatar_url: avatarUrl,
      voice_prompt: VOICE_PROMPT,
      taste_profile: TASTE_PROFILE,
      hidden: false,
    },
    { onConflict: "slug" }
  )
  .select("id, slug, name, hidden, avatar_url")
  .single();

if (upsertErr) {
  console.error("Upsert failed:", upsertErr.message);
  process.exit(1);
}

console.log("Creator row:");
console.log(JSON.stringify(row, null, 2));

// Count products (will be 0 — ShopMy not scrapable this pass)
const { count: productCount } = await sb
  .from("products")
  .select("*", { count: "exact", head: true })
  .eq("creator_id", row.id);
console.log(`\nProduct count for ${SLUG}: ${productCount ?? 0}`);
console.log(
  "  (ShopMy storefront is a JS-rendered SPA — products were NOT " +
    "fetchable. No rows inserted. To populate: browser-driven scrape, " +
    "or have Madison export the storefront to CSV.)"
);
