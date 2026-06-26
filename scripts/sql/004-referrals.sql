-- =====================================================================
-- 004-referrals.sql
--
-- Two-tier referral program. Applied manually via the Supabase SQL
-- editor. Safe to re-run: every column / constraint / index / function
-- is guarded with IF NOT EXISTS or CREATE OR REPLACE.
--
-- Tier 1: when a referred user signs up via ?ref=CODE, the inviter
--   gets +2 bonus_questions (account-level free credits that follow
--   the user across devices).
--
-- Tier 2: when a referred user's subscription_status flips to 'active'
--   (in /api/webhooks/stripe), the inviter's successful_referrals
--   counter increments by 1. When it hits 3 AND the inviter has an
--   active subscription, the webhook applies the referral_50_off_3mo
--   Stripe coupon to their sub and latches referral_reward_applied.
--   If the inviter isn't subscribed at that moment, the coupon is
--   parked — the webhook re-checks at the end of every checkout.
--   session.completed event so the reward fires on the inviter's
--   first paid checkout instead.
-- =====================================================================


-- ---------------------------------------------------------------------
-- gen_referral_code(): 7-char code from a confusion-free alphabet
-- (Crockford base32 minus 0/O, 1/I/L, U → 30 chars). 30^7 ≈ 22B
-- combinations; collisions are vanishingly rare for our scale, and the
-- UNIQUE constraint plus caller-side retry handle the rest.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION gen_referral_code()
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  alphabet CONSTANT TEXT := '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  result TEXT := '';
  i INTEGER;
BEGIN
  FOR i IN 1..7 LOOP
    result := result || substr(
      alphabet,
      1 + floor(random() * length(alphabet))::int,
      1
    );
  END LOOP;
  RETURN result;
END $$;


-- ---------------------------------------------------------------------
-- Columns on users. All nullable / defaulted so the ALTER never blocks
-- on existing rows.
-- ---------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS referral_code TEXT,
  ADD COLUMN IF NOT EXISTS referred_by TEXT,
  ADD COLUMN IF NOT EXISTS bonus_questions INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS successful_referrals INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS referral_reward_applied BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS referral_credited_at TIMESTAMPTZ;


-- ---------------------------------------------------------------------
-- Partial unique index — used by the backfill loop's EXCEPTION
-- WHEN unique_violation block to catch collisions during code
-- generation. Dropped a few steps below in favor of a full UNIQUE
-- CONSTRAINT (needed so the referred_by foreign key has a valid
-- target).
-- ---------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_key_partial
  ON users (referral_code) WHERE referral_code IS NOT NULL;


-- ---------------------------------------------------------------------
-- Backfill referral_code on existing rows. Retry on collision.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
  candidate TEXT;
  attempts INTEGER;
BEGIN
  FOR r IN SELECT id FROM users WHERE referral_code IS NULL LOOP
    attempts := 0;
    LOOP
      candidate := gen_referral_code();
      attempts := attempts + 1;
      BEGIN
        UPDATE users SET referral_code = candidate WHERE id = r.id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        IF attempts > 10 THEN
          RAISE EXCEPTION
            'gen_referral_code: 10 collisions for user %', r.id;
        END IF;
      END;
    END LOOP;
  END LOOP;
END $$;


-- ---------------------------------------------------------------------
-- NOT NULL + DEFAULT for future inserts. Then promote the partial
-- index to a full unique constraint so the FK target is valid.
-- ---------------------------------------------------------------------
ALTER TABLE users
  ALTER COLUMN referral_code SET NOT NULL,
  ALTER COLUMN referral_code SET DEFAULT gen_referral_code();

DROP INDEX IF EXISTS users_referral_code_key_partial;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_referral_code_key'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_referral_code_key UNIQUE (referral_code);
  END IF;
END $$;


-- ---------------------------------------------------------------------
-- Foreign key + self-referral guard. The CHECK enforces no-self-ref
-- at the column level so a direct UPDATE can't cycle a user onto
-- themselves.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_referred_by_fk'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_referred_by_fk
        FOREIGN KEY (referred_by)
        REFERENCES users(referral_code)
        ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_no_self_referral'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_no_self_referral
        CHECK (referred_by IS NULL OR referred_by <> referral_code);
  END IF;
END $$;


-- =====================================================================
-- RPCs called by application code
-- =====================================================================


