-- 011: Per-creator edit token for self-serve voice/taste editing.
--
-- A creator's onboarding completion email contains a URL of the form
-- /creator-edit/<edit_token>. That URL is the ONLY thing the creator
-- needs to view + tune the AI-generated voice_prompt + taste_profile.
-- The token is the credential; no login required (concept-test stage,
-- same trade-off as the Try-On localStorage room).
--
-- Token shape: UUID. ~128 bits of entropy is plenty to make guessing
-- impractical without rate-limiting. The token is opaque (no
-- structure encodes the slug or anything else) so leaking one row's
-- token doesn't help an attacker probe siblings.
--
-- The column is column-tolerant: every read path falls back to "no
-- edit_token" if it's missing (matches the existing pattern for the
-- `hidden` column in [slug]/page.tsx).
--
-- Reverse: DROP INDEX creators_edit_token_idx;
--          ALTER TABLE creators DROP COLUMN edit_token;

ALTER TABLE public.creators
  ADD COLUMN IF NOT EXISTS edit_token UUID NOT NULL DEFAULT gen_random_uuid();

-- Lookup index for the edit route: GET /creator-edit/<token> reads
-- exactly one row by token, no other filter. Unique because two
-- creators sharing a token would let either of them edit the other.
CREATE UNIQUE INDEX IF NOT EXISTS creators_edit_token_idx
  ON public.creators (edit_token);
