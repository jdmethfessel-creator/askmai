import Anthropic from "@anthropic-ai/sdk";
import { supabaseAdmin } from "@/lib/supabase";
import { resolveLink } from "@/lib/resolveLink";
import type { ChatMessage, Creator, Rec } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1024;
const MAX_HISTORY = 20;

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json(
      { error: "Server missing ANTHROPIC_API_KEY" },
      { status: 500 }
    );
  }

  let body: { slug?: string; message?: string; history?: ChatMessage[] };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const slug = body.slug?.trim();
  const message = body.message?.trim();
  if (!slug || !message) {
    return Response.json(
      { error: "slug and message are required" },
      { status: 400 }
    );
  }

  const { data, error } = await supabaseAdmin()
    .from("creators")
    .select("id, slug, name, bio, voice_prompt, taste_profile")
    .eq("slug", slug)
    .maybeSingle();

  if (error || !data) {
    return Response.json({ error: "Creator not found" }, { status: 404 });
  }

  const creator = data as Pick<
    Creator,
    "id" | "slug" | "name" | "bio" | "voice_prompt" | "taste_profile"
  >;
  const creatorId = creator.id;

  const catalog = await loadCatalog(creatorId, message);
  const creatorRef = { id: creatorId, slug: creator.slug };
  const systemPrompt = buildSystemPrompt(creator, catalog);
  const history = sanitizeHistory(body.history ?? []);

  const client = new Anthropic();

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages: [...history, { role: "user", content: message }],
  });

  const encoder = new TextEncoder();
  const RECS_MARKER = "---RECS---";

  const readable = new ReadableStream({
    async start(controller) {
      let pending = ""; // pre-marker tail we haven't decided about yet
      let pastMarker = false;
      let buffered = ""; // post-marker text (to be enriched)
      const HOLD = RECS_MARKER.length - 1;
      try {
        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            const text = event.delta.text;
            if (pastMarker) {
              buffered += text;
              continue;
            }
            const combined = pending + text;
            const markerIdx = combined.indexOf(RECS_MARKER);
            if (markerIdx !== -1) {
              const before = combined.slice(0, markerIdx);
              if (before.length > 0) {
                controller.enqueue(encoder.encode(before));
              }
              buffered = combined.slice(markerIdx + RECS_MARKER.length);
              pastMarker = true;
              pending = "";
            } else {
              // Hold back the last (markerLen - 1) chars in case the marker
              // straddles this and the next chunk.
              const safeEnd = Math.max(0, combined.length - HOLD);
              const safe = combined.slice(0, safeEnd);
              pending = combined.slice(safeEnd);
              if (safe.length > 0) controller.enqueue(encoder.encode(safe));
            }
          }
        }

        if (!pastMarker && pending.length > 0) {
          controller.enqueue(encoder.encode(pending));
        }

        if (pastMarker) {
          const enriched = await enrichRecsBlock(buffered, creatorRef);
          controller.enqueue(
            encoder.encode(`\n${RECS_MARKER}\n${JSON.stringify(enriched)}`)
          );
        }
        controller.close();
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Stream failed";
        controller.enqueue(encoder.encode(`\n\n[error: ${msg}]`));
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function enrichRecsBlock(
  raw: string,
  creator: { id: string; slug: string }
): Promise<Rec[]> {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const recs: Rec[] = parsed
    .filter((r): r is Rec => r && typeof r === "object" && "name" in r)
    .map((r) => ({
      name: String(r.name ?? ""),
      brand: r.brand ? String(r.brand) : undefined,
      category: String(r.category ?? "").toLowerCase(),
      price: r.price ? String(r.price) : undefined,
      why: String(r.why ?? ""),
      location:
        "location" in r && r.location ? String(r.location) : undefined,
      product_id:
        "product_id" in r && r.product_id ? String(r.product_id) : undefined,
      merchant_url:
        "merchant_url" in r && r.merchant_url
          ? String(r.merchant_url)
          : undefined,
    }));

  const enriched = await Promise.all(
    recs.map(async (rec) => {
      const resolved = await resolveLink(rec, creator);
      // For feed-tier results, override the model's text with the catalog row.
      // This is what guarantees the displayed product always matches the link.
      if (resolved.tier === "feed" && resolved.feed_product) {
        const fp = resolved.feed_product;
        return {
          ...rec,
          name: fp.name,
          brand: fp.brand ?? rec.brand,
          price: fp.price ?? rec.price,
          image_url: fp.image_url ?? rec.image_url,
          affiliate_url: resolved.url,
          tier: resolved.tier,
          product_id: resolved.matched_product_id,
        };
      }
      // Non-feed: keep the model's name/price; strip product_id so the client
      // doesn't display a stale reference.
      const { product_id: _ignored, ...rest } = rec;
      void _ignored;
      return {
        ...rest,
        affiliate_url: resolved.url,
        tier: resolved.tier,
      };
    })
  );
  return enriched;
}

type CatalogRow = {
  id: string;
  name: string;
  brand: string | null;
  category: string | null;
  price: number | null;
};

const CATEGORY_HINTS: { keywords: RegExp; categories: string[] }[] = [
  {
    keywords:
      /\b(skincare|moisturizer|serum|cleanser|sunscreen|spf|makeup|lipstick|blush|mascara|eyeliner|foundation|concealer)\b/i,
    categories: ["beauty"],
  },
  {
    keywords:
      /\b(boots?|shoes?|heels?|sandals?|sneakers?|bag|purse|handbag|tote|sunglasses?|belt|jewelry|necklace|earring|bracelet|hat)\b/i,
    categories: ["fashion", "accessories"],
  },
  {
    keywords:
      /\b(dress|skirt|top|tee|tshirt|t-shirt|trousers?|pants?|jeans?|denim|jacket|coat|blazer|sweater|knit|outfit|wear|wardrobe)\b/i,
    categories: ["fashion"],
  },
];

async function loadCatalog(
  creatorId: string,
  userMessage: string
): Promise<CatalogRow[]> {
  // For now, pull the entire catalog. With only ~50 items this fits comfortably
  // in the system prompt. If the message clearly maps to a category, narrow it.
  const sb = supabaseAdmin();
  const matched = new Set<string>();
  for (const hint of CATEGORY_HINTS) {
    if (hint.keywords.test(userMessage)) {
      for (const c of hint.categories) matched.add(c);
    }
  }
  let query = sb
    .from("products")
    .select("id, name, brand, category, price")
    .eq("creator_id", creatorId)
    .order("price", { ascending: false })
    .limit(80);
  if (matched.size > 0) {
    query = query.in("category", Array.from(matched));
  }
  const { data } = await query;
  return (data ?? []) as CatalogRow[];
}

function formatCatalogForPrompt(catalog: CatalogRow[]): string {
  if (catalog.length === 0) return "(empty)";
  return catalog
    .map((p) => {
      const price = p.price != null ? `$${p.price}` : "?";
      const brand = p.brand ?? "?";
      const cat = p.category ?? "?";
      return `  - id:${p.id} | ${brand} — ${p.name} | ${cat} | ${price}`;
    })
    .join("\n");
}

function sanitizeHistory(history: ChatMessage[]) {
  return history
    .filter(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim().length > 0
    )
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content }));
}

