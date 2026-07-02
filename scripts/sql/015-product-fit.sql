-- 015: product-level fit data.
--
-- Separate from creator_products because coverage is patchy and we
-- want a clean NULL for "no data" without spreading nullable fit
-- fields across the main product row. Model reference, retailer fit
-- note + parsed direction, review-based consensus, and per-brand size
-- chart all land here.
--
-- Rows are populated by the per-network scrapers hitting each PDP in
-- a second-stage pass; the collection page (Rooms A parsers) doesn't
-- have any of this. Nothing in the app fails if the row is missing,
-- so backfill can proceed at any pace.
--
-- Reverse:
--   DROP TABLE public.product_fit;

CREATE TABLE IF NOT EXISTS public.product_fit (
  product_id       UUID PRIMARY KEY
    REFERENCES creator_products(id) ON DELETE CASCADE,

  -- Model reference. "Model is 5'9\" wearing size S" reduces to these
  -- three fields; NULL when the PDP doesn't state them.
  model_height_cm  INT,
  model_size       TEXT,
  model_size_scale TEXT,  -- 'us' | 'eu' | 'letter' | NULL

  -- Retailer fit prose (verbatim from the PDP) plus a normalized
  -- direction parsed from prose + consensus. The engine reads
  -- `fit_run` for the mechanical rec; `fit_note` is only surfaced
  -- as-is when a follower asks Mai directly.
  fit_note         TEXT,
  fit_run          TEXT CHECK (fit_run IN ('small', 'true', 'large')),

  -- Aggregated true-to-size consensus from reviews. Shape:
  --   { "true": 78, "small": 15, "large": 7, "count": 132 }
  -- All ints, all optional. Revolve + FWRD expose this today,
  -- Shopbop does not; Shopbop rows land with NULL here.
  fit_consensus    JSONB,

  -- Per-brand size chart. Shape:
  --   { "us": { "S": { "bust_cm": 89, "waist_cm": 73, "hip_cm": 97 }, ... } }
  -- Left as JSONB so a chart change (new scale, extended sizing)
  -- ships without a migration. Absent when the PDP doesn't expose
  -- one or the brand uses a system we don't yet parse.
  size_chart       JSONB,

  -- Provenance so we can tell later where a field came from without
  -- re-scraping. source_network mirrors creator_products.source_network
  -- for lookup convenience but is NOT enforced -- one product could in
  -- principle live under multiple ingestion sources.
  source_network   TEXT,
  scraped_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_fit_scraped_idx
  ON public.product_fit (scraped_at DESC);

-- Touch updated_at on any modification so downstream can cache
-- fit-rec rationales safely.
CREATE OR REPLACE FUNCTION public.product_fit_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS product_fit_touch_trg ON public.product_fit;
CREATE TRIGGER product_fit_touch_trg
  BEFORE UPDATE ON public.product_fit
  FOR EACH ROW EXECUTE FUNCTION public.product_fit_touch_updated_at();

-- Optional creator-provided size anchor. Reserved slot on the creators
-- table so a later feature can prompt a creator to declare "I usually
-- wear a small in Aritzia" without a migration. Nothing in the fit
-- engine depends on this yet; it exists so P1c can layer it in later
-- without a schema shuffle. Idempotent add.
ALTER TABLE public.creators
  ADD COLUMN IF NOT EXISTS size_anchor JSONB;
