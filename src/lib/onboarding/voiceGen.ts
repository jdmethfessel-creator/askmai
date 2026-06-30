/**
 * LLM voice + taste profile generator for the self-serve creator
 * onboarding pipeline. Produces the same two fields the chat reads
 * from creators (voice_prompt, taste_profile) in the same shape
 * scripts/seed.mjs hand-writes them today.
 *
 * Safeguard (c) from the onboarding spec: the model MUST output
 * valid JSON in the expected shape, or the pipeline can never go
 * live with malformed data the Ask chat would crash on. Tool-use
 * forces a schema-constrained tool_call instead of free-form text;
 * we validate the tool_call args against the same TS shape the
 * chat consumes and retry up to MAX_RETRIES times with the
 * validation error fed back to Claude. If all attempts fail, a
 * minimal templated fallback synthesized from the inputs ships so
 * the page is never blocked on generation.
 *
 * Cost: ~6-10K input tokens (one-shot reference + creator inputs +
 * top 30 product picks) + ~2K output tokens per attempt. Roughly
 * $0.05-0.15 per onboard at sonnet-4-6 rates. Cheap.
 *
 * Quality caveat (flagged honestly to the user up front): without
 * the creator's interview text, this drops to ~30-40% of a
 * hand-written voice. With a real interview + blog text, ~50-70%.
 * The signup form pushes hard for interview text for this reason.
 */

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 4096;
const MAX_RETRIES = 2;

/**
 * The shape the chat consumes (see seed.mjs for the canonical
 * example). taste_profile is flexible jsonb in Supabase but the
 * chat's system prompt expects these top-level sections. Optional
 * fields per section so the model can omit ones the creator's
 * inputs don't support (e.g. a fashion-only creator skipping
 * dining/travel sections).
 */
export type GeneratedVoice = {
  voice_prompt: string;
  taste_profile: {
    identity: {
      name: string;
      based_in?: string;
      role?: string;
      background?: string;
      philosophy?: string;
      owned_brands?: Array<{
        name: string;
        aliases?: string[];
        store_url?: string;
        category?: string;
      }>;
    };
    fashion?: {
      style_philosophy?: string;
      inspiration?: string[];
      closet_essentials?: string[];
      summer_uniform?: string;
      brands_loved?: string[];
      jewelry?: string;
      location_styling?: string;
    };
    beauty?: {
      approach?: string;
      skincare?: string[];
      makeup?: string[];
      sleep_wellness?: string[];
    };
    dining?: Record<string, unknown>;
    lifestyle?: Record<string, unknown>;
    travel?: {
      style?: string;
      favorites?: Array<{
        city: string;
        hotel?: string;
        note?: string;
      }>;
    };
  };
};

export type VoiceGenInputs = {
  name: string;
  bioHint?: string;
  igHandle?: string;
  tiktokHandle?: string;
  blogTexts: Array<{ url: string; text: string }>;
  interviewText: string;
  /** Top N ingested products (name + brand + category), used as a
   *  taste signal when the creator's prose is thin. The voice
   *  generator infers brands_loved from these when the creator
   *  didn't list any. */
  productSamples: Array<{
    name: string;
    brand: string | null;
    category: string | null;
  }>;
};

export type VoiceGenResult = {
  voice: GeneratedVoice;
  /** "llm" when the model produced valid output, "fallback" when
   *  all retries failed and the templated minimum shipped. The
   *  signup response surfaces this so the creator knows whether to
   *  fix their voice via the edit link. */
  source: "llm" | "fallback";
  attempts: number;
  /** Joined-with-newline error strings from failed attempts.
   *  Empty when source="llm" on the first try. */
  errors: string[];
};

/**
 * Tool schema. The MUST-be-set fields are name + voice_prompt +
 * taste_profile.identity.name. Everything else is optional so the
 * model can skip sections the creator's inputs don't justify.
 *
 * voice_prompt has a minLength so a 3-line "be friendly" stub
 * can't satisfy the schema; the prompt instructs the model to
 * emit a structured multi-section guide mirroring seed.mjs.
 */
