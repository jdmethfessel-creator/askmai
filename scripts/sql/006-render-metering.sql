-- =====================================================================
-- 006-render-metering.sql
--
-- Try-on render metering (PHASE 2).
--
-- Apply manually via the Supabase SQL editor. Safe to re-run: every
-- column add, RPC, and bucket insert is guarded with IF NOT EXISTS or
-- ON CONFLICT DO NOTHING / CREATE OR REPLACE.
--
-- Three additive columns on public.users:
--
--   included_renders_used      integer, default 0. Count of monthly
--                              renders consumed in the current billing
--                              window. Subject to consume_render's
--                              window-reset check below.
--
--   included_renders_reset_at  timestamptz, NULL on first read. The
--                              first-of-month boundary at which
--                              included_renders_used resets to 0. The
--                              consume RPC lazily rolls this forward
--                              and zeros the counter when NOW() crosses
--                              it. Stamped UTC so the reset is the same
--                              wall-clock instant regardless of where
--                              the user is.
--
--   pack_render_balance        integer, default 0. Non-expiring pool
--                              credited by the Stripe webhook on a
--                              successful pack purchase
--                              (checkout.session.completed in pack
--                              mode). Consumed strictly after the
--                              included pool is exhausted.
--
-- Plus a renders log table for traceability of every successful render
-- (cost basis ~$0.167 per gpt-image-1 call; we want a queryable trail
-- of who/when/what for spend reconciliation) and a private bucket for
-- the rendered images themselves (signed URLs only, never public).
--
-- The consume_render RPC is the atomic source of truth for the rule
-- "included first, then pack, then deny." It is called server-side
-- ONLY after the upstream gpt-image-1 call returns a usable image, so
-- a failed render costs nothing.
-- =====================================================================

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS included_renders_used      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS included_renders_reset_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pack_render_balance        INTEGER NOT NULL DEFAULT 0;

-- Log table. One row per SUCCESSFUL render. The kind column
-- distinguishes the two button paths so we can reconcile spend per
-- feature, and the source column records whether the credit was drawn
-- from the included pool or a purchased pack. cost_usd is the per-call
-- estimate at time of render so a future provider price change does
-- not silently rewrite historical spend.
CREATE TABLE IF NOT EXISTS public.renders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  creator_slug TEXT,
  kind         TEXT NOT NULL,
  item_count   INTEGER NOT NULL DEFAULT 1,
  source       TEXT NOT NULL,
  cost_usd     NUMERIC(10, 5) NOT NULL DEFAULT 0.167,
  image_path   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT renders_kind_chk   CHECK (kind   IN ('single', 'outfit')),
  CONSTRAINT renders_source_chk CHECK (source IN ('included', 'pack'))
);

CREATE INDEX IF NOT EXISTS renders_user_id_idx
  ON public.renders (user_id, created_at DESC);


-- Webhook idempotency latch for render pack purchases. Stripe can
-- re-deliver checkout.session.completed events; without this latch a
-- repeated delivery would double-credit a user's pack balance. The
-- webhook inserts BEFORE calling credit_render_pack, so a duplicate
-- (23505) is the signal to skip the credit entirely.
CREATE TABLE IF NOT EXISTS public.render_pack_fulfillments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_session_id  TEXT NOT NULL UNIQUE,
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pack_id            TEXT NOT NULL,
  credit             INTEGER NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT render_pack_fulfillments_pack_chk CHECK (pack_id IN ('pack_20', 'pack_50'))
);

CREATE INDEX IF NOT EXISTS render_pack_fulfillments_user_idx
  ON public.render_pack_fulfillments (user_id, created_at DESC);

-- Private bucket for finished renders. Public=false so a leaked path
-- alone is not enough to fetch the image; the server hands out short
-- signed URLs per request.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'renders',
  'renders',
  false,
  16777216,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;


-- ---------------------------------------------------------------------
-- next_render_reset(): first-of-next-month boundary in UTC. The render
-- window rolls on UTC midnight of the 1st rather than a per-user
-- billing anniversary so the rule "resets the 1st" is exactly what the
-- product copy says.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION next_render_reset(p_now TIMESTAMPTZ)
RETURNS TIMESTAMPTZ
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT date_trunc('month', (p_now AT TIME ZONE 'UTC') + INTERVAL '1 month')
         AT TIME ZONE 'UTC'
$$;


