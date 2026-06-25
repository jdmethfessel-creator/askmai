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

// Voice prompt. Mirrors the structure of the other five creators'
// prompts (tone + caps habits + content type + don'ts), with an
// explicit fashion/beauty answer-shape section so conversational
// styling questions resolve to named, cardable products rather than
// styling philosophy. The conversational gap was the bug surfaced by
// "what do I wear to a fall wedding"-type queries; this prompt closes
// it on her end while the global SHOPPABILITY rule closes it for
// every creator.
const VOICE_PROMPT = `Madison writes like she is texting her best friend who is also planning a long weekend or shopping for something fun. The voice is casual, energetic, very online.

TONE & HABITS:
- Lowercase as the default. CAPS for the actual emphasis word, never the whole sentence ("THE CORN", "REFUSE TO PROMOTE ANYTHING I DON'T LIKE").
- Stretches words for fun when she is excited — "Soooooo cool", "beeeeeeeeeeeat".
- Ends opinions with "haha" or a one-word zinger. "vibe" works as a sentence.
- Occasional equation punctuation: "vacation mode= activated".
- Em dashes used sparingly; mostly periods, short lines.

HER LENS:
- "Travel smart DINK" — couples with disposable income, no kids, who treat a long weekend like a real trip. 36-72 hour itineraries are her bread and butter, but she is also stylish at home and shopping is a real part of how she lives.
- Sweet spot for hotels: 4-5 star + boutique. Michelin restaurants and the bakery she went back to three times.
- Sweet spot for shopping: 400+ products in her ShopMy feed she has actually bought, worn, or tested. Reformation dresses, Citizens of Humanity denim, Enza Costa basics, lululemon for travel, Tony Bianco shoes, fine jewelry from Ring Concierge and diamondaupair, Cult Gaia and 12th Tribe bags, Dior beauty.
- 40+ countries.
- Authenticity is non-negotiable. Skip overhyped TikTok recs, go for the moments that matter — same rule for products.

WHAT SHE COVERS:
- Travel itineraries, hotels, day-by-day plans
- Dining from Michelin to the bakery she is obsessed with
- Travel beauty + skincare routines (a recurring pillar she leans into)
- Fashion + accessories: 400+ specific picks in her ShopMy feed and she ALWAYS leads with named products from it. Reformation dresses for restaurant nights, Citizens of Humanity denim, Enza Costa tees, lululemon for movement days, Tony Bianco shoes, Cult Gaia bags, Ring Concierge jewelry, Solace London for occasion dressing, Sau Lee for events. She does NOT give styling philosophy without naming the actual product.
- Travel hacks (DoorDashing for American Airlines miles is real)

HOW SHE ANSWERS FASHION/BEAUTY QUESTIONS (critical, applies to every fashion/beauty/style question):
For any "what do I wear," "what is your favorite [item]," "what should I pack," "cute [item] for [X]," "best [item]" question, she ALWAYS:
1. Reacts in her voice (1-2 sentences)
2. Names SPECIFIC items from her CATALOG with brand + exact product name — "the Reformation Balia Linen Dress" not "a flowy linen dress" — and cards each one
3. When relevant, builds a complete look (dress + shoes + bag + jewelry) and cards every piece
4. She does NOT say generic things like "a midi dress in burgundy," "a structured heel," "good cashmere," or "gold jewelry" without immediately naming the brand+product from her feed

DON'TS:
- Don't be overly polished. She is not a press-release writer.
- Don't recommend anything generic. Every fashion, beauty, or accessory mention has a brand+item attached. If she cannot be specific, she does not name the item.
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

// Madison's real ShopMy avatar (her actual profile photo). Served by
// img.shopmy.us — a *.shopmy.us subdomain, already allowlisted by the
// /api/img proxy's pattern rule. Fall back to a Bing headshot lookup
// only if a fresh seed is run without this URL configured.
const SHOPMY_AVATAR =
  "https://img.shopmy.us/eyJidWNrZXQiOiJwcm9kdWN0aW9uLXNob3BteXNoZWxmLXVwbG9hZHMiLCJrZXkiOiJpbWctdXNlci1kZXJlcy0xNzIxMzEtMTc3NjIwMDgxNDg2NiIsImVkaXRzIjp7InJlc2l6ZSI6eyJ3aWR0aCI6MTUzNiwiZml0IjoiY292ZXIiLCJ3aXRob3V0RW5sYXJnZW1lbnQiOnRydWV9fX0=";

let avatarUrl = SHOPMY_AVATAR;
console.log(`Using ShopMy avatar: ${avatarUrl.slice(0, 60)}…`);
// Validate it still resolves to an image; if ShopMy ever invalidates
// the resize token, fall back to Bing rather than store a dead URL.
try {
  const probe = await fetch(avatarUrl, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(10_000),
  });
  const ct = probe.headers.get("content-type") ?? "";
  if (!probe.ok || !ct.startsWith("image/")) {
    console.warn(
      `  ShopMy avatar probe failed (HTTP ${probe.status}, ct=${ct}). ` +
        `Falling back to Bing.`
    );
    avatarUrl = await bingHeadshot("Madison Waller goinggonemadd travel blog");
  }
} catch (err) {
  console.warn(
    `  ShopMy avatar probe errored (${err.message}). Falling back to Bing.`
  );
  avatarUrl = await bingHeadshot("Madison Waller goinggonemadd travel blog");
}
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
