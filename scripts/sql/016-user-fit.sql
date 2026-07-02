-- 016: user fit profile.
--
-- Optional per-user fit inputs used by the size recommendation
-- engine (P1c). Every field is nullable so a follower can save a
-- partial profile (e.g. just height) and still get tier-2 recs; the
-- engine degrades honestly.
--
-- Hard privacy: these columns are used server-side for recs only.
-- No API returns them publicly, no share card renders them, no
-- fitting-rooms feed exposes them. See profile-fit routes for the
-- policy layer.
--
-- Reverse:
--   ALTER TABLE public.users DROP COLUMN fit_height_cm, ...;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS fit_height_cm INT,
  ADD COLUMN IF NOT EXISTS fit_weight_kg NUMERIC(5, 2),
  ADD COLUMN IF NOT EXISTS fit_usual_top TEXT,
  ADD COLUMN IF NOT EXISTS fit_usual_bottom TEXT,
  ADD COLUMN IF NOT EXISTS fit_usual_dress TEXT,
  ADD COLUMN IF NOT EXISTS fit_anchor_brand TEXT,
  ADD COLUMN IF NOT EXISTS fit_preference TEXT,
  ADD COLUMN IF NOT EXISTS fit_profile_prompted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fit_profile_updated_at TIMESTAMPTZ;

-- fit_preference is a small enum of taste labels. NULL = no preference.
ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_fit_preference_chk;
ALTER TABLE public.users
  ADD CONSTRAINT users_fit_preference_chk
    CHECK (fit_preference IS NULL OR fit_preference IN ('fitted', 'true', 'relaxed'));

-- Sanity bounds. Heights outside 120..220 cm and weights outside 30..250 kg
-- are almost certainly typos, so refuse them at the DB level.
ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_fit_height_chk;
ALTER TABLE public.users
  ADD CONSTRAINT users_fit_height_chk
    CHECK (fit_height_cm IS NULL OR fit_height_cm BETWEEN 120 AND 220);

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_fit_weight_chk;
ALTER TABLE public.users
  ADD CONSTRAINT users_fit_weight_chk
    CHECK (fit_weight_kg IS NULL OR fit_weight_kg BETWEEN 30 AND 250);