-- ---------------------------------------------------------------------
-- claim_referral
--
-- Called from /api/auth/callback after a new user is upserted. Wraps
-- the validate-and-credit logic so signup races (duplicate callbacks,
-- repeated clicks on the same magic link) can't double-credit the
-- inviter.
--
-- Returns true iff a credit was applied. Silent skips on:
--   - missing args / empty ref code
--   - inviter code not found (bad code)
--   - self-referral (inviter_id == new user id)
--   - referred_by already set on the new user (subsequent signins)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_referral(
  p_new_user_id UUID,
  p_ref_code TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_inviter_id UUID;
  v_rows INTEGER;
BEGIN
  IF p_new_user_id IS NULL OR p_ref_code IS NULL OR p_ref_code = '' THEN
    RETURN false;
  END IF;

  -- Validate ref code → inviter.
  SELECT id INTO v_inviter_id
    FROM users WHERE referral_code = p_ref_code;
  IF v_inviter_id IS NULL THEN
    RETURN false;
  END IF;

  IF v_inviter_id = p_new_user_id THEN
    RETURN false;  -- self-referral
  END IF;

  -- Atomic set: only succeeds if referred_by was NULL (first signup,
  -- never overwrite). Guarantees +2 fires at most once per referred
  -- user, even if the callback fires twice.
  UPDATE users
    SET referred_by = p_ref_code
    WHERE id = p_new_user_id AND referred_by IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN false;
  END IF;

  -- Bump inviter's bonus pool. Atomic increment in case the inviter is
  -- mid-checkout / mid-anything else.
  UPDATE users
    SET bonus_questions = bonus_questions + 2
    WHERE id = v_inviter_id;
  RETURN true;
END $$;


-- ---------------------------------------------------------------------
-- credit_referral_subscription
--
-- Called from the Stripe webhook after a referred user's
-- subscription_status flips to 'active'. Atomically:
--   1. Claims referral_credited_at on the referred user. If two
--      webhook deliveries race on the same event, only one wins.
--   2. Increments inviter's successful_referrals by 1.
--   3. Returns inviter context so the webhook handler can decide
--      whether to apply (or park) the Tier 2 coupon.
--
-- Returns an empty / { credited=false } row on the no-op cases:
--   - missing arg
--   - referred user has no referred_by
--   - already credited (referral_credited_at not null)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION credit_referral_subscription(
  p_referred_user_id UUID
) RETURNS TABLE(
  credited BOOLEAN,
  inviter_id UUID,
  inviter_successful_referrals INTEGER,
  inviter_referral_reward_applied BOOLEAN,
  inviter_subscription_status TEXT,
  inviter_stripe_subscription_id TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_referred_by TEXT;
BEGIN
  IF p_referred_user_id IS NULL THEN
    RETURN QUERY SELECT
      false,
      NULL::UUID,
      NULL::INTEGER,
      NULL::BOOLEAN,
      NULL::TEXT,
      NULL::TEXT;
    RETURN;
  END IF;

  -- Atomic claim. Reads referred_by in the same UPDATE so a NULL
  -- referred_by or already-credited row is filtered server-side.
  UPDATE users
    SET referral_credited_at = NOW()
    WHERE id = p_referred_user_id
      AND referral_credited_at IS NULL
      AND referred_by IS NOT NULL
    RETURNING referred_by INTO v_referred_by;

  IF v_referred_by IS NULL THEN
    RETURN QUERY SELECT
      false,
      NULL::UUID,
      NULL::INTEGER,
      NULL::BOOLEAN,
      NULL::TEXT,
      NULL::TEXT;
    RETURN;
  END IF;

  -- Atomic increment, returning the inviter's full Tier-2 context.
  RETURN QUERY
    UPDATE users
      SET successful_referrals = successful_referrals + 1
      WHERE referral_code = v_referred_by
      RETURNING
        true,
        id,
        successful_referrals,
        referral_reward_applied,
        subscription_status,
        stripe_subscription_id;
END $$;


-- ---------------------------------------------------------------------
-- consume_bonus_question
--
-- Called from /api/chat/route.ts when check_and_increment_usage
-- returns allowed=false AND a session userId is present. Atomic
-- decrement of bonus_questions; returns true iff the decrement
-- happened (bonus_questions > 0 before the call).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION consume_bonus_question(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_rows INTEGER;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;
  UPDATE users
    SET bonus_questions = bonus_questions - 1
    WHERE id = p_user_id AND bonus_questions > 0;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END $$;


-- ---------------------------------------------------------------------
-- mark_referral_reward_applied
--
-- Called from the Stripe webhook AFTER the coupon attach to the
-- inviter's subscription succeeds. Atomic latch — guarantees the
-- reward fires exactly once even on webhook re-delivery. Returns
-- true iff this call was the one that flipped the latch (so the
-- caller can act idempotently).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mark_referral_reward_applied(p_inviter_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_rows INTEGER;
BEGIN
  IF p_inviter_id IS NULL THEN
    RETURN false;
  END IF;
  UPDATE users
    SET referral_reward_applied = true
    WHERE id = p_inviter_id AND referral_reward_applied = false;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END $$;