-- ---------------------------------------------------------------------
-- get_render_quota
--
-- Read-only view of the user's current quota. Used by the client to
-- decide whether the per-card / per-response button shows the render
-- label or the "Buy Image Package" label. Lazily rolls the reset_at
-- boundary forward so a stale row reports correctly without requiring
-- a separate cron.
--
-- Returns:
--   included_remaining  INT  (3 minus used, never negative)
--   pack_balance        INT
--   total_remaining     INT  (the two summed)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_render_quota(
  p_user_id UUID,
  p_included_limit INT DEFAULT 3
) RETURNS TABLE(
  included_remaining INT,
  pack_balance       INT,
  total_remaining    INT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_used    INT;
  v_pack    INT;
  v_reset   TIMESTAMPTZ;
  v_now     TIMESTAMPTZ := NOW();
BEGIN
  SELECT included_renders_used, pack_render_balance, included_renders_reset_at
    INTO v_used, v_pack, v_reset
    FROM users WHERE id = p_user_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 0, 0, 0;
    RETURN;
  END IF;

  -- Lazy reset: stamp the boundary on first read, or roll it forward
  -- when the previous window has expired. Keeps the read accurate
  -- without scheduling a cron.
  IF v_reset IS NULL OR v_now >= v_reset THEN
    v_used := 0;
    v_reset := next_render_reset(v_now);
    UPDATE users
      SET included_renders_used = 0,
          included_renders_reset_at = v_reset
      WHERE id = p_user_id;
  END IF;

  RETURN QUERY SELECT
    GREATEST(p_included_limit - v_used, 0),
    COALESCE(v_pack, 0),
    GREATEST(p_included_limit - v_used, 0) + COALESCE(v_pack, 0);
END $$;


-- ---------------------------------------------------------------------
-- consume_render
--
-- Atomic decrement, called server-side ONLY after a successful
-- gpt-image-1 render. Consumption order:
--   1. Included pool (subject to monthly window reset).
--   2. Pack balance.
--   3. If both are zero, returns charged=false; the caller must NOT
--      have produced an image without first checking quota, but the
--      RPC is the final word: never overdraw.
--
-- Returns:
--   charged      BOOL   true iff a credit was drawn
--   source       TEXT   'included' | 'pack' | NULL
--   included_remaining INT
--   pack_balance       INT
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION consume_render(
  p_user_id UUID,
  p_included_limit INT DEFAULT 3
) RETURNS TABLE(
  charged            BOOLEAN,
  source             TEXT,
  included_remaining INT,
  pack_balance       INT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_used   INT;
  v_pack   INT;
  v_reset  TIMESTAMPTZ;
  v_now    TIMESTAMPTZ := NOW();
BEGIN
  IF p_user_id IS NULL THEN
    RETURN QUERY SELECT false, NULL::TEXT, 0, 0;
    RETURN;
  END IF;

  SELECT included_renders_used, pack_render_balance, included_renders_reset_at
    INTO v_used, v_pack, v_reset
    FROM users WHERE id = p_user_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::TEXT, 0, 0;
    RETURN;
  END IF;

  -- Lazy window roll inside the same row lock the consume operation
  -- holds, so a reset and a consume can never race.
  IF v_reset IS NULL OR v_now >= v_reset THEN
    v_used := 0;
    v_reset := next_render_reset(v_now);
    UPDATE users
      SET included_renders_used = 0,
          included_renders_reset_at = v_reset
      WHERE id = p_user_id;
  END IF;

  IF v_used < p_included_limit THEN
    UPDATE users
      SET included_renders_used = included_renders_used + 1
      WHERE id = p_user_id;
    RETURN QUERY SELECT
      true,
      'included'::TEXT,
      GREATEST(p_included_limit - (v_used + 1), 0),
      COALESCE(v_pack, 0);
    RETURN;
  END IF;

  IF COALESCE(v_pack, 0) > 0 THEN
    UPDATE users
      SET pack_render_balance = pack_render_balance - 1
      WHERE id = p_user_id;
    RETURN QUERY SELECT
      true,
      'pack'::TEXT,
      0,
      COALESCE(v_pack, 0) - 1;
    RETURN;
  END IF;

  RETURN QUERY SELECT false, NULL::TEXT, 0, COALESCE(v_pack, 0);
END $$;


-- ---------------------------------------------------------------------
-- credit_render_pack
--
-- Called from the Stripe webhook on a successful pack purchase. Adds
-- the pack size to pack_render_balance atomically. Returns the new
-- balance so the webhook can log the credit.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION credit_render_pack(
  p_user_id UUID,
  p_amount  INT
) RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_new INT;
BEGIN
  IF p_user_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN 0;
  END IF;
  UPDATE users
    SET pack_render_balance = pack_render_balance + p_amount
    WHERE id = p_user_id
    RETURNING pack_render_balance INTO v_new;
  RETURN COALESCE(v_new, 0);
END $$;
