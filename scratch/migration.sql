ALTER TABLE public.creator_products
  ADD COLUMN IF NOT EXISTS mai_note text,
  ADD COLUMN IF NOT EXISTS compare_at_price numeric,
  ADD COLUMN IF NOT EXISTS on_sale boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sale_started_at timestamptz;

CREATE INDEX IF NOT EXISTS creator_products_on_sale_idx
  ON public.creator_products (creator_id, sale_started_at DESC)
  WHERE on_sale = true;

CREATE TABLE IF NOT EXISTS public.price_snapshots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id   uuid NOT NULL REFERENCES public.creator_products(id) ON DELETE CASCADE,
  price        numeric NOT NULL,
  captured_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS price_snapshots_product_captured_idx
  ON public.price_snapshots (product_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS public.product_watches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES public.users(id) ON DELETE CASCADE,
  email       text,
  product_id  uuid NOT NULL REFERENCES public.creator_products(id) ON DELETE CASCADE,
  token       uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR email IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS product_watches_uniq_idx
  ON public.product_watches (product_id, COALESCE(user_id::text, email));

CREATE INDEX IF NOT EXISTS product_watches_user_idx
  ON public.product_watches (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS product_watches_email_idx
  ON public.product_watches (email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS product_watches_token_idx
  ON public.product_watches (token);

CREATE TABLE IF NOT EXISTS public.sale_alerts_sent (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  watch_id   uuid NOT NULL REFERENCES public.product_watches(id) ON DELETE CASCADE,
  old_price  numeric,
  new_price  numeric,
  sent_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sale_alerts_sent_watch_idx
  ON public.sale_alerts_sent (watch_id, sent_at DESC);

CREATE TABLE IF NOT EXISTS public.looks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text UNIQUE NOT NULL,
  creator_slug text NOT NULL,
  title        text,
  items        jsonb NOT NULL,
  total        numeric,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS looks_creator_created_idx
  ON public.looks (creator_slug, created_at DESC);

ALTER TABLE public.product_watches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.price_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sale_alerts_sent ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.looks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_watches_owner_select ON public.product_watches;
CREATE POLICY product_watches_owner_select
  ON public.product_watches FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS product_watches_owner_insert ON public.product_watches;
CREATE POLICY product_watches_owner_insert
  ON public.product_watches FOR INSERT
  WITH CHECK (auth.uid() = user_id OR user_id IS NULL);

DROP POLICY IF EXISTS product_watches_owner_delete ON public.product_watches;
CREATE POLICY product_watches_owner_delete
  ON public.product_watches FOR DELETE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS looks_public_read ON public.looks;
CREATE POLICY looks_public_read
  ON public.looks FOR SELECT
  USING (true);
