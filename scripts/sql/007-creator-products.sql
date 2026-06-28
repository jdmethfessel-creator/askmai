-- =====================================================================
-- 007-creator-products.sql
--
-- Try-on grid (PHASE 1) — network-agnostic per-creator product catalog.
--
-- Apply manually via the Supabase SQL editor. Safe to re-run: every
-- column add, index, and constraint is guarded with IF NOT EXISTS or
-- ON CONFLICT.
--
-- This table is a NEW parallel surface, separate from the existing
-- public.products table that the chat pipeline reads from. Nothing in
-- the live chat / render / homepage path touches this table.
--
-- The model is intentionally network-agnostic: any affiliate source
-- (Shopbop hearts, Revolve favorites, FWRD wishlist, ShopMy collection,
-- pasted CSV, manual entry) lands here with the same shape. The
-- source_network column is free-form text so adding a new network is
-- a row-level concern, not a schema migration.
--
-- The affiliate_url column is the money column. It MUST be stored
-- byte-for-byte exactly as parsed from the source — every tracking
-- query param (extid, cvosrc, affuid, subid1 for Shopbop; utm_source,
-- siplt for Revolve/FWRD; <custom_id>-resolved u1 for ShopMy)
-- preserved. The Shop button in the new try-on grid (PHASE 2) opens
-- this URL byte-for-byte; never normalize, sort, or strip params.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.creator_products (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id          UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,

  -- Network identifier. Free-form text so a new source is a value
  -- choice, not a migration. Conventional values:
  --   'shopbop', 'revolve', 'fwrd', 'shopmy', 'manual', 'csv'
  source_network      TEXT NOT NULL,

  -- The network's own product identifier (Shopbop productSin, Revolve
  -- SKU code, FWRD code, ShopMy pin id). Used together with creator_id
  -- and source_network as the natural key for upserts. Nullable
  -- because pasted/manual entries may not have one.
  source_external_id  TEXT,

  product_title       TEXT NOT NULL,
  brand               TEXT,

  -- Two price columns by intent:
  --   price          numeric, used for budget filters and sorting.
  --   price_display  text, the source's exact display string ("$695",
  --                  "$45.00", "$1,295.00"). Phase 2 grid renders this
  --                  verbatim so currency / formatting matches the
  --                  source.
  price               NUMERIC(10, 2),
  price_display       TEXT,

  image_url           TEXT NOT NULL,

  -- The byte-for-byte stored affiliate URL. NEVER normalize.
  affiliate_url       TEXT NOT NULL,

  -- Loose taxonomy aligned with the existing chat pipeline's category
  -- vocabulary ('fashion', 'beauty', 'accessories', 'lifestyle',
  -- 'travel', 'dining'). Nullable; PHASE 2 grid can show "all" when
  -- absent.
  product_category    TEXT,

  -- Original parsed payload so we can rebuild a row from scratch
  -- without re-fetching the source page. Helpful for debugging the
  -- parser when the upstream layout shifts.
  raw                 JSONB,

  -- Provenance: the URL we fetched (or 'csv' / 'manual') to produce
  -- this row.
  ingested_from       TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per (creator, network, external id) when external id is
-- known. The partial unique index lets manual/CSV rows (with NULL
-- external_id) coexist freely.
CREATE UNIQUE INDEX IF NOT EXISTS creator_products_natural_key
  ON public.creator_products (creator_id, source_network, source_external_id)
  WHERE source_external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS creator_products_creator_idx
  ON public.creator_products (creator_id);

CREATE INDEX IF NOT EXISTS creator_products_creator_network_idx
  ON public.creator_products (creator_id, source_network);

CREATE INDEX IF NOT EXISTS creator_products_created_at_idx
  ON public.creator_products (creator_id, created_at DESC);

-- Touch updated_at on row mutation so the PHASE 2 grid can show
-- "updated" timestamps without an app-layer write.
CREATE OR REPLACE FUNCTION creator_products_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS creator_products_touch_updated_at_trg ON public.creator_products;
CREATE TRIGGER creator_products_touch_updated_at_trg
  BEFORE UPDATE ON public.creator_products
  FOR EACH ROW EXECUTE FUNCTION creator_products_touch_updated_at();