const TOOL_NAME = "submit_creator_voice";
const TOOL_SCHEMA = {
  type: "object" as const,
  required: ["voice_prompt", "taste_profile"],
  properties: {
    voice_prompt: {
      type: "string" as const,
      minLength: 400,
      description:
        "Multi-paragraph voice/style guide written in the same shape as scripts/seed.mjs. Sections: HOW SHE TALKS, THINGS THAT KILL THE VIBE, QUESTIONS, WHEN IN DOUBT, ANSWER SHAPE, NO VIBE FILLER. Concrete bans (banned phrases), specific brand mentions, real do/don't rules. No marketing language about the prompt itself.",
    },
    taste_profile: {
      type: "object" as const,
      required: ["identity"],
      properties: {
        identity: {
          type: "object" as const,
          required: ["name"],
          properties: {
            name: { type: "string" as const },
            based_in: { type: "string" as const },
            role: { type: "string" as const },
            background: { type: "string" as const },
            philosophy: { type: "string" as const },
            owned_brands: {
              type: "array" as const,
              items: {
                type: "object" as const,
                required: ["name"],
                properties: {
                  name: { type: "string" as const },
                  aliases: {
                    type: "array" as const,
                    items: { type: "string" as const },
                  },
                  store_url: { type: "string" as const },
                  category: { type: "string" as const },
                },
              },
            },
          },
        },
        fashion: {
          type: "object" as const,
          properties: {
            style_philosophy: { type: "string" as const },
            inspiration: {
              type: "array" as const,
              items: { type: "string" as const },
            },
            closet_essentials: {
              type: "array" as const,
              items: { type: "string" as const },
            },
            summer_uniform: { type: "string" as const },
            brands_loved: {
              type: "array" as const,
              items: { type: "string" as const },
            },
            jewelry: { type: "string" as const },
            location_styling: { type: "string" as const },
          },
        },
        beauty: {
          type: "object" as const,
          properties: {
            approach: { type: "string" as const },
            skincare: {
              type: "array" as const,
              items: { type: "string" as const },
            },
            makeup: {
              type: "array" as const,
              items: { type: "string" as const },
            },
            sleep_wellness: {
              type: "array" as const,
              items: { type: "string" as const },
            },
          },
        },
        dining: { type: "object" as const, additionalProperties: true },
        lifestyle: { type: "object" as const, additionalProperties: true },
        travel: {
          type: "object" as const,
          properties: {
            style: { type: "string" as const },
            favorites: {
              type: "array" as const,
              items: {
                type: "object" as const,
                required: ["city"],
                properties: {
                  city: { type: "string" as const },
                  hotel: { type: "string" as const },
                  note: { type: "string" as const },
                },
              },
            },
          },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are a senior fashion-tech editor writing a voice + taste guide for a creator's AI twin on the AskMai platform. The voice guide and taste profile you produce will be used as the system prompt for an LLM that responds to fans as the creator. So your job is to capture how THEY talk and what THEY actually shop, not to write generic style advice.

Your output MUST be a single submit_creator_voice tool call. Do not write any free-form prose -- everything goes inside the tool's arguments.

VOICE_PROMPT WRITING RULES:
- Mirror the structure of high-quality reference voices: multiple labeled sections (HOW SHE TALKS, THINGS THAT KILL THE VIBE, QUESTIONS, WHEN IN DOUBT, ANSWER SHAPE, NO VIBE FILLER). The chat's runtime reads these as section headers; preserve them.
- Be specific. Name actual phrases the creator uses, specific banned wrap-ups, specific brands she actually wears. "She's casual" is useless; "She drops 'tbh' and 'real talk' but never 'literally'" is useful.
- Pull voice cues from the INTERVIEW TEXT and BLOG TEXT inputs verbatim. If the creator's prose has tics ("ok so", "the move is", lowercase starts), call them out.
- Pull taste from the PRODUCT SAMPLES. The brands the creator actually buys are her taste; the LLM consuming this guide will trust the brand list as the lens for filtering catalog results.
- BAN markers: list specific filler / wrap-up / AI-isms to never use. Modeled on the seed.mjs example: forbidden closers, hedging, marketing language, etc. At least 8 specific banned phrases.
- No meta language ("This guide instructs..."); write the voice_prompt AS IF you were briefing a new co-writer on the creator's voice.

TASTE_PROFILE WRITING RULES:
- identity.name = the creator's display name. Required.
- identity.role / background / philosophy: pull from interview/blog text. If absent, infer from product samples + handles (e.g. "Fashion creator on Instagram (@handle), prefers [brands she shops most]").
- fashion.brands_loved: derive from the product samples' brand column. List 8-15 brands she actually has in her catalog. This is the load-bearing field -- the Ask chat boosts catalog rows by these brands.
- fashion.style_philosophy + closet_essentials: infer from product samples + interview. Concrete (e.g. "loose trouser, fitted tee, gold jewelry") not vague.
- beauty / dining / lifestyle / travel: only include when the creator's inputs justify them. A pure-fashion creator can omit dining and travel entirely.
- owned_brands: only when the creator has explicitly mentioned her own brand. Don't invent.

LENGTH:
- voice_prompt: 1500-3000 characters across sections. Less than 1500 is a stub.
- Each taste_profile section: as long as needed, no padding.

You are writing for an LLM, not a human. Be dense, be concrete, ban filler.`;

/**
 * One-shot reference example. Embedded so the model can see what a
 * complete, production-quality output looks like before generating
 * for a new creator. Same shape as seed.mjs's hand-authored Cass
 * voice / taste, condensed for token budget. Prompt-cached on the
 * Anthropic side via cache_control so we don't pay for this on
 * every call.
 */
const REFERENCE_EXAMPLE = `Here is the shape of a known-good output for reference (do NOT copy these brands or phrasing for a different creator; this is a structural example only):

voice_prompt example (~3KB):

  You are Cass DiMicco texting back from her phone. Not an AI assistant being helpful. A real person with strong taste who happens to be replying.

  HOW SHE TALKS
  - Texting, not writing. Fragments are fine. Lengths vary. Sometimes one line is the whole reply.
  - Opinionated. "skip that." "don't bother." "this one's worth it." "no, the other one."
  - Direct. Says the thing and stops. Doesn't justify every pick with a balanced rationale.
  - Casual rhythm. Lowercase often, especially at the start. Comma splices happen.
  - Warm, not bubbly. Friendly, not relentlessly helpful.
  - No emojis. No marketing language. No "elevated," "curated," "intentional" -- that's how brands talk.

  THINGS THAT KILL THE VIBE -- never use these
  - Filler emphasis: "honestly," "genuinely," "truly," "for real," "really"
  - Tidy wrap-ups: "that's most of the work," "that's the move," "and you're set"
  - AI hedging: "I'd consider," "you might want to look at," "happy to help"
  - Reassurance padding after naming a pick.

  QUESTIONS
  - 1 in 3 replies ends with a follow-up question, only when actually natural.

  WHEN IN DOUBT
  - Shorter wins. If unsure, "haven't tried it" / "no take on that one."

  ANSWER SHAPE (non-negotiable)
  - Lead with a take, not a product list. Products are the conclusion of an opinion.

  NO VIBE FILLER
  - Cut empty descriptor phrases. Banned closers: "clean, no fuss," "easy," "effortless," "elevated," "minimal," "fuss-free," "can't go wrong," "chef's kiss."
  - THE TEST: if you can delete the phrase and lose zero info, delete it.

taste_profile example:
  {
    "identity": {
      "name": "Cass DiMicco",
      "based_in": "Miami (formerly NYC)",
      "role": "Fashion creator, founder of Aureum jewelry",
      "background": "OG Instagram fashion influencer since 2014, ~1M following",
      "philosophy": "Minimalist, intentional, only shares when she has something to say",
      "owned_brands": [{ "name": "Aureum", "aliases": ["Aureum Collective"], "category": "accessories" }]
    },
    "fashion": {
      "style_philosophy": "Neutral and minimal clothing, interest added through accessories, an element of sexiness kept effortless",
      "inspiration": ["Pinterest", "90s street style", "celebrity street style"],
      "closet_essentials": ["basic black and white tops", "black knee-high boots", "loose trousers", "silk midi skirts"],
      "brands_loved": ["The Row", "The Frankie Shop", "Khaite", "Isabel Marant", "Acne Studios", "Dion Lee", "By Far", "Alaïa"],
      "jewelry": "Always wears Aureum; prefers gold over silver"
    },
    "beauty": { "approach": "Minimalist, low-step routines", "skincare": ["U Beauty resurfacing", "EltaMD SPF"] }
  }
`;

export async function generateVoice(
  inputs: VoiceGenInputs
): Promise<VoiceGenResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      voice: fallbackVoice(inputs),
      source: "fallback",
      attempts: 0,
      errors: ["missing_anthropic_api_key"],
    };
  }
  const client = new Anthropic();
  const userMessage = buildUserMessage(inputs);
  const errors: string[] = [];

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      const messages: Anthropic.MessageParam[] = [
        { role: "user", content: userMessage },
      ];
      // On retry, append the validator's complaint as a user
      // message so the model knows exactly what to fix.
      if (errors.length > 0) {
        messages.push({
          role: "assistant",
          content:
            "I will now retry the submit_creator_voice tool call.",
        });
        messages.push({
          role: "user",
          content: `Your previous attempt failed validation: ${errors[errors.length - 1]}. Retry the submit_creator_voice tool call with the correction. Do not write any prose; only emit the tool call.`,
        });
      }
      const res = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
          {
            type: "text",
            text: REFERENCE_EXAMPLE,
            cache_control: { type: "ephemeral" },
          },
        ],
        tools: [
          {
            name: TOOL_NAME,
            description:
              "Submit the generated voice_prompt and taste_profile for this creator. MUST be the only output of the assistant turn.",
            input_schema: TOOL_SCHEMA,
          },
        ],
        tool_choice: { type: "tool", name: TOOL_NAME },
        messages,
      });
      const toolBlock = res.content.find(
        (b) => b.type === "tool_use" && b.name === TOOL_NAME
      );
      if (!toolBlock || toolBlock.type !== "tool_use") {
        errors.push(`attempt_${attempt}: no_tool_use_block`);
        continue;
      }
      const parsed = validateVoiceShape(toolBlock.input as unknown, inputs.name);
      if (parsed.ok) {
        return {
          voice: parsed.value,
          source: "llm",
          attempts: attempt,
          errors,
        };
      }
      errors.push(`attempt_${attempt}: ${parsed.error}`);
    } catch (err) {
      errors.push(
        `attempt_${attempt}: ${err instanceof Error ? err.message : "unknown"}`
      );
    }
  }
  return {
    voice: fallbackVoice(inputs),
    source: "fallback",
    attempts: MAX_RETRIES + 1,
    errors,
  };
}

function buildUserMessage(inputs: VoiceGenInputs): string {
  const lines: string[] = [];
  lines.push(`Write the voice + taste profile for: ${inputs.name}`);
  if (inputs.bioHint) lines.push(`\nBio hint (creator's own short bio):\n${inputs.bioHint}`);
  if (inputs.igHandle) lines.push(`Instagram: ${inputs.igHandle}`);
  if (inputs.tiktokHandle) lines.push(`TikTok: ${inputs.tiktokHandle}`);
  if (inputs.interviewText) {
    lines.push(
      `\nINTERVIEW TEXT (primary source for voice -- mine this for tics, phrasing, opinions):\n${inputs.interviewText}`
    );
  }
  const blogText = inputs.blogTexts
    .filter((b) => b.text.length > 0)
    .map((b) => `[${b.url}]\n${b.text}`)
    .join("\n\n---\n\n");
  if (blogText) {
    lines.push(
      `\nBLOG / EXTERNAL TEXT (secondary voice source -- pull phrasing patterns + topic interests):\n${blogText}`
    );
  }
  if (inputs.productSamples.length > 0) {
    lines.push(
      `\nPRODUCT SAMPLES (top ${inputs.productSamples.length} catalog items -- THIS IS THE TASTE SIGNAL; brands_loved must come from this):`
    );
    for (const p of inputs.productSamples) {
      lines.push(
        `  - ${p.brand ?? "(no brand)"} - ${p.name}${p.category ? ` [${p.category}]` : ""}`
      );
    }
  }
  if (!inputs.interviewText && blogText.length === 0) {
    lines.push(
      `\nNOTE: no interview or blog text provided. Voice will be inferred from product samples + name only. Keep the voice direct and brand-led; mark VOICE WAS INFERRED FROM PRODUCT SIGNAL ONLY in the philosophy field so the creator knows to tune it via the edit link.`
    );
  }
  return lines.join("\n");
}

type ValidationResult =
  | { ok: true; value: GeneratedVoice }
  | { ok: false; error: string };

function validateVoiceShape(raw: unknown, creatorName: string): ValidationResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "tool_args_not_object" };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.voice_prompt !== "string") {
    return { ok: false, error: "voice_prompt_not_string" };
  }
  if (obj.voice_prompt.length < 400) {
    return {
      ok: false,
      error: `voice_prompt_too_short_${obj.voice_prompt.length}`,
    };
  }
  if (!obj.taste_profile || typeof obj.taste_profile !== "object") {
    return { ok: false, error: "taste_profile_not_object" };
  }
  const tp = obj.taste_profile as Record<string, unknown>;
  if (!tp.identity || typeof tp.identity !== "object") {
    return { ok: false, error: "taste_profile_identity_missing" };
  }
  const identity = tp.identity as Record<string, unknown>;
  if (typeof identity.name !== "string" || !identity.name.trim()) {
    return { ok: false, error: "taste_profile_identity_name_missing" };
  }
  // Light coercion: ensure identity.name matches the creator's
  // submitted name even if the model paraphrased.
  identity.name = creatorName;
  return { ok: true, value: obj as unknown as GeneratedVoice };
}

/**
 * Minimum-viable voice + taste so a creator's page can still go
 * live when the LLM path fails three times. Hand-templated from
 * the creator's own inputs so it isn't generic boilerplate. The
 * completion email flags voice_source="fallback" and links the
 * creator to the edit page so they can tune it.
 */
function fallbackVoice(inputs: VoiceGenInputs): GeneratedVoice {
  const brands = uniqueBrands(inputs.productSamples).slice(0, 15);
  const brandList =
    brands.length > 0 ? brands.join(", ") : "the brands she actually shops";
  return {
    voice_prompt: `You are ${inputs.name} replying to a fan. Real person, real taste, not a chatbot. Speak in first person, casual register, fragments OK, never "as an AI" or "happy to help." When the user asks for a product, lead with a take in your voice ("the move is X for Y reason"), then name the actual pick. Pull only from brands you actually shop: ${brandList}. Skip vague descriptor filler like "elevated" / "curated" / "minimal" / "effortless" / "easy" / "you're set" / "chef's kiss" -- ban these closers. About 1 reply in 3 ends with a follow-up question; the other 2 just answer and stop. If you don't know something, say "haven't tried it" rather than making it up. Real names, not categories. No emojis. THIS VOICE WAS GENERATED FROM PRODUCT SIGNAL ONLY (no interview text was provided) -- tune it via the edit link in your welcome email so the AI twin sounds like you, not a generic creator.`,
    taste_profile: {
      identity: {
        name: inputs.name,
        role: inputs.bioHint
          ? inputs.bioHint
          : `Creator on ${inputs.igHandle ? `Instagram ${inputs.igHandle}` : "social"}`,
        philosophy: "AUTO-GENERATED FROM PRODUCT SIGNAL ONLY",
      },
      fashion: {
        brands_loved: brands,
      },
    },
  };
}

function uniqueBrands(
  products: VoiceGenInputs["productSamples"]
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of products) {
    const b = (p.brand ?? "").trim();
    if (!b) continue;
    const key = b.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(b);
  }
  return out;
}
