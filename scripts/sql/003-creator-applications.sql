-- 003: lead-capture for prospective creators applying via /creator-signup.
--
-- This is NOT a self-serve onboarding table. Approved creators still get
-- their twin set up manually by the founder (consent + quality control),
-- so this table just collects the interest signal. No FK to creators —
-- the application is detached and only the founder decides whether to
-- promote a row into an actual creators entry.
--
-- Reverse: DROP TABLE creator_applications; DROP the index.

CREATE TABLE IF NOT EXISTS creator_applications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  shopmy_url    TEXT,
  ltk_url       TEXT,
  ig_handle     TEXT,
  tiktok_handle TEXT,
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'new',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT creator_applications_status_chk
    CHECK (status IN ('new', 'reviewing', 'approved', 'declined'))
);

CREATE INDEX IF NOT EXISTS creator_applications_created_at_idx
  ON creator_applications (created_at DESC);

CREATE INDEX IF NOT EXISTS creator_applications_status_idx
  ON creator_applications (status);
