-- 009: Add `featured` flag to creator_products for the "tight default
-- edit" + "Shop everything" pattern.
--
-- Per-creator curated set: a creator picks 20-30 of their best
-- tryable pieces, JD marks them via SQL UPDATE in Supabase Studio,
-- and the Shop grid surfaces ONLY those by default. A "Shop
-- everything" control (`?all=1` query param) bypasses the filter
-- and serves the full catalog.
--
-- Fallback when no rows are featured for a creator: the grid route
-- serves the full catalog (so a new creator doesn't get an empty
-- page until JD marks their picks).
--
-- Sort path (separate from this column): tryable-first ordering
-- (tops/bottoms/dresses/outerwear before bags/shoes/jewelry/beauty/
-- home/swim/other), then created_at DESC as a recency tiebreak.
-- All sort logic lives in the products route; this column just
-- gates which rows are eligible to be sorted at all in the default
-- view.

ALTER TABLE public.creator_products
  ADD COLUMN IF NOT EXISTS featured BOOLEAN NOT NULL DEFAULT false;

-- Partial index: only featured rows. Default Shop query filters
-- WHERE creator_id = $1 AND featured = true; a 20-30-row partial
-- index is tiny and answers the default view in O(featured-count).
CREATE INDEX IF NOT EXISTS creator_products_featured_idx
  ON public.creator_products (creator_id, created_at DESC)
  WHERE featured = true;

-- Example: marking Jane Smith's 25 picks (run in Supabase Studio
-- after eyeballing the catalog). Replace with the actual product ids.
--
--   UPDATE public.creator_products
--      SET featured = true
--    WHERE creator_id = (SELECT id FROM public.creators WHERE slug='janesmith')
--      AND id IN (
--        'uuid-1', 'uuid-2', ..., 'uuid-25'
--      );
--
-- Unfeature a row: SET featured = false WHERE id = '...';
-- Wipe the edit:   UPDATE creator_products SET featured = false
--                   WHERE creator_id = (...) AND featured = true;
