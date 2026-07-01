-- 013: Grounding content per creator for Mai's non-fashion answers.
--
-- Mai (the AskMai styling assistant) recommends fashion/beauty from
-- the creator's creator_products catalog and everything else --
-- travel, restaurants, hotels, lifestyle -- from the creator's own
-- published content (blog posts, guides, city recs). This table
-- stores those content sources chunked into retrievable pieces so
-- Mai can pull the relevant passage at chat time instead of dumping
-- an entire blog into her context window.
--
-- v1 retrieval: keyword ILIKE against text_chunk (matches the
-- garment-type retrieval approach on creator_products). v2 will
-- swap in pgvector for semantic similarity across chunks and
-- catalog together; same table, new column.
--
-- Chunk sizing: onboarding pipeline chunks each fetched blog at
-- ~1500 chars with 200-char overlap. Longer chunks blow the prompt
-- budget; shorter chunks lose per-chunk context. Values kept in
-- src/lib/onboarding/blogScrape.ts so tuning stays in one place.
--
-- Reverse: DROP TABLE creator_content;

CREATE TABLE IF NOT EXISTS public.creator_content (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id  UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  -- Original URL the chunk came from. Kept for provenance so a
  -- future "which blog post did Mai pull this from?" surface can
  -- link back.
  source_url  TEXT NOT NULL,
  -- Free-form kind tag so future ingest paths can carry richer
  -- signal ('blog' | 'travel' | 'dining' | 'hotel' | 'other'). v1
  -- writes 'blog' for every scrape; classification is deferred to
  -- the chunker or a follow-up pass.
  kind        TEXT NOT NULL DEFAULT 'blog',
  -- Chunk text. Bounded ~1500 chars per row by the ingest chunker;
  -- TEXT here (not VARCHAR) so a future longer chunk doesn't need
  -- another migration.
  text_chunk  TEXT NOT NULL,
  -- Position within the source URL's chunk sequence. 0 = first
  -- chunk. Useful for reassembling context (Mai can pull chunk N
  -- and N+1 together when the match is at a chunk boundary) and
  -- for de-duping re-scrapes.
  chunk_index INT  NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS creator_content_creator_idx
  ON public.creator_content (creator_id);

CREATE INDEX IF NOT EXISTS creator_content_creator_kind_idx
  ON public.creator_content (creator_id, kind);

-- Natural key for re-scrapes: (creator_id, source_url, chunk_index).
-- When a creator hits "re-fetch my blog" the pipeline can wipe by
-- (creator_id, source_url) and re-insert cleanly.
CREATE INDEX IF NOT EXISTS creator_content_source_idx
  ON public.creator_content (creator_id, source_url);
