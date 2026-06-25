-- 002: anonymous metered free tier + magic-link auth + subscription state.
--
-- Two new tables:
--   users           — account + Stripe subscription state. One row per
--                     verified email, created on first magic-link login.
--   usage_counters  — per-device free-use tally. Keyed by device_id from
--                     a server-set httpOnly cookie; falls back to a
--                     fingerprint hash so clearing the cookie alone
--                     doesn't reset the quota. user_id links to users
--                     on signup so the count carries forward across
--                     devices.
--
-- Two SECURITY DEFINER functions:
--   check_and_increment_usage   — single atomic round-trip: enforces
--                                 the FREE_LIMIT cap and increments
--                                 only when allowed. Sums across
--                                 devices for logged-in users.
--   attach_counter_to_user      — links the current device's counter
--                                 to a user_id at signup time.
--
-- Reverse: DROP TABLE usage_counters; DROP TABLE users; DROP the two
-- functions. Idempotent CREATE IF NOT EXISTS throughout.

----------------------------------------------------------------------
-- users
----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                    TEXT UNIQUE NOT NULL,
  subscription_status      TEXT NOT NULL DEFAULT 'none',
  plan                     TEXT,
  stripe_customer_id       TEXT,
  stripe_subscription_id   TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT users_subscription_status_chk
    CHECK (subscription_status IN ('none', 'active', 'canceled')),
  CONSTRAINT users_plan_chk
    CHECK (plan IS NULL OR plan IN ('monthly', 'annual'))
);

CREATE INDEX IF NOT EXISTS users_stripe_customer_id_idx
  ON users (stripe_customer_id);

----------------------------------------------------------------------
-- usage_counters
----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_counters (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id         TEXT NOT NULL UNIQUE,
  fingerprint       TEXT,
  user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
  free_uses_count   INT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS usage_counters_device_id_idx
  ON usage_counters (device_id);
CREATE INDEX IF NOT EXISTS usage_counters_fingerprint_idx
  ON usage_counters (fingerprint);
CREATE INDEX IF NOT EXISTS usage_counters_user_id_idx
  ON usage_counters (user_id);

----------------------------------------------------------------------
-- check_and_increment_usage(device_id, fingerprint, user_id, limit, skip)
--
-- The gate's only Postgres touchpoint per chat request. In a single
-- transaction:
--   1. UPSERTs a row for this device_id (so first-time visitors get a
--      row at count=0).
--   2. Reads the current total (sum across user's devices if logged in,
--      this device only if anonymous).
--   3. If total >= limit, returns allowed=false, used=total.
--   4. Otherwise increments THIS device's row by 1, returns
--      allowed=true, used=newTotal.
-- skip_increment=true is the subscribed-user fast path: returns
-- allowed=true without touching the counter.
----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_and_increment_usage(
  p_device_id    TEXT,
  p_fingerprint  TEXT,
  p_user_id      UUID,
  p_limit        INT,
  p_skip         BOOL DEFAULT FALSE
) RETURNS TABLE (allowed BOOL, used INT) AS $$
DECLARE
  total_count INT;
BEGIN
  IF p_skip THEN
    RETURN QUERY SELECT TRUE, 0;
    RETURN;
  END IF;

  INSERT INTO usage_counters (device_id, fingerprint, user_id, free_uses_count)
    VALUES (p_device_id, p_fingerprint, p_user_id, 0)
    ON CONFLICT (device_id) DO NOTHING;

  IF p_user_id IS NOT NULL THEN
    SELECT COALESCE(SUM(free_uses_count), 0) INTO total_count
      FROM usage_counters WHERE user_id = p_user_id;
  ELSE
    SELECT free_uses_count INTO total_count
      FROM usage_counters WHERE device_id = p_device_id;
  END IF;

  IF total_count >= p_limit THEN
    RETURN QUERY SELECT FALSE, total_count;
    RETURN;
  END IF;

  UPDATE usage_counters
    SET free_uses_count = free_uses_count + 1,
        updated_at = now(),
        fingerprint = COALESCE(fingerprint, p_fingerprint),
        user_id = COALESCE(user_id, p_user_id)
    WHERE device_id = p_device_id;

  IF p_user_id IS NOT NULL THEN
    SELECT COALESCE(SUM(free_uses_count), 0) INTO total_count
      FROM usage_counters WHERE user_id = p_user_id;
  ELSE
    SELECT free_uses_count INTO total_count
      FROM usage_counters WHERE device_id = p_device_id;
  END IF;

  RETURN QUERY SELECT TRUE, total_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

----------------------------------------------------------------------
-- find_counter_by_fingerprint(fingerprint)
-- Cookie-recovery path: returns the most-recently-used counter row
-- whose fingerprint matches, or NULL. Used when the cookie is missing
-- so a returning visitor doesn't get a fresh quota by clearing it.
----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION find_counter_by_fingerprint(
  p_fingerprint TEXT
) RETURNS usage_counters AS $$
  SELECT *
    FROM usage_counters
    WHERE fingerprint = p_fingerprint AND p_fingerprint IS NOT NULL
    ORDER BY updated_at DESC
    LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER;

----------------------------------------------------------------------
-- attach_counter_to_user(device_id, user_id)
-- Called from /api/auth/callback after successful magic-link verify.
-- Stamps the device's counter row with user_id (COALESCE so we never
-- clobber a pre-existing link to a different account).
----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION attach_counter_to_user(
  p_device_id TEXT,
  p_user_id   UUID
) RETURNS usage_counters AS $$
DECLARE
  rec usage_counters;
BEGIN
  UPDATE usage_counters
    SET user_id = COALESCE(user_id, p_user_id),
        updated_at = now()
    WHERE device_id = p_device_id
    RETURNING * INTO rec;
  RETURN rec;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