function buildSystemPrompt(
  c: Pick<Creator, "name" | "bio" | "voice_prompt" | "taste_profile">,
  catalog: CatalogRow[]
) {
  const tasteJson = c.taste_profile
    ? JSON.stringify(c.taste_profile, null, 2)
    : "(no taste profile yet)";

  const voice =
    c.voice_prompt ?? `Talk like ${c.name}. Be warm and concrete.`;

  const bio = c.bio ?? "";

  return `You are the AI of ${c.name}. You respond AS ${c.name}'s personal AI, speaking in their voice and grounded in their actual taste, to fans and visitors on her AskMai page.

${bio ? `About ${c.name}: ${bio}\n` : ""}

VOICE & STYLE GUIDE:
${voice}

TASTE PROFILE (ground truth for recommendations, do not invent contradicting brands or vibes):
${tasteJson}

GENERAL RULES:
- Stay in voice. Never break character or mention you are an LLM.
- Name specific products, brands, restaurants, or places from the taste profile when possible. If the exact pick isn't there, choose something that fits the same brands, price range, and style notes.
- Be concrete. Real names, not categories. No marketing fluff.
- If a question is outside ${c.name}'s areas, answer briefly and steer back toward what she actually knows.
- Never invent product links. The platform handles linking.
- Most replies should end with a light, natural follow-up question, the way a stylist friend would, to invite the next step. Keep it understated, never pushy. Not every reply needs one.

OUTPUT FORMAT:

When you are recommending 2–3 specific products, places, or hotels, structure your reply like this:

  [1–3 sentences of conversational intro in ${c.name}'s voice. Optionally end with a follow-up question.]
  ---RECS---
  [a JSON array of 2–3 recommendation objects, nothing else after it]

Each recommendation object:
{
  "product_id": "string (REQUIRED when picking from the CATALOG below; OMIT for off-catalog items)",
  "name": "string (product, restaurant, or hotel name)",
  "brand": "string (brand or designer; omit for restaurants/hotels)",
  "category": "fashion" | "beauty" | "accessories" | "dining" | "travel" | "lifestyle",
  "price": "string (approximate; e.g. \\"$280\\" for products, \\"$350/night\\" for hotels; omit if unknown)",
  "location": "string (only for travel/dining: 'Tulum, Mexico'; omit otherwise)",
  "merchant_url": "string (REQUIRED for off-catalog products; OMIT for catalog items, hotels, and restaurants — see rules below)",
  "why": "string (one short line in her voice, max 15 words, no marketing language)"
}

Rules:
- Emit the marker "---RECS---" on its OWN line.
- After the marker, output ONLY a valid JSON array. No prose, no markdown fences.
- 2 or 3 recommendations, best first.
- "why" is one tight line.

CATALOG (real products from ${c.name}'s feeds, with affiliate links the platform will attach):
${formatCatalogForPrompt(catalog)}

CATALOG RULES (read carefully — this is the fidelity rule):
- When you recommend a product that EXISTS in the CATALOG, you MUST:
   1. Set "product_id" to the exact id from the catalog line.
   2. Copy the catalog's "name" and "brand" EXACTLY. Do not paraphrase, rename, abbreviate, or invent a different model of the same brand. If the catalog has "Bella Knee-High Leather Boots" you write that, not "Olivier Heeled Knee Boot".
   3. Use the catalog "price" as written.
- When you recommend something NOT in the catalog (a cheaper alternative, or a brand/item that's not on her feed), OMIT "product_id" entirely and use natural product naming. The platform will route those through an aggregator link.
- Do NOT make up product_id values. If you're not 100% sure a product is in the catalog, omit product_id.
- Prefer catalog items when they fit the visitor's ask — that's where ${c.name} earns the best commission. Round out with non-catalog options when the catalog can't fully answer.

MERCHANT URL FOR OFF-CATALOG PRODUCTS:
- Only set "merchant_url" if you are CONFIDENT it is a real existing URL on a real merchant. Don't guess product slugs.
- When confident: use the canonical page on Sephora, Mytheresa, Net-a-Porter, Nordstrom, Revolve, FWRD, Saks, Shopbop, or Bloomingdale's.
- When NOT confident: OMIT "merchant_url". The platform will build a real merchant search URL automatically — that's preferable to a guessed slug that 404s.
- NEVER output placeholder, fake, or example URLs (no example.com, example.org, /out/aggregator). NEVER output already-affiliated URLs (no click.linksynergy.com, no go.skimresources.com, no rakuten.com).
- For catalog items (product_id set), hotels, restaurants, and pure conversational replies: OMIT "merchant_url" entirely.

ASPIRATIONAL → BOOKABLE TRANSLATION (travel):
${c.name}'s favorite hotels in the taste profile are her aspirational anchors, not a fixed shopping list. When a visitor asks for a hotel and either (a) names budget constraints, (b) asks for "something similar to" one of her favorites, or (c) names a destination not in her favorites, do this:

  1. In the intro, briefly acknowledge the reference hotel and the *underlying aesthetic qualities* that make it her pick (e.g., "Amangiri is special for its minimalist desert architecture, the way it disappears into the rock"). Translate the favorite into qualities: minimalist, design-led, intimate, nature-integrated, family-run, etc.
  2. In the recs array, return 2–3 ACTUAL bookable hotels that match those qualities AND fit the visitor's stated budget / destination. These should be real, existing, currently-operating properties she would plausibly endorse — small design-forward hotels, boutique resorts, well-designed inns. Each rec has category "travel" and includes "location".
  3. Set "price" to a per-night estimate when known (e.g. "$420/night").
  4. Do not just recommend her favorites if the budget excludes them; translate to affordable matches.

NEVER invent affiliate or "Book" URLs in your output — the platform appends them based on the rec name + location.

DINING / RESTAURANTS:
For restaurants, return the rec with category "dining" — the platform will render the card without a Shop/Book link, since restaurants aren't bookable through us. Still recommend specific named places, in her voice.

For pure conversational replies (general chat, clarifying questions, opinions with no specific items to recommend), write text only and do not include the marker or any JSON.`;
}
