/**
 * Mai's grounding context.
 *
 * Mai is one assistant with one voice; the creator-specific
 * grounding (catalog, content, preferred brands) is injected at
 * request time. Today the grounding is a single creator (the page
 * the user is on). Tomorrow it can be a set -- a follower's
 * multiple followed creators feeding Mai the union of their picks.
 *
 * The `sources: GroundingSource[]` shape is deliberately an array
 * even though v1 always has length 1. That way multi-creator
 * grounding is a data change, not a wiring change: retrieval,
 * dedup, honesty checks, and the prompt formatter all iterate over
 * `sources` already.
 */

import { supabaseAdmin } from "@/lib/supabase";
import type { Creator } from "@/lib/types";

/**
 * Row shape the chat pipeline uses for a catalog item. Matches the
 * existing CatalogRow in chat/route.ts so we can migrate the file
 * without changing every downstream consumer.
 */
export type CatalogRow = {
  id: string;
  name: string;
  brand: string | null;
  category: string | null;
  price: number | null;
};

/**
 * A chunk of a creator's blog/content, stored in creator_content
 * by the onboarding pipeline. Mai reads these for travel /
 * restaurant / hotel / lifestyle answers.
 */
export type ContentChunk = {
  id: string;
  sourceUrl: string;
  kind: string;
  text: string;
  chunkIndex: number;
};

export type GroundingSource = {
  slug: string;
  name: string;
  firstName: string;
  catalog: CatalogRow[];
  contentChunks: ContentChunk[];
  /** Brands the creator shops most, derived deterministically from
   *  catalog counts. Feeds the retrieval booster; no LLM step. */
  preferredBrands: Set<string>;
};

/**
 * Pull the top-N brands by row count from a catalog slice. Used
 * as the retrieval boost so items from brands the creator actually
 * shops land higher in the prompt window. Replaces the old
 * taste_profile.fashion.brands_loved read; that column was the LLM
 * voice-gen output and no longer exists in the Mai flow.
 */
export function derivePreferredBrands(
  catalog: CatalogRow[],
  topN = 15
): Set<string> {
  const counts = new Map<string, number>();
  for (const row of catalog) {
    if (!row.brand) continue;
    const key = row.brand.trim().toLowerCase();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return new Set(sorted.slice(0, topN).map(([b]) => b));
}

/**
 * Retrieve content chunks from creator_content that plausibly
 * match the user's message. v1 retrieval is keyword ILIKE on
 * text_chunk (same tradeoff as the catalog-side type filter);
 * v2 will swap in pgvector for semantic similarity.
 *
 * Table-tolerant: if migration 013 hasn't been applied yet
 * (Postgres returns 42P01 for missing table), we log once and
 * return []; the chat degrades to catalog-only grounding rather
 * than 500'ing.
 */
export async function loadContentChunks(
  creatorId: string,
  userMessage: string,
  limit = 8
): Promise<ContentChunk[]> {
  const sb = supabaseAdmin();
  // Pull the top few keyword tokens from the message. Skip short
  // words (< 4 chars) and common filler. Not a full NLP pipeline;
  // just enough signal to gate the LIKE.
  const tokens = extractKeywordTokens(userMessage);
  if (tokens.length === 0) return [];
  let q = sb
    .from("creator_content")
    .select("id, source_url, kind, text_chunk, chunk_index")
    .eq("creator_id", creatorId)
    .limit(limit);
  const clauses = tokens
    .map((t) => `text_chunk.ilike.%${escapeIlike(t)}%`)
    .join(",");
  q = q.or(clauses);
  const { data, error } = await q;
  if (error) {
    // 42P01 = relation does not exist. Migration 013 not applied
    // yet. Graceful degrade -- chat works, just no content grounding.
    if (error.code === "42P01") {
      console.warn(
        "[mai/context] creator_content not migrated yet (013); content grounding disabled"
      );
      return [];
    }
    console.error("[mai/context] creator_content query failed:", error);
    return [];
  }
  type Row = {
    id: string;
    source_url: string;
    kind: string;
    text_chunk: string;
    chunk_index: number;
  };
  return ((data ?? []) as Row[]).map((r) => ({
    id: r.id,
    sourceUrl: r.source_url,
    kind: r.kind,
    text: r.text_chunk,
    chunkIndex: r.chunk_index,
  }));
}

const STOPWORDS = new Set([
  "about", "again", "against", "also", "always", "any", "anyone", "because",
  "been", "before", "being", "between", "both", "cannot", "could", "does",
  "doing", "down", "each", "either", "even", "ever", "every", "everyone",
  "from", "get", "getting", "give", "going", "gonna", "have", "having",
  "help", "here", "into", "just", "know", "like", "looking", "make",
  "making", "many", "maybe", "might", "more", "most", "much", "need",
  "never", "next", "nice", "only", "other", "over", "please", "pretty",
  "really", "same", "sending", "should", "show", "some", "someone", "still",
  "such", "sure", "take", "than", "that", "their", "them", "then", "there",
  "these", "they", "thing", "things", "think", "this", "those", "through",
  "under", "using", "very", "want", "wants", "well", "were", "what", "when",
  "where", "which", "while", "will", "with", "without", "would", "yeah",
  "you", "your", "yours",
]);

function extractKeywordTokens(message: string): string[] {
  const lc = (message || "").toLowerCase();
  const raw = lc.split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    if (STOPWORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 8) break;
  }
  return out;
}

function escapeIlike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * Assemble a GroundingSource from a creators row + a pre-loaded
 * catalog slice + a content-chunks slice. Kept separate from the
 * data loaders so tests can synthesize a source without a live
 * DB.
 */
export function makeGroundingSource(args: {
  creator: Pick<Creator, "slug" | "name">;
  catalog: CatalogRow[];
  contentChunks: ContentChunk[];
}): GroundingSource {
  const firstName = args.creator.name.trim().split(/\s+/)[0];
  return {
    slug: args.creator.slug,
    name: args.creator.name,
    firstName,
    catalog: args.catalog,
    contentChunks: args.contentChunks,
    preferredBrands: derivePreferredBrands(args.catalog),
  };
}

/**
 * The full request-time context. Retrieval + honesty flags are
 * carried alongside the sources so the prompt formatter has
 * everything it needs.
 */
export type MaiRequestContext = {
  sources: GroundingSource[];
  userMessage: string;
  budgetCeiling: number | null;
  excludeIds: Set<string>;
  requestedTypes: string[];
  catalogRelaxLevel: "exact" | "soft_relaxed" | "type_relaxed" | "broad";
  recentlyShownText: string;
  productRequest: boolean;
};
