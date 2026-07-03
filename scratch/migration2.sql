ALTER TABLE public.creator_products
  ADD COLUMN IF NOT EXISTS attributes jsonb NOT NULL DEFAULT '{"category":null,"colors":[],"materials":[],"styles":[]}'::jsonb,
  ADD COLUMN IF NOT EXISTS enriched_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS search_text tsvector;

CREATE OR REPLACE FUNCTION public.creator_products_search_text_trg()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cat text;
  colors text;
  materials text;
  styles text;
BEGIN
  cat := COALESCE(NEW.attributes ->> 'category', '');
  colors := array_to_string(
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(NEW.attributes -> 'colors', '[]'::jsonb))),
    ' '
  );
  materials := array_to_string(
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(NEW.attributes -> 'materials', '[]'::jsonb))),
    ' '
  );
  styles := array_to_string(
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(NEW.attributes -> 'styles', '[]'::jsonb))),
    ' '
  );
  NEW.search_text := to_tsvector(
    'simple',
    lower(
      COALESCE(NEW.product_title, '') || ' ' ||
      COALESCE(NEW.brand, '') || ' ' ||
      cat || ' ' ||
      colors || ' ' ||
      materials || ' ' ||
      styles
    )
  );
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS creator_products_search_text_before ON public.creator_products;
CREATE TRIGGER creator_products_search_text_before
  BEFORE INSERT OR UPDATE OF product_title, brand, attributes ON public.creator_products
  FOR EACH ROW EXECUTE FUNCTION public.creator_products_search_text_trg();

CREATE INDEX IF NOT EXISTS creator_products_search_text_idx
  ON public.creator_products USING GIN (search_text);

CREATE INDEX IF NOT EXISTS creator_products_attributes_idx
  ON public.creator_products USING GIN (attributes jsonb_path_ops);

CREATE INDEX IF NOT EXISTS creator_products_enriched_version_idx
  ON public.creator_products (enriched_version)
  WHERE enriched_version < 1;

UPDATE public.creator_products
SET attributes = attributes
WHERE search_text IS NULL;
